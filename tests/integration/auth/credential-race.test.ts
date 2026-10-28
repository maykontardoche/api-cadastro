import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/http/errors.js';
import { createAuthService, type PasswordHasher } from '../../../src/modules/auth/auth.service.js';
import { hashPassword, verifyPassword } from '../../../src/modules/auth/password.js';
import { createSessionRepository } from '../../../src/modules/auth/session.repository.js';
import { createSessionService } from '../../../src/modules/auth/session.service.js';
import { createTokenService } from '../../../src/modules/auth/token.service.js';
import { createUserRepository } from '../../../src/modules/users/user.repository.js';
import { TEST_TOKEN_CONFIG } from '../../helpers/api.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';

/**
 * Login checks the password, then creates a session. A password change (or an account deletion)
 * landing between those two steps must not leave a session that was authorized by the old
 * password. The login is parked right after a successful check to force that interleaving.
 */
const prisma = createTestPrisma();
const OLD_PASSWORD = 'correct horse battery staple';

function setup() {
  let parked: { reached: () => void; released: Promise<void> } | undefined;
  const passwords: PasswordHasher = {
    hash: hashPassword,
    verify: async (hash, plain) => {
      const ok = await verifyPassword(hash, plain);
      const gate = parked;
      if (ok && gate) {
        parked = undefined;
        gate.reached();
        await gate.released;
      }
      return ok;
    },
  };
  const tokens = createTokenService(TEST_TOKEN_CONFIG);
  const sessions = createSessionService({
    sessions: createSessionRepository(prisma),
    tokens,
    refreshTtlDays: 30,
  });
  const authService = createAuthService({
    users: createUserRepository(prisma),
    sessions,
    tokens,
    passwords,
    transaction: (work) => prisma.$transaction(work),
  });
  return {
    authService,
    sessions,
    parkNextSuccessfulCheck: () => {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      parked = { reached, released: new Promise<void>((resolve) => (release = resolve)) };
      return { reached: reachedPromise, release };
    },
  };
}

async function createUser(): Promise<{ id: string; email: string }> {
  return prisma.user.create({
    data: { name: 'Ana', email: 'ana@example.com', passwordHash: await hashPassword(OLD_PASSWORD) },
    select: { id: true, email: true },
  });
}

async function expectInvalidCredentials(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof AppError && error.code === 'INVALID_CREDENTIALS',
  );
}

describe('login racing a credential change', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a login checked against the old password gets no session once the password changed', async () => {
    const { authService, parkNextSuccessfulCheck } = setup();
    const user = await createUser();

    const gate = parkNextSuccessfulCheck();
    const login = authService.login({ email: user.email, password: OLD_PASSWORD });
    await gate.reached;
    // The real password change runs while the login sits between the check and the session.
    await authService.changePassword(user.id, {
      currentPassword: OLD_PASSWORD,
      newPassword: 'a brand new passphrase here',
    });
    gate.release();

    await expectInvalidCredentials(login);
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a password change that lost the race rolls back entirely, including its revocation', async () => {
    const { authService, parkNextSuccessfulCheck } = setup();
    const user = await createUser();
    const winnerPassword = 'the winning new passphrase';

    // B checks the current password, then waits; A changes it meanwhile.
    const gate = parkNextSuccessfulCheck();
    const loser = authService.changePassword(user.id, {
      currentPassword: OLD_PASSWORD,
      newPassword: 'the losing new passphrase',
    });
    await gate.reached;
    await authService.changePassword(user.id, {
      currentPassword: OLD_PASSWORD,
      newPassword: winnerPassword,
    });
    // A legitimate login with the new password, after the winning change.
    await authService.login({ email: user.email, password: winnerPassword });
    gate.release();

    await expectInvalidCredentials(loser);
    // The loser's revokeAllForUser was rolled back with it: the new session survives.
    expect(await prisma.refreshSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      1,
    );
    await expect(
      authService.login({ email: user.email, password: winnerPassword }),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('a login checked before the account was deleted gets no session', async () => {
    const { authService, parkNextSuccessfulCheck } = setup();
    const user = await createUser();

    const gate = parkNextSuccessfulCheck();
    const login = authService.login({ email: user.email, password: OLD_PASSWORD });
    await gate.reached;
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    gate.release();

    await expectInvalidCredentials(login);
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(0);
  });
});
