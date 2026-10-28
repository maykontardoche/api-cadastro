import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '../../../src/config/env.js';

// Fictitious credentials: these URLs never reach a real database.
const validSecret = 'a'.repeat(32);
const databaseUrl = 'postgresql://example:EXAMPLE@127.0.0.1:5432/api_cadastro';
const required = { JWT_ACCESS_SECRET: validSecret, DATABASE_URL: databaseUrl };

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
  it('applies defaults when only the required variables are set', () => {
    const env = parseEnv(required);

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: databaseUrl,
      JWT_ACCESS_SECRET: validSecret,
      JWT_ISSUER: 'api-cadastro',
      JWT_AUDIENCE: 'api-cadastro-client',
      REFRESH_TOKEN_TTL_DAYS: 30,
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      TRUST_PROXY: false,
    });
  });

  it('parses CORS_ORIGINS into normalized origins', () => {
    const env = parseEnv({
      ...required,
      CORS_ORIGINS: ' http://localhost:5173/ , https://app.example.com/path ',
    });

    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it.each(['not-an-origin', 'javascript:alert(1)', 'http://ok.example,ftp://files.example'])(
    'rejects CORS_ORIGINS=%s',
    (origins) => {
      expect(captureError({ ...required, CORS_ORIGINS: origins }).variables).toEqual([
        'CORS_ORIGINS',
      ]);
    },
  );

  it.each([
    ['false', false],
    ['0', 0],
    ['1', 1],
    ['2', 2],
  ])('parses TRUST_PROXY=%s', (value, expected) => {
    expect(parseEnv({ ...required, TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it.each(['true', '-1', '100', 'yes'])('rejects TRUST_PROXY=%s', (value) => {
    expect(captureError({ ...required, TRUST_PROXY: value }).variables).toEqual(['TRUST_PROXY']);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(captureError({ ...required, LOG_LEVEL: 'verbose' }).variables).toEqual(['LOG_LEVEL']);
  });

  it('coerces numeric variables', () => {
    const env = parseEnv({ ...required, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('rejects missing required variables', () => {
    expect(captureError({}).variables).toEqual(['DATABASE_URL', 'JWT_ACCESS_SECRET']);
  });

  it('accepts a secret of exactly 32 bytes and rejects 31', () => {
    expect(() => parseEnv({ ...required, JWT_ACCESS_SECRET: 'a'.repeat(32) })).not.toThrow();
    expect(captureError({ ...required, JWT_ACCESS_SECRET: 'a'.repeat(31) }).variables).toEqual([
      'JWT_ACCESS_SECRET',
    ]);
  });

  it('counts secret length in bytes, not characters', () => {
    // 16 two-byte characters = 32 bytes
    expect(() => parseEnv({ ...required, JWT_ACCESS_SECRET: 'é'.repeat(16) })).not.toThrow();
  });

  it.each([
    'postgres://example:EXAMPLE@localhost/db',
    'postgresql://example:EXAMPLE@localhost:5432/db?schema=public',
  ])('accepts DATABASE_URL=%s', (url) => {
    expect(parseEnv({ ...required, DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it.each(['not-a-url', 'mysql://example:EXAMPLE@localhost/db', 'http://localhost:5432'])(
    'rejects DATABASE_URL=%s',
    (url) => {
      expect(captureError({ ...required, DATABASE_URL: url }).variables).toEqual(['DATABASE_URL']);
    },
  );

  it.each(['abc', '0', '70000', '3000.5'])('rejects PORT=%s', (port) => {
    expect(captureError({ ...required, PORT: port }).variables).toEqual(['PORT']);
  });

  it('lists every invalid variable once, in alphabetical order', () => {
    const error = captureError({ PORT: 'abc', NODE_ENV: 'staging', REFRESH_TOKEN_TTL_DAYS: '0' });

    expect(error.variables).toEqual([
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'NODE_ENV',
      'PORT',
      'REFRESH_TOKEN_TTL_DAYS',
    ]);
  });

  it('never includes variable values in the error message', () => {
    const leakedSecret = 'short-secret-value';
    const error = captureError({
      JWT_ACCESS_SECRET: leakedSecret,
      DATABASE_URL: 'mysql://example:EXAMPLE_LEAK_MARKER@db/x',
      PORT: '99999',
    });

    expect(error.message).not.toContain(leakedSecret);
    expect(error.message).not.toContain('EXAMPLE_LEAK_MARKER');
    expect(error.message).not.toContain('99999');
    expect(error.message).toBe(
      'Invalid environment variables: DATABASE_URL, JWT_ACCESS_SECRET, PORT',
    );
  });
});
