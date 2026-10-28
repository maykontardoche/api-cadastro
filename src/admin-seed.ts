import { z } from 'zod';

import type { PrismaClient } from './generated/prisma/client.js';
import { newPasswordSchema } from './modules/auth/password.js';
import { createUserRepository } from './modules/users/user.repository.js';
import { emailSchema, nameSchema } from './modules/users/user.schema.js';

/** No defaults on purpose: the first admin's credentials always come from whoever operates it. */
const adminSeedSchema = z.object({
  ADMIN_NAME: nameSchema,
  ADMIN_EMAIL: emailSchema,
  ADMIN_PASSWORD: newPasswordSchema,
});

export type AdminSeedOutcome = 'created' | 'promoted' | 'already-admin';

/** Carries only variable names or a fixed reason — never the values. */
export class AdminSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminSeedError';
  }
}

export interface AdminSeedDeps {
  prisma: PrismaClient;
  source: NodeJS.ProcessEnv;
  hashPassword: (plain: string) => Promise<string>;
  verifyPassword: (hash: string, plain: string) => Promise<boolean>;
}

/**
 * Creates the first ADMIN, or promotes the account that already has ADMIN_EMAIL. Idempotent and
 * never overwrites an existing password: running it again cannot be used to reset an admin.
 *
 * Promotion requires ADMIN_PASSWORD to be that account's current password. Registration is
 * public and emails are not verified, so an account with the admin email may belong to someone
 * else who signed up first; promoting it blindly would hand them the admin role.
 */
export async function seedAdmin({
  prisma,
  source,
  hashPassword,
  verifyPassword,
}: AdminSeedDeps): Promise<AdminSeedOutcome> {
  const parsed = adminSeedSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new AdminSeedError(`Invalid or missing variables: ${names.join(', ')}`);
  }
  const { ADMIN_NAME: name, ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.deletedAt) {
    throw new AdminSeedError('ADMIN_EMAIL belongs to a deleted account; use another email');
  }
  if (existing?.role === 'ADMIN') return 'already-admin';
  if (existing && !(await verifyPassword(existing.passwordHash, password))) {
    throw new AdminSeedError(
      'ADMIN_EMAIL is already registered with a different password; it was not promoted',
    );
  }
  // Argon2id runs before the transaction, so the admin-set lock is held only for one write.
  const passwordHash = existing ? existing.passwordHash : await hashPassword(password);

  // Under the same admin-set lock as role changes and deletions, so a concurrent demotion cannot
  // silently undo this promotion (or count admins while it is half done).
  return prisma.$transaction(async (tx): Promise<AdminSeedOutcome> => {
    await createUserRepository(prisma).bindTo(tx).lockAdminSet();
    if (!existing) {
      await tx.user.create({ data: { name, email, passwordHash, role: 'ADMIN' } });
      return 'created';
    }
    // Conditional, so a deletion or a password change in between is not overridden.
    const { count } = await tx.user.updateMany({
      where: { id: existing.id, passwordHash, deletedAt: null, role: 'USER' },
      data: { role: 'ADMIN' },
    });
    if (count !== 1) throw new AdminSeedError('The account changed while seeding; run it again');
    return 'promoted';
  });
}
