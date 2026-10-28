import type { PrismaClient, User } from '../../generated/prisma/client.js';

/** A user as seen by request handlers: the password hash never leaves the repository. */
export type UserWithoutSecrets = Omit<User, 'passwordHash'>;

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
}

export interface UserRepository {
  /** Never sets `role`: the database default (USER) applies. */
  create: (data: NewUser) => Promise<User>;
  /** Includes soft-deleted users: callers decide what a deleted account means for them. */
  findByEmail: (email: string) => Promise<User | null>;
  /** Only users that are not soft-deleted, without the password hash. */
  findActiveById: (id: string) => Promise<UserWithoutSecrets | null>;
}

export function createUserRepository(prisma: PrismaClient): UserRepository {
  return {
    create: (data) => prisma.user.create({ data }),
    findByEmail: (email) => prisma.user.findUnique({ where: { email } }),
    findActiveById: (id) =>
      prisma.user.findFirst({ where: { id, deletedAt: null }, omit: { passwordHash: true } }),
  };
}
