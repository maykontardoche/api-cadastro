import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { TransactionRunner } from '../../../src/db/transaction.js';
import { AppError } from '../../../src/http/errors.js';
import { createSessionRepository } from '../../../src/modules/auth/session.repository.js';
import { createSessionService } from '../../../src/modules/auth/session.service.js';
import { createTokenService } from '../../../src/modules/auth/token.service.js';
import {
  createUserRepository,
  type UserRepository,
} from '../../../src/modules/users/user.repository.js';
import { createUserService } from '../../../src/modules/users/user.service.js';
import { TEST_TOKEN_CONFIG } from '../../helpers/api.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';

/**
 * "There is always at least one active admin" under forced interleavings. A decorated repository
 * parks the first operation right after it counted the admins (still holding the admin-set lock)
 * until PostgreSQL shows the competing operation blocked on a lock.
 */
const prisma = createTestPrisma();
const transaction: TransactionRunner = (work) => prisma.$transaction(work);

function setup() {
  let armed: { reached: () => void; released: Promise<void> } | undefined;
  const wrap = (repository: UserRepository): UserRepository => ({
    ...repository,
    countActiveAdmins: async () => {
      const count = await repository.countActiveAdmins();
      const gate = armed;
      if (gate) {
        armed = undefined;
        gate.reached();
        await gate.released;
      }
      return count;
    },
    bindTo: (tx) => wrap(repository.bindTo(tx)),
  });
  const sessions = createSessionService({
    sessions: createSessionRepository(prisma),
    tokens: createTokenService(TEST_TOKEN_CONFIG),
    refreshTtlDays: 30,
  });
  const service = createUserService({
    users: wrap(createUserRepository(prisma)),
    hashPassword: () => Promise.reject(new Error('not used')),
    revokeAllSessions: (userId, tx) => sessions.revokeAllForUser(userId, tx),
    transaction,
  });
  return {
    service,
    sessions,
    arm: () => {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      armed = { reached, released: new Promise<void>((resolve) => (release = resolve)) };
      return { reached: reachedPromise, release };
    },
  };
}

async function untilSomeoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the competing operation never blocked on a lock');
}

async function createAdmins(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = await prisma.user.create({
      data: {
        name: `Admin ${String(i)}`,
        email: `admin${String(i)}@example.com`,
        passwordHash: 'x',
        role: 'ADMIN',
      },
    });
    ids.push(user.id);
  }
  return ids;
}

const activeAdmins = () => prisma.user.count({ where: { role: 'ADMIN', deletedAt: null } });

/** Settles both and returns the outcome of each: 'ok' or the AppError code. */
async function outcomes(...operations: Promise<unknown>[]): Promise<string[]> {
  const settled = await Promise.allSettled(operations);
  return settled.map((result) => {
    if (result.status === 'fulfilled') return 'ok';
    const reason: unknown = result.reason;
    return reason instanceof AppError ? reason.code : 'unexpected';
  });
}

describe('last active admin under forced interleavings', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('two admins stepping down at the same time: exactly one admin remains', async () => {
    const { service, arm } = setup();
    const [first = '', second = ''] = await createAdmins(2);

    const gate = arm();
    const demoteSecond = service.changeRole(second, second, 'USER'); // counts 2 admins, then waits
    await gate.reached;
    const demoteFirst = service.changeRole(first, first, 'USER');
    await untilSomeoneWaitsOnALock();
    gate.release();

    expect((await outcomes(demoteSecond, demoteFirst)).sort()).toEqual(['LAST_ADMIN', 'ok']);
    expect(await activeAdmins()).toBe(1);
  });

  it('a deletion racing a demotion: exactly one admin remains', async () => {
    const { service, arm } = setup();
    const [first = '', second = ''] = await createAdmins(2);

    const gate = arm();
    const deleteSecond = service.softDelete(first, second);
    await gate.reached;
    const demoteFirst = service.changeRole(first, first, 'USER');
    await untilSomeoneWaitsOnALock();
    gate.release();

    expect((await outcomes(deleteSecond, demoteFirst)).sort()).toEqual(['LAST_ADMIN', 'ok']);
    expect(await activeAdmins()).toBe(1);
  });

  it('two deletions of different admins: exactly one admin remains', async () => {
    const { service, arm } = setup();
    const [first = '', second = ''] = await createAdmins(2);

    const gate = arm();
    const deleteSecond = service.softDelete(first, second);
    await gate.reached;
    const deleteFirst = service.softDelete(first, first);
    await untilSomeoneWaitsOnALock();
    gate.release();

    expect((await outcomes(deleteSecond, deleteFirst)).sort()).toEqual(['LAST_ADMIN', 'ok']);
    expect(await activeAdmins()).toBe(1);
  });

  it('an admin demoted while its own request waits for the lock cannot act any more', async () => {
    const { service, arm } = setup();
    const [first = '', second = '', third = ''] = await createAdmins(3);

    // first demotes second; meanwhile second (still an admin when it authenticated) tries to
    // demote third.
    const gate = arm();
    const demoteSecond = service.changeRole(first, second, 'USER');
    await gate.reached;
    const secondActs = service.changeRole(second, third, 'USER');
    await untilSomeoneWaitsOnALock();
    gate.release();

    expect(await outcomes(demoteSecond, secondActs)).toEqual(['ok', 'FORBIDDEN']);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: third } })).role).toBe('ADMIN');
  });

  it('changing to the current role writes nothing', async () => {
    const { service } = setup();
    const [first = '', second = ''] = await createAdmins(2);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: second } });

    const result = await service.changeRole(first, second, 'ADMIN');

    expect(result.previousRole).toBe('ADMIN');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: second } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('with three admins, two concurrent demotions both succeed', async () => {
    const { service } = setup();
    const [first = '', second = '', third = ''] = await createAdmins(3);

    expect(
      await outcomes(
        service.changeRole(first, second, 'USER'),
        service.changeRole(first, third, 'USER'),
      ),
    ).toEqual(['ok', 'ok']);
    expect(await activeAdmins()).toBe(1);
  });

  it('a soft delete revokes the sessions in the same transaction as the deletion', async () => {
    const { service, sessions } = setup();
    const [actor = '', target = ''] = await createAdmins(2);
    await sessions.createForLogin(target, 'x');
    await sessions.createForLogin(target, 'x');

    expect(await service.softDelete(actor, target)).toEqual({ revokedSessions: 2 });
    expect(await prisma.refreshSession.count({ where: { userId: target, revokedAt: null } })).toBe(
      0,
    );
  });
});
