import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { zodIssuesToDetails } from '../../../src/http/errors.js';
import { emailSchema, nameSchema, toPublicUser } from '../../../src/modules/users/user.schema.js';

// Emails the API accepts: Zod's email check is intentionally stricter than RFC 5322, so the
// property is stated over that accepted space (mixed case included) rather than fc.emailAddress().
const emailArbitrary = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,30}[A-Za-z0-9])?$/),
    fc.stringMatching(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,20}[A-Za-z0-9])?$/),
    fc.constantFrom('com', 'com.br', 'org', 'IO', 'dev'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)
  .filter((email) => !email.includes('..'));
const padding = fc.stringMatching(/^[ \t]{0,3}$/);

describe('emailSchema', () => {
  it('trims and lowercases', () => {
    expect(emailSchema.parse('  Ana.Souza@Example.COM ')).toBe('ana.souza@example.com');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(emailArbitrary, (email) => {
        const once = emailSchema.parse(email);
        expect(emailSchema.parse(once)).toBe(once);
      }),
    );
  });

  it('erases differences of case and surrounding whitespace', () => {
    fc.assert(
      fc.property(emailArbitrary, padding, padding, (email, before, after) => {
        expect(emailSchema.parse(`${before}${email.toUpperCase()}${after}`)).toBe(
          emailSchema.parse(email),
        );
      }),
    );
  });

  it.each(['not-an-email', 'ana@', '@example.com', `${'a'.repeat(250)}@x.com`])(
    'rejects %s',
    (email) => {
      expect(emailSchema.safeParse(email).success).toBe(false);
    },
  );
});

describe('nameSchema', () => {
  it('trims', () => {
    expect(nameSchema.parse('  Ana  ')).toBe('Ana');
  });

  it.each(['', ' ', 'A', ' A ', 'x'.repeat(101)])('rejects %j', (name) => {
    expect(nameSchema.safeParse(name).success).toBe(false);
  });

  it.each(['Al', 'x'.repeat(100)])('accepts the boundary %j', (name) => {
    expect(nameSchema.safeParse(name).success).toBe(true);
  });
});

describe('toPublicUser', () => {
  it('exposes only public fields', () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const publicUser = toPublicUser({
      id: '0192f000-0000-7000-8000-000000000001',
      name: 'Ana',
      email: 'ana@example.com',
      passwordHash: '$argon2id$secret',
      role: 'USER',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(Object.keys(publicUser).sort()).toEqual(
      ['createdAt', 'email', 'id', 'name', 'role', 'updatedAt'].sort(),
    );
    expect(JSON.stringify(publicUser)).not.toContain('argon2');
  });
});

describe('nameSchema control characters', () => {
  it.each(['Ana\u0000Souza', 'Ana\nSouza', 'Ana\tSouza', 'Ana\u007fSouza'])(
    'rejects %j with invalid_characters',
    (name) => {
      const result = nameSchema.safeParse(name);

      expect(result.success).toBe(false);
      expect(result.success ? [] : zodIssuesToDetails(result.error.issues)).toEqual([
        { field: 'body', code: 'invalid_characters' },
      ]);
    },
  );

  it('accepts accents and other letters', () => {
    expect(nameSchema.parse('José Ñúñez Ærø')).toBe('José Ñúñez Ærø');
  });
});
