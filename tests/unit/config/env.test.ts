import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '../../../src/config/env.js';

const validSecret = 'a'.repeat(32);

function captureError(source: NodeJS.ProcessEnv): EnvValidationError {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('applies defaults when only the required secret is set', () => {
    const env = parseEnv({ JWT_ACCESS_SECRET: validSecret });

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      JWT_ACCESS_SECRET: validSecret,
      JWT_ISSUER: 'api-cadastro',
      JWT_AUDIENCE: 'api-cadastro-client',
      REFRESH_TOKEN_TTL_DAYS: 30,
    });
  });

  it('coerces numeric variables', () => {
    const env = parseEnv({ JWT_ACCESS_SECRET: validSecret, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('rejects a missing secret', () => {
    expect(captureError({}).variables).toEqual(['JWT_ACCESS_SECRET']);
  });

  it('accepts a secret of exactly 32 bytes and rejects 31', () => {
    expect(() => parseEnv({ JWT_ACCESS_SECRET: 'a'.repeat(32) })).not.toThrow();
    expect(captureError({ JWT_ACCESS_SECRET: 'a'.repeat(31) }).variables).toEqual([
      'JWT_ACCESS_SECRET',
    ]);
  });

  it('counts secret length in bytes, not characters', () => {
    // 16 two-byte characters = 32 bytes
    expect(() => parseEnv({ JWT_ACCESS_SECRET: 'é'.repeat(16) })).not.toThrow();
  });

  it.each(['abc', '0', '70000', '3000.5'])('rejects PORT=%s', (port) => {
    expect(captureError({ JWT_ACCESS_SECRET: validSecret, PORT: port }).variables).toEqual([
      'PORT',
    ]);
  });

  it('lists every invalid variable once, in alphabetical order', () => {
    const error = captureError({ PORT: 'abc', NODE_ENV: 'staging', REFRESH_TOKEN_TTL_DAYS: '0' });

    expect(error.variables).toEqual([
      'JWT_ACCESS_SECRET',
      'NODE_ENV',
      'PORT',
      'REFRESH_TOKEN_TTL_DAYS',
    ]);
  });

  it('never includes variable values in the error message', () => {
    const leakedSecret = 'short-secret-value';
    const error = captureError({ JWT_ACCESS_SECRET: leakedSecret, PORT: '99999' });

    expect(error.message).not.toContain(leakedSecret);
    expect(error.message).not.toContain('99999');
    expect(error.message).toBe('Invalid environment variables: JWT_ACCESS_SECRET, PORT');
  });
});
