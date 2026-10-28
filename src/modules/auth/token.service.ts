import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

import { AppError } from '../../http/errors.js';

/** RFC 9068 media type: a token signed with the same secret but another `typ` is refused. */
export const ACCESS_TOKEN_TYPE = 'at+jwt';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_BYTES = 32;
const ALGORITHM = 'HS256';

export interface TokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds?: number;
}

export interface RefreshToken {
  /** Sent to the client once; never stored. */
  token: string;
  /** SHA-256 hex of the token: the only form that reaches the database. */
  hash: string;
}

export interface TokenService {
  /** Lifetime of the tokens signAccess issues, reported to clients as `expiresIn`. */
  accessTtlSeconds: number;
  signAccess: (userId: string) => Promise<string>;
  /** Any problem with the token (signature, claims, type, expiry) becomes 401 UNAUTHORIZED. */
  verifyAccess: (token: string) => Promise<{ userId: string }>;
  newRefresh: () => RefreshToken;
}

/** A random 256-bit token does not need a slow hash: SHA-256 is enough for storage and lookup. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createTokenService({
  secret,
  issuer,
  audience,
  accessTtlSeconds = ACCESS_TOKEN_TTL_SECONDS,
}: TokenConfig): TokenService {
  const key = new TextEncoder().encode(secret);

  return {
    accessTtlSeconds,
    signAccess: (userId) =>
      new SignJWT()
        .setProtectedHeader({ alg: ALGORITHM, typ: ACCESS_TOKEN_TYPE })
        .setSubject(userId)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(`${String(accessTtlSeconds)}s`)
        .setJti(randomUUID())
        .sign(key),

    async verifyAccess(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer,
          audience,
          typ: ACCESS_TOKEN_TYPE,
          requiredClaims: ['sub', 'exp', 'iat'],
        });
        if (typeof payload.sub !== 'string') throw new Error('missing subject');
        return { userId: payload.sub };
      } catch {
        throw new AppError('UNAUTHORIZED');
      }
    },

    newRefresh() {
      const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      return { token, hash: hashRefreshToken(token) };
    },
  };
}
