import { Prisma, type PrismaClient, type User } from '../../generated/prisma/client.js';

/** A user as seen by request handlers: the password hash never leaves the repository. */
export type UserWithoutSecrets = Omit<User, 'passwordHash'>;

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
}

export interface ProfileChanges {
  name?: string;
  email?: string;
}

export interface UserRepository {
  /** Never sets `role`: the database default (USER) applies. */
  create: (data: NewUser) => Promise<User>;
  /** Includes soft-deleted users: callers decide what a deleted account means for them. */
  findByEmail: (email: string) => Promise<User | null>;
  /** Only users that are not soft-deleted, without the password hash. */
  findActiveById: (id: string) => Promise<UserWithoutSecrets | null>;
  /** Only users that are not soft-deleted, with the hash: for re-checking the current password. */
  findActiveWithCredentials: (id: string) => Promise<User | null>;
  /**
   * Updates name/email of an active user; `null` if the user is gone. A taken email surfaces as
   * Prisma's unique violation (P2002) for the caller to translate.
   */
  updateProfile: (id: string, changes: ProfileChanges) => Promise<UserWithoutSecrets | null>;
  /**
   * Compare-and-set on the hash: replaces it only if it is still `expectedHash`, so two
   * concurrent password changes cannot both succeed. Returns whether it replaced it.
   */
  replacePasswordHash: (id: string, expectedHash: string, newHash: string) => Promise<boolean>;
  /** A repository bound to a transaction opened elsewhere. */
  bindTo: (tx: Prisma.TransactionClient) => UserRepository;
}

type DbClient = PrismaClient | Prisma.TransactionClient;

function bind(db: DbClient): UserRepository {
  const active = { deletedAt: null };
  return {
    create: (data) => db.user.create({ data }),
    findByEmail: (email) => db.user.findUnique({ where: { email } }),
    findActiveById: (id) =>
      db.user.findFirst({ where: { id, ...active }, omit: { passwordHash: true } }),
    findActiveWithCredentials: (id) => db.user.findFirst({ where: { id, ...active } }),
    updateProfile: async (id, changes) => {
      try {
        return await db.user.update({
          where: { id, ...active },
          data: changes,
          omit: { passwordHash: true },
        });
      } catch (error) {
        // P2025: no active user matched the where clause.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          return null;
        }
        throw error;
      }
    },
    replacePasswordHash: async (id, expectedHash, newHash) => {
      const { count } = await db.user.updateMany({
        where: { id, passwordHash: expectedHash, ...active },
        data: { passwordHash: newHash },
      });
      return count === 1;
    },
    bindTo: (tx) => bind(tx),
  };
}

export function createUserRepository(prisma: PrismaClient): UserRepository {
  return bind(prisma);
}
