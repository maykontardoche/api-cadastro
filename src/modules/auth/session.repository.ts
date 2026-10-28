import type { Prisma, PrismaClient, RefreshSession } from '../../generated/prisma/client.js';
import type { UserWithoutSecrets } from '../users/user.repository.js';

/** Either the client or an open interactive transaction: repository calls work in both. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface NewSession {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export type SessionWithUser = RefreshSession & { user: UserWithoutSecrets };

export interface SessionRepository {
  create: (data: NewSession) => Promise<RefreshSession>;
  findByTokenHash: (tokenHash: string) => Promise<SessionWithUser | null>;
  /**
   * Compare-and-set: revokes the session only if it is still active. Returns false when another
   * request revoked it first — the signal that a refresh token was used twice.
   */
  revokeIfActive: (id: string) => Promise<boolean>;
  /** Links a rotated session to its successor, for tracing a family's history. */
  markReplaced: (id: string, replacedBySessionId: string) => Promise<void>;
  /** Revokes every still-active session of a family; returns how many were revoked. */
  revokeFamily: (familyId: string) => Promise<number>;
  revokeByTokenHash: (tokenHash: string) => Promise<number>;
  revokeAllForUser: (userId: string) => Promise<number>;
  /**
   * Serializes every change to this user's sessions until the current transaction ends
   * (`pg_advisory_xact_lock`). Needed because under Read Committed a bulk revoke only sees rows
   * committed before it started: without the lock, a session inserted by a concurrent rotation
   * would survive a reuse detection or a "revoke all". Only valid inside `transaction`.
   */
  lockUser: (userId: string) => Promise<void>;
  /** Runs `work` in one database transaction, with a repository bound to it. */
  transaction: <T>(work: (sessions: SessionRepository) => Promise<T>) => Promise<T>;
  /** A repository bound to a transaction opened elsewhere (e.g. one that also updates the user). */
  bindTo: (tx: Prisma.TransactionClient) => SessionRepository;
}

/** Namespaces the advisory lock key, so other features can lock on the same user id safely. */
const SESSION_LOCK_PREFIX = 'refresh-sessions:';

function bind(db: DbClient, root: PrismaClient): SessionRepository {
  const active = { revokedAt: null };
  const repository: SessionRepository = {
    create: (data) => db.refreshSession.create({ data }),
    findByTokenHash: (tokenHash) =>
      db.refreshSession.findUnique({
        where: { tokenHash },
        include: { user: { omit: { passwordHash: true } } },
      }),
    revokeIfActive: async (id) => {
      const { count } = await db.refreshSession.updateMany({
        where: { id, ...active },
        data: { revokedAt: new Date() },
      });
      return count === 1;
    },
    markReplaced: async (id, replacedBySessionId) => {
      await db.refreshSession.update({ where: { id }, data: { replacedBySessionId } });
    },
    revokeFamily: async (familyId) =>
      (
        await db.refreshSession.updateMany({
          where: { familyId, ...active },
          data: { revokedAt: new Date() },
        })
      ).count,
    revokeByTokenHash: async (tokenHash) =>
      (
        await db.refreshSession.updateMany({
          where: { tokenHash, ...active },
          data: { revokedAt: new Date() },
        })
      ).count,
    revokeAllForUser: async (userId) =>
      (
        await db.refreshSession.updateMany({
          where: { userId, ...active },
          data: { revokedAt: new Date() },
        })
      ).count,
    lockUser: async (userId) => {
      if (db === root) throw new Error('lockUser must run inside a transaction');
      const key = SESSION_LOCK_PREFIX + userId;
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    },
    // Already inside a transaction: reuse it instead of nesting.
    transaction: (work) =>
      db === root ? root.$transaction((tx) => work(bind(tx, root))) : work(repository),
    bindTo: (tx) => bind(tx, root),
  };
  return repository;
}

export function createSessionRepository(prisma: PrismaClient): SessionRepository {
  return bind(prisma, prisma);
}
