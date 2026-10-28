import { describe, expect, it } from 'vitest';

import { zodIssuesToDetails } from '../../../src/http/errors.js';
import {
  hashPassword,
  isCommonPassword,
  newPasswordSchema,
  verifyPassword,
} from '../../../src/modules/auth/password.js';

function detailsOf(password: string) {
  const result = newPasswordSchema.safeParse(password);
  return result.success ? [] : zodIssuesToDetails(result.error.issues);
}

// A long password that is not in the blocklist.
const strong = 'correct horse battery staple';

describe('newPasswordSchema', () => {
  it.each([
    [14, [{ field: 'body', code: 'too_small' }]],
    [15, []],
    [128, []],
    [129, [{ field: 'body', code: 'too_big' }]],
  ])('length %i → %j', (length, expected) => {
    expect(detailsOf('k9'.repeat(65).slice(0, length))).toEqual(expected);
  });

  it('counts characters as code points, so emoji count once', () => {
    // 15 emoji = 30 UTF-16 units, but 15 characters.
    expect(detailsOf('🔐'.repeat(15))).toEqual([]);
    expect(detailsOf('🔐'.repeat(14))).toEqual([{ field: 'body', code: 'too_small' }]);
  });

  it('has no composition rule: lowercase letters and spaces only are fine', () => {
    expect(detailsOf(strong)).toEqual([]);
  });

  it('rejects a password from the common-password list, ignoring case', () => {
    expect(isCommonPassword('demon1q2w3e4r5t')).toBe(true);
    expect(detailsOf('demon1q2w3e4r5t')).toEqual([{ field: 'body', code: 'common_password' }]);
    expect(detailsOf('DEMON1Q2W3E4R5T')).toEqual([{ field: 'body', code: 'common_password' }]);
  });

  it('normalizes to NFKC before checking and returns the normalized value', () => {
    // U+FB01 (ﬁ ligature) and full-width letters become plain ASCII under NFKC.
    const decorated = 'ﬁxed ＡＢＣ horse battery';

    expect(newPasswordSchema.parse(decorated)).toBe('fixed ABC horse battery');
  });

  it('never puts the password in the error details', () => {
    const result = newPasswordSchema.safeParse('short-secret');

    expect(result.success).toBe(false);
    expect(
      JSON.stringify(result.success ? [] : zodIssuesToDetails(result.error.issues)),
    ).not.toContain('short-secret');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('hashes with Argon2id and the OWASP minimum parameters', async () => {
    const hash = await hashPassword(strong);

    // PHC format: $argon2id$v=19$m=…,t=…,p=…$salt$hash (parameter order is up to the library).
    const [, algorithm, version, params] = hash.split('$');
    expect(algorithm).toBe('argon2id');
    expect(version).toBe('v=19');
    expect(Object.fromEntries((params ?? '').split(',').map((kv) => kv.split('=')))).toEqual({
      m: '19456',
      t: '2',
      p: '1',
    });
    expect(hash).not.toContain(strong);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword(strong);

    await expect(verifyPassword(hash, strong)).resolves.toBe(true);
    await expect(verifyPassword(hash, `${strong}!`)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword(strong), hashPassword(strong)]);

    expect(a).not.toBe(b);
  });

  it('treats NFKC-equivalent passwords as the same', async () => {
    const hash = await hashPassword('ﬁxed ＡＢＣ horse battery');

    await expect(verifyPassword(hash, 'fixed ABC horse battery')).resolves.toBe(true);
  });
});
