import type { TransactionRunner } from '../../db/transaction.js';
import { Prisma, type Role } from '../../generated/prisma/client.js';
import { AppError } from '../../http/errors.js';
import type { ProfileChanges, UserRepository } from './user.repository.js';
import {
  toPublicUser,
  type ListUsersQuery,
  type PublicUser,
  type UsersPage,
} from './user.schema.js';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface RoleChange {
  user: PublicUser;
  previousRole: Role;
}

export interface UserService {
  register: (input: RegisterInput) => Promise<PublicUser>;
  /** Name and email only; role, id, password and dates are not reachable from here. */
  updateSelf: (userId: string, changes: ProfileChanges) => Promise<PublicUser>;
  /** Active users only; soft-deleted ones are invisible here and in the total. */
  list: (query: ListUsersQuery) => Promise<UsersPage>;
  /** Admin: an active user, or 404 (unknown and soft-deleted look the same). */
  getById: (id: string) => Promise<PublicUser>;
  /** Admin: name/email of an active user; 404 if gone, 409 if the email is taken. */
  updateById: (id: string, changes: ProfileChanges) => Promise<PublicUser>;
  /**
   * Admin: refuses (409 LAST_ADMIN) to demote the only active admin, even under concurrency.
   * `actorId` is re-checked inside the lock: an admin demoted or deleted mid-request gets 403.
   */
  changeRole: (actorId: string, id: string, role: Role) => Promise<RoleChange>;
  /**
   * Admin: soft delete; ends every session in the same transaction. Refuses (409 LAST_ADMIN) to
   * delete the only active admin. `actorId` is re-checked inside the lock, as in changeRole.
   */
  softDelete: (actorId: string, id: string) => Promise<{ revokedSessions: number }>;
}

export interface UserServiceDeps {
  users: UserRepository;
  /** Injected so `users` does not depend on the `auth` module (see ADR-0001). */
  hashPassword: (plain: string) => Promise<string>;
  /** Ends every session of the user inside `tx`, taking the user's session lock. */
  revokeAllSessions: (userId: string, tx: Prisma.TransactionClient) => Promise<number>;
  transaction: TransactionRunner;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function createUserService({
  users,
  hashPassword,
  revokeAllSessions,
  transaction,
}: UserServiceDeps): UserService {
  async function updateProfileOr(
    id: string,
    changes: ProfileChanges,
    missing: 'UNAUTHORIZED' | 'NOT_FOUND',
  ): Promise<PublicUser> {
    try {
      const updated = await users.updateProfile(id, changes);
      if (!updated) throw new AppError(missing);
      return toPublicUser(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('EMAIL_TAKEN');
      throw error;
    }
  }

  /**
   * Inside the admin-set lock: the target, and whether removing its admin role would leave the
   * system with no active admin. The lock makes the count and the following write atomic with
   * respect to every other demotion or deletion.
   */
  async function lockAndLoadTarget(repository: UserRepository, actorId: string, id: string) {
    await repository.lockAdminSet();
    // The actor was an admin when authenticated; a concurrent demotion or deletion may have
    // committed since, and it must not still be able to act.
    const actor = await repository.findActiveById(actorId);
    if (actor?.role !== 'ADMIN') throw new AppError('FORBIDDEN');
    const target = await repository.findActiveById(id);
    if (!target) throw new AppError('NOT_FOUND');
    const isLastAdmin = target.role === 'ADMIN' && (await repository.countActiveAdmins()) <= 1;
    return { target, isLastAdmin };
  }

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

    async list(query) {
      const { users: page, total } = await users.listActive(query);
      return {
        data: page.map(toPublicUser),
        meta: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      };
    },

    // Deleted between authentication and this write: the account no longer exists.
    updateSelf: (userId, changes) => updateProfileOr(userId, changes, 'UNAUTHORIZED'),

    async getById(id) {
      const user = await users.findActiveById(id);
      if (!user) throw new AppError('NOT_FOUND');
      return toPublicUser(user);
    },

    updateById: (id, changes) => updateProfileOr(id, changes, 'NOT_FOUND'),

    changeRole: (actorId, id, role) =>
      transaction(async (tx) => {
        const repository = users.bindTo(tx);
        const { target, isLastAdmin } = await lockAndLoadTarget(repository, actorId, id);
        // Same role: nothing to write, so updatedAt stays as it was.
        if (target.role === role) return { user: toPublicUser(target), previousRole: role };
        if (role === 'USER' && isLastAdmin) throw new AppError('LAST_ADMIN');
        const updated = await repository.setRole(id, role);
        if (!updated) throw new AppError('NOT_FOUND');
        return { user: toPublicUser(updated), previousRole: target.role };
      }),

    softDelete: (actorId, id) =>
      transaction(async (tx) => {
        const repository = users.bindTo(tx);
        const { isLastAdmin } = await lockAndLoadTarget(repository, actorId, id);
        if (isLastAdmin) throw new AppError('LAST_ADMIN');
        // Lock order (ADR-0003): sessions — the user's session lock — before the user row.
        const revokedSessions = await revokeAllSessions(id, tx);
        if (!(await repository.softDelete(id))) throw new AppError('NOT_FOUND');
        return { revokedSessions };
      }),
  };
}
