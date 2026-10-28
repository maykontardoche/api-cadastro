import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createSessionRepository,
  type SessionRepository,
} from '../../../src/modules/auth/session.repository.js';
import {
  createSessionService,
  type CreatedSession,
  type SessionService,
} from '../../../src/modules/auth/session.service.js';
import { createTokenService, hashRefreshToken } from '../../../src/modules/auth/token.service.js';
import { TEST_TOKEN_CONFIG } from '../../helpers/api.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';

/**
 * Deterministic interleavings of session operations. A decorated repository parks the first
 * rotation right after its compare-and-set (still inside the transaction, holding its locks) until
 * the competing operation is confirmed by PostgreSQL to be blocked on a lock. Only then is the
 * first one released, so the outcome no longer depends on scheduling luck.
 */
const prisma = createTestPrisma();

interface Gate {
  reached: Promise<void>;
  release: () => void;
}

function gatedRepository(inner: SessionRepository) {
  let armed: { reached: () => void; released: Promise<void> } | undefined;

  const wrap = (repository: SessionRepository): SessionRepository => ({
    ...repository,
    revokeIfActive: async (id) => {
      const claimed = await repository.revokeIfActive(id);
      const gate = armed;
      if (gate) {
        armed = undefined;
        gate.reached();
        await gate.released;
      }
      return claimed;
    },
    transaction: (work) => repository.transaction((tx) => work(wrap(tx))),
  });

  return {
    repository: wrap(inner),
    /** Parks the next compare-and-set, after it ran, until `release` is called. */
    arm(): Gate {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      armed = { reached, released };
      return { reached: reachedPromise, release };
    },
  };
}

/** Resolves once some other backend of the test database is waiting on a lock. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the competing operation never blocked on a lock');
}

function setup() {
  const gated = gatedRepository(createSessionRepository(prisma));
  const service = createSessionService({
    sessions: gated.repository,
    tokens: createTokenService(TEST_TOKEN_CONFIG),
    refreshTtlDays: 30,
  });
  return { service, arm: () => gated.arm() };
}

/** Users here have the placeholder hash "x"; a login session is granted against it. */
async function startSession(service: SessionService, userId: string): Promise<CreatedSession> {
  const session = await service.createForLogin(userId, 'x');
  if (!session) throw new Error('setup failed: no session');
  return session;
}

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { name: 'Ana', email: `ana-${String(Date.now())}@example.com`, passwordHash: 'x' },
  });
  return user.id;
}

const activeSessions = (where: { familyId?: string; userId?: string }) =>
  prisma.refreshSession.count({ where: { ...where, revokedAt: null } });

describe('session operations under forced interleavings', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('replaying an old token while the newest one rotates still revokes the whole family', async () => {
    const { service, arm } = setup();
    const userId = await createUser();
    const a = await startSession(service, userId);
    const b = await service.rotate(a.refreshToken);
    if (b.outcome !== 'rotated') throw new Error('setup failed');
    const { familyId } = await prisma.refreshSession.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(a.refreshToken) },
    });

    // The legitimate holder of B is mid-rotation: B claimed, C not created yet.
    const gate = arm();
    const holder = service.rotate(b.refreshToken);
    await gate.reached;
    // The attacker replays A meanwhile.
    const replay = service.rotate(a.refreshToken);
    await untilSomeoneWaitsOnALock();
    gate.release();
    const [holderResult, replayResult] = await Promise.all([holder, replay]);

    expect(replayResult.outcome).toBe('reused');
    expect(holderResult.outcome).toBe('rotated');
    // C, created by the holder concurrently with the detection, must not survive it.
    expect(await activeSessions({ familyId })).toBe(0);
    if (holderResult.outcome === 'rotated') {
      expect((await service.rotate(holderResult.refreshToken)).outcome).not.toBe('rotated');
    }
  });

  it('revoking every session of a user also catches a rotation in flight', async () => {
    const { service, arm } = setup();
    const userId = await createUser();
    const a = await startSession(service, userId);

    const gate = arm();
    const holder = service.rotate(a.refreshToken);
    await gate.reached;
    const revokeAll = service.revokeAllForUser(userId);
    await untilSomeoneWaitsOnALock();
    gate.release();
    await Promise.all([holder, revokeAll]);

    expect(await activeSessions({ userId })).toBe(0);
  });

  it('revokeAllForUser joins a caller transaction: rolled back together with it', async () => {
    const { service } = setup();
    const userId = await createUser();
    await startSession(service, userId);
    await startSession(service, userId);

    await expect(
      prisma.$transaction(async (tx) => {
        expect(await service.revokeAllForUser(userId, tx)).toBe(2);
        throw new Error('the outer operation failed');
      }),
    ).rejects.toThrow('the outer operation failed');

    expect(await activeSessions({ userId })).toBe(2);
    expect(await service.revokeAllForUser(userId)).toBe(2);
    expect(await activeSessions({ userId })).toBe(0);
  });

  it('a writer that skips the user lock (logout) revoking mid-rotation makes the claim fail closed', async () => {
    const { service } = setup();
    const userId = await createUser();
    const a = await startSession(service, userId);
    const tokenHash = hashRefreshToken(a.refreshToken);

    // A logout-like write holds the session row, uncommitted, while the rotation starts.
    let commitLogout!: () => void;
    const logoutMayCommit = new Promise<void>((resolve) => (commitLogout = resolve));
    let logoutHoldsRow!: () => void;
    const rowHeld = new Promise<void>((resolve) => (logoutHoldsRow = resolve));
    const logout = prisma.$transaction(async (tx) => {
      await tx.refreshSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      logoutHoldsRow();
      await logoutMayCommit;
    });
    await rowHeld;

    // The rotation reads the row as still active, then its claim blocks on the logout's row lock.
    const rotation = service.rotate(a.refreshToken);
    await untilSomeoneWaitsOnALock();
    commitLogout();
    const [result] = await Promise.all([rotation, logout]);

    expect(result).toMatchObject({ outcome: 'reused', afterRotation: false });
    expect(await activeSessions({ userId })).toBe(0);
  });

  it('two rotations of the same token: one wins, the other is reuse, nothing stays active', async () => {
    const { service, arm } = setup();
    const userId = await createUser();
    const a = await startSession(service, userId);

    const gate = arm();
    const first = service.rotate(a.refreshToken);
    await gate.reached;
    const second = service.rotate(a.refreshToken);
    await untilSomeoneWaitsOnALock();
    gate.release();
    const outcomes = (await Promise.all([first, second])).map((r) => r.outcome).sort();

    expect(outcomes).toEqual(['reused', 'rotated']);
    expect(await activeSessions({ userId })).toBe(0);
  });
});
