import type { PrismaClient, User } from '../../generated/prisma/client.js';

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
}

export interface UserRepository {
  /** Never sets `role`: the database default (USER) applies. */
  create: (data: NewUser) => Promise<User>;
}

export function createUserRepository(prisma: PrismaClient): UserRepository {
  return {
    create: (data) => prisma.user.create({ data }),
  };
}
