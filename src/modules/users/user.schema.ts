import { z } from 'zod';

import type { User } from '../../generated/prisma/client.js';
import { customIssue } from '../../http/errors.js';

/** Column limits from prisma/schema.prisma (VARCHAR(254) and VARCHAR(100)). */
export const EMAIL_MAX_LENGTH = 254;
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 100;

// Control characters (NUL, line breaks, tabs...) have no place in a name; PostgreSQL text
// columns also reject NUL outright, which would otherwise surface as a 500.
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Single place where email and name are normalized, reused by register, profile and admin. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(EMAIL_MAX_LENGTH))
  .meta({
    description: 'Normalizado: sem espaços nas pontas e em minúsculas.',
    format: 'email',
    maxLength: EMAIL_MAX_LENGTH,
    example: 'ana@example.com',
  });

export const nameSchema = z
  .string()
  .trim()
  .min(NAME_MIN_LENGTH)
  .max(NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), {
    message: 'O nome contém caracteres não permitidos.',
    ...customIssue('invalid_characters'),
  })
  .meta({ example: 'Ana Souza' });

export const roleSchema = z.enum(['USER', 'ADMIN']);

export const publicUserSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    role: roleSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'PublicUser' });

export type PublicUser = z.infer<typeof publicUserSchema>;

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;
/** Caps OFFSET, so a huge page number cannot force the database to skip millions of rows. */
export const LIST_MAX_PAGE = 10_000;
export const SEARCH_MAX_LENGTH = 100;

/** Only these columns can be sorted on: the client never names a column freely. */
export const USER_SORT_FIELDS = ['name', 'email', 'createdAt'] as const;

export const listUsersQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).max(LIST_MAX_PAGE).default(1),
    limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
    search: z
      .string()
      .trim()
      .min(1)
      .max(SEARCH_MAX_LENGTH)
      .optional()
      .meta({ description: 'Parte do nome ou do e-mail, sem diferenciar maiúsculas.' }),
    sortBy: z.enum(USER_SORT_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .meta({ id: 'ListUsersQuery' });

export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;

export const usersPageSchema = z
  .object({
    data: z.array(publicUserSchema),
    meta: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  })
  .meta({ id: 'UsersPage' });

export type UsersPage = z.infer<typeof usersPageSchema>;

/** The only shape of a user that leaves the API: no password hash, no deletion marker. */
export function toPublicUser(user: Omit<User, 'passwordHash'>): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
