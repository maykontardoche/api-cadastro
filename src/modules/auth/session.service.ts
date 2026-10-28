import { randomUUID } from 'node:crypto';

import type { SessionRepository } from './session.repository.js';
import type { TokenService } from './token.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreatedSession {
  refreshToken: string;
  expiresAt: Date;
}

export interface SessionService {
  /** Starts a session; a new login starts a new family, a rotation continues an existing one. */
  create: (userId: string, familyId?: string) => Promise<CreatedSession>;
}

export interface SessionServiceDeps {
  sessions: SessionRepository;
  tokens: TokenService;
  refreshTtlDays: number;
}

export function createSessionService({
  sessions,
  tokens,
  refreshTtlDays,
}: SessionServiceDeps): SessionService {
  return {
    async create(userId, familyId = randomUUID()) {
      const { token, hash } = tokens.newRefresh();
      const expiresAt = new Date(Date.now() + refreshTtlDays * DAY_MS);
      await sessions.create({ userId, familyId, tokenHash: hash, expiresAt });
      return { refreshToken: token, expiresAt };
    },
  };
}
