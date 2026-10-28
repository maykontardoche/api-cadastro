import { randomBytes } from 'node:crypto';

import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../http/errors.js';
import type { UserRepository } from '../users/user.repository.js';
import { toPublicUser, type PublicUser } from '../users/user.schema.js';
import type { RotationResult, SessionService } from './session.service.js';
import type { TokenService } from './token.service.js';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  user: PublicUser;
}

export type RefreshResult =
  | { outcome: 'rotated'; session: LoginResult }
  | Extract<RotationResult, { outcome: 'reused' }>
  | { outcome: 'invalid' };

export interface AuthService {
  /** Any failure — unknown email, deleted account, wrong password — is the same 401. */
  login: (input: LoginInput) => Promise<LoginResult>;
  /** The caller turns every outcome but `rotated` into the same 401 (and logs `reused`). */
  refresh: (refreshToken: string) => Promise<RefreshResult>;
  logout: (refreshToken: string) => Promise<void>;
  /**
   * Requires the current password (401 `INVALID_CREDENTIALS` otherwise), then replaces the hash
   * and ends every refresh session of the user in one transaction. Access tokens already issued
   * stay valid until they expire.
   */
  changePassword: (
    userId: string,
    input: ChangePasswordInput,
  ) => Promise<{ revokedSessions: number }>;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** Runs `work` in one database transaction. */
export type TransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

export interface PasswordHasher {
  hash: (plain: string) => Promise<string>;
  verify: (hash: string, plain: string) => Promise<boolean>;
}

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionService;
  tokens: TokenService;
  passwords: PasswordHasher;
  transaction: TransactionRunner;
}

export function createAuthService({
  users,
  sessions,
  tokens,
  passwords,
  transaction,
}: AuthServiceDeps): AuthService {
  // Verified against when the account does not exist, so every failed login costs one Argon2id
  // verification and response time does not reveal whether the email is registered. Built ahead
  // of the first login; a failed build is discarded rather than cached, so it cannot turn unknown
  // emails into a distinguishable 500 forever.
  let decoyHash: Promise<string> | undefined;
  const decoy = (): Promise<string> =>
    (decoyHash ??= passwords.hash(randomBytes(32).toString('base64url')).catch((error: unknown) => {
      decoyHash = undefined;
      throw error;
    }));
  decoy().catch(() => undefined);

  return {
    async login({ email, password }) {
      const user = await users.findByEmail(email);
      if (!user || user.deletedAt) {
        await passwords.verify(await decoy(), password);
        throw new AppError('INVALID_CREDENTIALS');
      }
      if (!(await passwords.verify(user.passwordHash, password))) {
        throw new AppError('INVALID_CREDENTIALS');
      }

      // The password may have changed (or the account been deleted) since it was checked.
      const session = await sessions.createForLogin(user.id, user.passwordHash);
      if (!session) throw new AppError('INVALID_CREDENTIALS');
      const accessToken = await tokens.signAccess(user.id);
      return toLoginResult(accessToken, session.refreshToken, user);
    },

    async refresh(refreshToken) {
      const result = await sessions.rotate(refreshToken);
      if (result.outcome !== 'rotated') return result;
      const accessToken = await tokens.signAccess(result.user.id);
      return {
        outcome: 'rotated',
        session: toLoginResult(accessToken, result.refreshToken, result.user),
      };
    },

    logout: (refreshToken) => sessions.revoke(refreshToken),

    async changePassword(userId, { currentPassword, newPassword }) {
      const user = await users.findActiveWithCredentials(userId);
      if (!user) throw new AppError('UNAUTHORIZED');
      if (!(await passwords.verify(user.passwordHash, currentPassword))) {
        throw new AppError('INVALID_CREDENTIALS');
      }
      // Argon2id runs before the transaction, so the user lock is held only for two writes.
      const newHash = await passwords.hash(newPassword);
      return transaction(async (tx) => {
        // Lock order (ADR-0003): sessions first — that takes the user lock — then the user row.
        const revokedSessions = await sessions.revokeAllForUser(userId, tx);
        // Changed by a concurrent request since we checked it: roll back, nothing happened.
        if (!(await users.bindTo(tx).replacePasswordHash(userId, user.passwordHash, newHash))) {
          throw new AppError('INVALID_CREDENTIALS');
        }
        return { revokedSessions };
      });
    },
  };

  function toLoginResult(
    accessToken: string,
    refreshToken: string,
    user: Parameters<typeof toPublicUser>[0],
  ): LoginResult {
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: tokens.accessTtlSeconds,
      refreshToken,
      user: toPublicUser(user),
    };
  }
}
