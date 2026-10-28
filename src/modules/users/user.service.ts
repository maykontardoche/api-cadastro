import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../http/errors.js';
import type { ProfileChanges, UserRepository } from './user.repository.js';
import { toPublicUser, type PublicUser } from './user.schema.js';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface UserService {
  register: (input: RegisterInput) => Promise<PublicUser>;
  /** Name and email only; role, id, password and dates are not reachable from here. */
  updateSelf: (userId: string, changes: ProfileChanges) => Promise<PublicUser>;
}

export interface UserServiceDeps {
  users: UserRepository;
  /** Injected so `users` does not depend on the `auth` module (see ADR-0001). */
  hashPassword: (plain: string) => Promise<string>;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function createUserService({ users, hashPassword }: UserServiceDeps): UserService {
  return {
    async register({ name, email, password }) {
      const passwordHash = await hashPassword(password);
      try {
        return toPublicUser(await users.create({ name, email, passwordHash }));
      } catch (error) {
        // Email is the only unique column a new user can collide on; the database decides,
        // so two concurrent registrations with the same email cannot both succeed.
        if (isUniqueViolation(error)) throw new AppError('EMAIL_TAKEN');
        throw error;
      }
    },

    async updateSelf(userId, changes) {
      try {
        const updated = await users.updateProfile(userId, changes);
        // Deleted between authentication and this write: the account no longer exists.
        if (!updated) throw new AppError('UNAUTHORIZED');
        return toPublicUser(updated);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError('EMAIL_TAKEN');
        throw error;
      }
    },
  };
}
