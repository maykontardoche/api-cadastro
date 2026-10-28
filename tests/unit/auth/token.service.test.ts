import { createHash } from 'node:crypto';

import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/http/errors.js';
import {
  ACCESS_TOKEN_TYPE,
  createTokenService,
  hashRefreshToken,
} from '../../../src/modules/auth/token.service.js';

const config = {
  secret: 'EXAMPLE-unit-test-secret-with-at-least-32-bytes',
  issuer: 'api-cadastro',
  audience: 'api-cadastro-client',
};
const tokens = createTokenService(config);
const userId = '0192f000-0000-7000-8000-000000000001';
const key = new TextEncoder().encode(config.secret);

/** A token built by hand, starting from a valid one and changing one thing. */
function craft(
  overrides: { typ?: string; iss?: string; aud?: string; sub?: string | null; exp?: string } = {},
  signingKey = key,
): Promise<string> {
  const jwt = new SignJWT()
    .setProtectedHeader({ alg: 'HS256', typ: overrides.typ ?? ACCESS_TOKEN_TYPE })
    .setIssuer(overrides.iss ?? config.issuer)
    .setAudience(overrides.aud ?? config.audience)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? '15m');
  if (overrides.sub !== null) jwt.setSubject(overrides.sub ?? userId);
  return jwt.sign(signingKey);
}

async function expectUnauthorized(token: string): Promise<void> {
  await expect(tokens.verifyAccess(token)).rejects.toSatisfy(
    (error) => error instanceof AppError && error.code === 'UNAUTHORIZED',
  );
}

describe('TokenService.signAccess / verifyAccess', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips the user id', async () => {
    await expect(tokens.verifyAccess(await tokens.signAccess(userId))).resolves.toEqual({ userId });
  });

  it('issues HS256 tokens of type at+jwt with iss, aud, sub, iat, exp and jti', async () => {
    const [header, payload] = (await tokens.signAccess(userId))
      .split('.')
      .slice(0, 2)
      .map(
        (part) =>
          JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>,
      );

    expect(header).toEqual({ alg: 'HS256', typ: 'at+jwt' });
    expect(payload).toMatchObject({ sub: userId, iss: config.issuer, aud: config.audience });
    expect(Object.keys(payload ?? {}).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    expect(Number(payload?.exp) - Number(payload?.iat)).toBe(15 * 60);
  });

  it('does not put the role (or anything else about the user) in the token', async () => {
    const payload = (await tokens.signAccess(userId)).split('.')[1] ?? '';

    expect(Buffer.from(payload, 'base64url').toString('utf8')).not.toMatch(/role|USER|ADMIN|email/);
  });

  it('rejects an expired token', async () => {
    const token = await tokens.signAccess(userId);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1_000);

    await expectUnauthorized(token);
  });

  it.each([
    ['a wrong issuer', { iss: 'someone-else' }],
    ['a wrong audience', { aud: 'another-client' }],
    ['another token type', { typ: 'JWT' }],
    ['no subject', { sub: null }],
  ])('rejects %s', async (_case, overrides) => {
    await expectUnauthorized(await craft(overrides));
  });

  it('rejects a token signed with another secret', async () => {
    await expectUnauthorized(
      await craft({}, new TextEncoder().encode('EXAMPLE-another-secret-of-32-bytes-or-more')),
    );
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await tokens.signAccess(userId)).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else' })).toString('base64url');

    await expectUnauthorized(`${header ?? ''}.${forged}.${signature ?? ''}`);
  });

  it('rejects an unsigned token (alg: none)', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'none', typ: ACCESS_TOKEN_TYPE })}.${encode({
      sub: userId,
      iss: config.issuer,
      aud: config.audience,
      iat: now,
      exp: now + 900,
    })}.`;

    await expectUnauthorized(unsigned);
  });

  it.each(['', 'not-a-jwt', 'a.b.c'])('rejects garbage %j', async (token) => {
    await expectUnauthorized(token);
  });
});

describe('TokenService.newRefresh', () => {
  it('returns a 256-bit random token and its SHA-256 hex', () => {
    const { token, hash } = tokens.newRefresh();

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashRefreshToken(token)).toBe(hash);
  });

  it('never repeats a token', () => {
    const issued = new Set(Array.from({ length: 1_000 }, () => tokens.newRefresh().token));

    expect(issued.size).toBe(1_000);
  });
});
