import { randomBytes } from 'node:crypto';

import { AppError } from '../../http/errors.js';
import type { UserRepository } from '../users/user.repository.js';
import { toPublicUser, type PublicUser } from '../users/user.schema.js';
import type { SessionService } from './session.service.js';
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

export interface AuthService {
  /** Any failure — unknown email, deleted account, wrong password — is the same 401. */
  login: (input: LoginInput) => Promise<LoginResult>;
}

export interface PasswordHasher {
  hash: (plain: string) => Promise<string>;
  verify: (hash: string, plain: string) => Promise<boolean>;
}

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionService;
  tokens: TokenService;
  passwords: PasswordHasher;
}

export function createAuthService({
  users,
  sessions,
  tokens,
  passwords,
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

      const [accessToken, session] = await Promise.all([
        tokens.signAccess(user.id),
        sessions.create(user.id),
      ]);
      return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: tokens.accessTtlSeconds,
        refreshToken: session.refreshToken,
        user: toPublicUser(user),
      };
    },
  };
}
