import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../generated/prisma/client.js';
import type { UserWithoutSecrets } from '../users/user.repository.js';
import type { SessionRepository } from './session.repository.js';
import { hashRefreshToken, type TokenService } from './token.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreatedSession {
  id: string;
  refreshToken: string;
  expiresAt: Date;
}

export type RotationResult =
  | { outcome: 'rotated'; user: UserWithoutSecrets; refreshToken: string }
  /**
   * The token was already used: the whole family was revoked (possible theft). `afterRotation`
   * tells a replayed, already-rotated token (strong theft signal) from one revoked by logout or
   * by a bulk revoke (often just a stale client).
   */
  | {
      outcome: 'reused';
      userId: string;
      familyId: string;
      revokedSessions: number;
      afterRotation: boolean;
    }
  /** Unknown, expired, or belonging to a deleted account. */
  | { outcome: 'invalid' };

export interface SessionService {
  /**
   * The only way to start a session family (login). Starts it only if the credential that was just verified is still the current
   * one and the account still exists. Runs under the user lock, so a password change or a
   * deletion that commits between the check and this call wins: the login gets `null`.
   */
  createForLogin: (userId: string, verifiedPasswordHash: string) => Promise<CreatedSession | null>;
  /** Accepts a refresh token at most once, replacing it with a new one in the same family. */
  rotate: (refreshToken: string) => Promise<RotationResult>;
  /** Ends the session of this token if it is still active. Silent either way. */
  revoke: (refreshToken: string) => Promise<void>;
  /**
   * Ends every session of the user, including one a concurrent rotation is creating right now.
   * Pass `tx` to make it part of a larger transaction (password change, account deletion).
   *
   * Lock order: inside `tx`, call this BEFORE updating the user's row. A rotation holds the user
   * lock and inserts a session, which takes FOR KEY SHARE on the user row (foreign key); a caller
   * that already holds FOR UPDATE on that row (e.g. changing the unique `email`) and then waits
   * for the user lock deadlocks with it.
   */
  revokeAllForUser: (userId: string, tx?: Prisma.TransactionClient) => Promise<number>;
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
  async function createIn(repository: SessionRepository, userId: string, familyId: string) {
    const { token, hash } = tokens.newRefresh();
    const expiresAt = new Date(Date.now() + refreshTtlDays * DAY_MS);
    const { id } = await repository.create({ userId, familyId, tokenHash: hash, expiresAt });
    return { id, refreshToken: token, expiresAt };
  }

  return {
    createForLogin: (userId, verifiedPasswordHash) =>
      sessions.transaction(async (tx) => {
        await tx.lockUser(userId);
        const current = await tx.readCredentialState(userId);
        if (!current || current.deletedAt || current.passwordHash !== verifiedPasswordHash) {
          return null;
        }
        return createIn(tx, userId, randomUUID());
      }),

    rotate: (refreshToken) =>
      sessions.transaction(async (tx): Promise<RotationResult> => {
        const tokenHash = hashRefreshToken(refreshToken);
        const found = await tx.findByTokenHash(tokenHash);
        if (!found) return { outcome: 'invalid' };
        // One session change per user at a time, then read again: what we saw before waiting
        // for the lock may already be stale.
        await tx.lockUser(found.userId);
        const session = await tx.findByTokenHash(tokenHash);
        if (!session) return { outcome: 'invalid' };
        const revokeFamilyAsReuse = async (): Promise<RotationResult> => ({
          outcome: 'reused',
          userId: session.userId,
          familyId: session.familyId,
          revokedSessions: await tx.revokeFamily(session.familyId),
          afterRotation: session.replacedBySessionId !== null,
        });
        // Checked before expiry: replaying an old token is theft even after it expires, as long
        // as the record is kept (sessions are retained until their own expiresAt).
        if (session.revokedAt) return revokeFamilyAsReuse();
        if (session.expiresAt <= new Date() || session.user.deletedAt) {
          return { outcome: 'invalid' };
        }
        // Defense in depth: writers that skip the user lock (logout) can still revoke this row
        // between our read and this write; the claim then matches 0 rows.
        if (!(await tx.revokeIfActive(session.id))) return revokeFamilyAsReuse();
        const next = await createIn(tx, session.userId, session.familyId);
        await tx.markReplaced(session.id, next.id);
        return { outcome: 'rotated', user: session.user, refreshToken: next.refreshToken };
      }),

    revoke: async (refreshToken) => {
      await sessions.revokeByTokenHash(hashRefreshToken(refreshToken));
    },

    revokeAllForUser: (userId, tx) => {
      const revokeLocked = async (repository: SessionRepository) => {
        await repository.lockUser(userId);
        return repository.revokeAllForUser(userId);
      };
      return tx ? revokeLocked(sessions.bindTo(tx)) : sessions.transaction(revokeLocked);
    },
  };
}
