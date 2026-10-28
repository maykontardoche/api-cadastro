import { describe, expect, it } from 'vitest';

import type { User } from '../../../src/generated/prisma/client.js';
import { AppError } from '../../../src/http/errors.js';
import { createAuthService, type PasswordHasher } from '../../../src/modules/auth/auth.service.js';
import type { SessionService } from '../../../src/modules/auth/session.service.js';
import type { TokenService } from '../../../src/modules/auth/token.service.js';
import type { UserRepository } from '../../../src/modules/users/user.repository.js';

const DECOY_HASH = 'decoy-hash';
const now = new Date('2026-10-28T12:00:00.000Z');
const ana: User = {
  id: '0192f000-0000-7000-8000-000000000001',
  name: 'Ana',
  email: 'ana@example.com',
  passwordHash: 'ana-hash',
  role: 'USER',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

/** In-memory doubles that record which hash every verification ran against. */
function setup(
  options: {
    user?: User | null;
    correctPassword?: string;
    hashFailures?: number;
    credentialChangedMeanwhile?: boolean;
  } = {},
) {
  const verifiedAgainst: string[] = [];
  let failuresLeft = options.hashFailures ?? 0;
  const passwords: PasswordHasher = {
    hash: () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Promise.reject(new Error('hash failed'));
      }
      return Promise.resolve(DECOY_HASH);
    },
    verify: (hash, plain) => {
      verifiedAgainst.push(hash);
      return Promise.resolve(
        hash === ana.passwordHash && plain === (options.correctPassword ?? 'right'),
      );
    },
  };
  const notUsed = () => Promise.reject(new Error('not used'));
  const users: UserRepository = {
    create: notUsed,
    findByEmail: () => Promise.resolve(options.user === undefined ? ana : options.user),
    findActiveById: notUsed,
    findActiveWithCredentials: notUsed,
    updateProfile: notUsed,
    replacePasswordHash: notUsed,
    listActive: notUsed,
    lockAdminSet: notUsed,
    countActiveAdmins: notUsed,
    setRole: notUsed,
    softDelete: notUsed,
    bindTo: () => users,
  };
  const sessions: SessionService = {
    createForLogin: (_userId, verifiedPasswordHash) =>
      Promise.resolve(
        options.credentialChangedMeanwhile || verifiedPasswordHash !== ana.passwordHash
          ? null
          : { id: 'session-id', refreshToken: 'refresh-token', expiresAt: now },
      ),
    rotate: () => Promise.reject(new Error('not used')),
    revoke: () => Promise.reject(new Error('not used')),
    revokeAllForUser: () => Promise.reject(new Error('not used')),
  };
  const tokens: TokenService = {
    accessTtlSeconds: 900,
    signAccess: () => Promise.resolve('access-token'),
    verifyAccess: () => Promise.reject(new Error('not used')),
    newRefresh: () => ({ token: 't', hash: 'h' }),
  };
  return {
    service: createAuthService({ users, sessions, tokens, passwords, transaction: notUsed }),
    verifiedAgainst,
  };
}

async function expectInvalidCredentials(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof AppError && error.code === 'INVALID_CREDENTIALS',
  );
}

describe('AuthService.login', () => {
  it('verifies against the decoy hash when the email is unknown', async () => {
    const { service, verifiedAgainst } = setup({ user: null });

    await expectInvalidCredentials(service.login({ email: 'x@example.com', password: 'p' }));
    expect(verifiedAgainst).toEqual([DECOY_HASH]);
  });

  it('verifies against the decoy hash, not the real one, for a deleted account', async () => {
    const { service, verifiedAgainst } = setup({ user: { ...ana, deletedAt: now } });

    await expectInvalidCredentials(service.login({ email: ana.email, password: 'right' }));
    expect(verifiedAgainst).toEqual([DECOY_HASH]);
  });

  it('verifies against the user hash for a wrong password', async () => {
    const { service, verifiedAgainst } = setup();

    await expectInvalidCredentials(service.login({ email: ana.email, password: 'wrong' }));
    expect(verifiedAgainst).toEqual([ana.passwordHash]);
  });

  it('does not cache a failed decoy build, so unknown emails do not turn into a 500', async () => {
    // The eager build at creation fails; the first login builds it again and succeeds.
    const { service, verifiedAgainst } = setup({ user: null, hashFailures: 1 });

    await expectInvalidCredentials(service.login({ email: 'x@example.com', password: 'p' }));
    expect(verifiedAgainst).toEqual([DECOY_HASH]);
  });

  it('refuses the login when the credential changed between the check and the session', async () => {
    const { service } = setup({ credentialChangedMeanwhile: true });

    await expectInvalidCredentials(service.login({ email: ana.email, password: 'right' }));
  });

  it('returns tokens and the public user on success, with expiresIn from the token config', async () => {
    const { service } = setup();

    const result = await service.login({ email: ana.email, password: 'right' });

    expect(result).toEqual({
      accessToken: 'access-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshToken: 'refresh-token',
      user: {
        id: ana.id,
        name: ana.name,
        email: ana.email,
        role: 'USER',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
  });
});
