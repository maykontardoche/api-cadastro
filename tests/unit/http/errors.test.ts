import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Prisma } from '../../../src/generated/prisma/client.js';
import {
  AppError,
  errorCatalog,
  toAppError,
  toErrorBody,
  zodIssuesToDetails,
} from '../../../src/http/errors.js';

function bodyParserError(type: string, status: number): Error {
  return Object.assign(new Error('raw parser message with user input'), { type, status });
}

function zodErrorOf(schema: z.ZodType, input: unknown): z.ZodError {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected a validation failure');
  return result.error;
}

describe('AppError', () => {
  it('takes status and pt-BR message from the catalog', () => {
    const error = new AppError('EMAIL_TAKEN');

    expect(error.status).toBe(409);
    expect(error.message).toBe(errorCatalog.EMAIL_TAKEN.message);
  });
});

describe('toErrorBody', () => {
  it('builds the envelope with the request id', () => {
    expect(toErrorBody(new AppError('NOT_FOUND'), 'req-1')).toEqual({
      error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.', requestId: 'req-1' },
    });
  });

  it('omits details when there are none', () => {
    const body = toErrorBody(new AppError('VALIDATION_ERROR', []), 'req-1');

    expect(body.error).not.toHaveProperty('details');
  });
});

describe('zodIssuesToDetails', () => {
  const schema = z.strictObject({ email: z.email(), profile: z.object({ name: z.string() }) });

  it('reports body fields by bare name and nested ones by dotted path', () => {
    const error = zodErrorOf(schema, { email: 'x', profile: { name: 1 } });

    expect(zodIssuesToDetails(error.issues)).toEqual([
      { field: 'email', code: 'invalid_format' },
      { field: 'profile.name', code: 'invalid_type' },
    ]);
  });

  it('reports each unknown key as its own field', () => {
    const error = zodErrorOf(schema, {
      email: 'a@b.co',
      profile: { name: 'a' },
      role: 'ADMIN',
      x: 1,
    });

    expect(zodIssuesToDetails(error.issues)).toEqual([
      { field: 'role', code: 'unrecognized_key' },
      { field: 'x', code: 'unrecognized_key' },
    ]);
  });

  it('prefixes query and params fields', () => {
    const error = zodErrorOf(z.strictObject({ limit: z.number() }), { limit: 'a' });

    expect(zodIssuesToDetails(error.issues, 'query')).toEqual([
      { field: 'query.limit', code: 'invalid_type' },
    ]);
  });

  it('names a root-level body issue "body"', () => {
    const error = zodErrorOf(z.strictObject({}), 'not an object');

    expect(zodIssuesToDetails(error.issues)).toEqual([{ field: 'body', code: 'invalid_type' }]);
  });
});

describe('toAppError', () => {
  it('passes AppError through untouched', () => {
    const error = new AppError('FORBIDDEN');

    expect(toAppError(error)).toBe(error);
  });

  it('maps a ZodError to VALIDATION_ERROR with details', () => {
    const error = toAppError(zodErrorOf(z.strictObject({ a: z.string() }), {}));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ field: 'a', code: 'invalid_type' }]);
  });

  it('maps malformed JSON to VALIDATION_ERROR without echoing the parser message', () => {
    const error = toAppError(bodyParserError('entity.parse.failed', 400));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ field: 'body', code: 'invalid_json' }]);
    expect(error.message).not.toContain('user input');
  });

  it('maps an oversized body to PAYLOAD_TOO_LARGE', () => {
    expect(toAppError(bodyParserError('entity.too.large', 413)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('maps other client-side body errors to VALIDATION_ERROR', () => {
    expect(toAppError(bodyParserError('charset.unsupported', 415)).details).toEqual([
      { field: 'body', code: 'invalid_body' },
    ]);
  });

  it('maps the router URIError for a malformed path to VALIDATION_ERROR, not INTERNAL', () => {
    const error = Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), {
      status: 400,
    });

    const mapped = toAppError(error);

    expect(mapped.code).toBe('VALIDATION_ERROR');
    expect(mapped.details).toEqual([{ field: 'params', code: 'invalid_encoding' }]);
    expect(mapped.message).not.toContain('%E0');
  });

  it('maps any other error that carries a 4xx status to VALIDATION_ERROR', () => {
    const error = Object.assign(new Error('client mistake'), { status: 400 });

    expect(toAppError(error).details).toEqual([{ field: 'request', code: 'invalid_request' }]);
  });

  it('does not treat an error with a 5xx status as a client error', () => {
    const error = Object.assign(new Error('upstream failed'), { status: 502 });

    expect(toAppError(error).code).toBe('INTERNAL');
  });

  it('maps a Prisma unique violation (P2002) to CONFLICT', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on email', {
      code: 'P2002',
      clientVersion: '7.10.1',
    });

    expect(toAppError(error).code).toBe('CONFLICT');
  });

  it('maps other Prisma errors and unknown errors to INTERNAL', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '7.10.1',
    });

    expect(toAppError(prismaError).code).toBe('INTERNAL');
    expect(toAppError(new Error('SELECT * FROM users')).code).toBe('INTERNAL');
    expect(toAppError('a thrown string').code).toBe('INTERNAL');
  });

  it('never exposes the original message of an internal error', () => {
    expect(toAppError(new Error('connection to 10.0.0.5 failed')).message).toBe(
      errorCatalog.INTERNAL.message,
    );
  });
});
