import { readFileSync } from 'node:fs';

import argon2 from 'argon2';
import { z } from 'zod';

import { customIssue } from '../../http/errors.js';

/** NIST SP 800-63B-4 for a single-factor password: length only, no composition rules. */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

/** OWASP Password Storage Cheat Sheet minimum for Argon2id. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Entries are already NFKC-normalized, lowercased and 15–128 characters long (see data/README.md).
const commonPasswords: ReadonlySet<string> = new Set(
  readFileSync(new URL('data/common-passwords.txt', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean),
);

/** Characters are counted as Unicode code points, so an emoji counts once. */
function lengthOf(value: string): number {
  return Array.from(value).length;
}

export function isCommonPassword(normalized: string): boolean {
  return commonPasswords.has(normalized.toLowerCase());
}

/** Validates and NFKC-normalizes a new password; the parsed value is what gets hashed. */
export const newPasswordSchema = z
  .string()
  .transform((value) => value.normalize('NFKC'))
  .superRefine((value, ctx) => {
    const length = lengthOf(value);
    if (length < PASSWORD_MIN_LENGTH) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'string',
        minimum: PASSWORD_MIN_LENGTH,
        inclusive: true,
        message: `A senha precisa ter pelo menos ${String(PASSWORD_MIN_LENGTH)} caracteres.`,
      });
    } else if (length > PASSWORD_MAX_LENGTH) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'string',
        maximum: PASSWORD_MAX_LENGTH,
        inclusive: true,
        message: `A senha pode ter no máximo ${String(PASSWORD_MAX_LENGTH)} caracteres.`,
      });
    } else if (isCommonPassword(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Esta senha é comum demais.',
        ...customIssue('common_password'),
      });
    }
  })
  .meta({
    description: `De ${String(PASSWORD_MIN_LENGTH)} a ${String(PASSWORD_MAX_LENGTH)} caracteres, sem regra de composição. Senhas comuns são recusadas.`,
    // The refinement above is invisible to the OpenAPI generator, so the limits are stated here.
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    example: 'uma frase longa que so eu sei',
  });

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain.normalize('NFKC'), ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain.normalize('NFKC'));
}
