import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ErrorBody } from '../../../src/http/errors.js';
import { createRateLimiter } from '../../../src/http/middlewares/rate-limit.js';
import { defineRoute, type RouteDefinition } from '../../../src/http/route.js';
import { ALLOWED_ORIGIN, buildTestApp, createLogCapture } from '../../helpers/app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorOf(response: request.Response): ErrorBody['error'] {
  return (response.body as ErrorBody).error;
}

/** Routes that exist only in this test, declared and mounted under /api/v1 like real modules. */
function testRoutes(): RouteDefinition[] {
  const base = { tags: ['Test'], summary: 'test route', errors: {} };
  return [
    defineRoute({
      ...base,
      method: 'post',
      path: '/echo',
      schemas: {
        body: z.strictObject({ name: z.string().min(1), password: z.string().optional() }),
        query: z.strictObject({
          page: z.coerce.number().int().min(1).optional(),
          search: z.string().optional(),
        }),
      },
      success: { status: 200, description: 'echo' },
      handler: ({ body, query }, _req, res) => {
        res.status(200).json({ body, query });
      },
    }),
    defineRoute({
      ...base,
      method: 'get',
      path: '/boom',
      schemas: {},
      success: { status: 200, description: 'never' },
      handler: () => {
        throw new Error('SELECT password_hash FROM users WHERE id = 42');
      },
    }),
    defineRoute({
      ...base,
      method: 'post',
      path: '/limited',
      schemas: {},
      middlewares: [createRateLimiter({ limit: 2, windowMs: 60_000 })],
      success: { status: 204, description: 'ok' },
      handler: (_input, _req, res) => {
        res.status(204).end();
      },
    }),
    defineRoute({
      ...base,
      method: 'get',
      path: '/items/:id',
      schemas: { params: z.strictObject({ id: z.string() }) },
      success: { status: 200, description: 'item' },
      handler: ({ params }, _req, res) => {
        res.status(200).json({ id: params.id });
      },
    }),
  ];
}

const app = buildTestApp({ apiRoutes: testRoutes() });

describe('error envelope', () => {
  it('rejects malformed JSON with 400 and the envelope', async () => {
    const response = await request(app)
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"name": ');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Os dados enviados são inválidos.',
        requestId: response.headers['x-request-id'],
        details: [{ field: 'body', code: 'invalid_json' }],
      },
    });
  });

  it('rejects unknown body fields and invalid query in a single 400', async () => {
    const response = await request(app)
      .post('/api/v1/echo?page=0')
      .send({ name: 'Ana', role: 'ADMIN' });

    expect(response.status).toBe(400);
    expect(errorOf(response).details).toEqual([
      { field: 'role', code: 'unrecognized_key' },
      { field: 'query.page', code: 'too_small' },
    ]);
  });

  it('passes parsed values to the handler', async () => {
    const response = await request(app).post('/api/v1/echo?page=2').send({ name: 'Ana' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ body: { name: 'Ana' }, query: { page: 2 } });
  });

  it('rejects a body above 100 kB with 413', async () => {
    const response = await request(app)
      .post('/api/v1/echo')
      .send({ name: 'x'.repeat(101 * 1024) });

    expect(response.status).toBe(413);
    expect(errorOf(response).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers unknown routes with 404 in the envelope', async () => {
    const response = await request(app).get('/api/v1/nope');

    expect(response.status).toBe(404);
    expect(errorOf(response)).toMatchObject({
      code: 'NOT_FOUND',
      requestId: response.headers['x-request-id'] as string,
    });
  });

  it('answers a malformed percent-encoded path with 400, not 500', async () => {
    const response = await request(app).get('/api/v1/items/%E0%A4%A');

    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'params', code: 'invalid_encoding' }],
    });
    expect(response.text).not.toContain('%E0');
  });

  it('answers an unexpected error with a generic 500 and no internals', async () => {
    const response = await request(app).get('/api/v1/boom');

    expect(response.status).toBe(500);
    expect(errorOf(response)).toMatchObject({
      code: 'INTERNAL',
      message: 'Erro interno. Tente novamente mais tarde.',
    });
    for (const leak of ['SELECT', 'password_hash', 'stack', 'at ', '.ts']) {
      expect(response.text).not.toContain(leak);
    }
  });
});

describe('request id', () => {
  it('generates an id, echoes it in X-Request-Id and puts it in the error body', async () => {
    const response = await request(app).get('/api/v1/nope');

    expect(response.headers['x-request-id']).toMatch(UUID);
    expect(errorOf(response).requestId).toBe(response.headers['x-request-id']);
  });

  it('ignores an id sent by the client', async () => {
    const response = await request(app).get('/health/live').set('X-Request-Id', 'client-chosen');

    expect(response.headers['x-request-id']).toMatch(UUID);
    expect(response.headers['x-request-id']).not.toBe('client-chosen');
  });

  it('gives every request a different id', async () => {
    const [a, b] = await Promise.all([
      request(app).get('/health/live'),
      request(app).get('/health/live'),
    ]);

    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('rate limiting', () => {
  it('answers 429 in the envelope once a route limiter is exhausted', async () => {
    const limitedApp = buildTestApp({ apiRoutes: testRoutes() });
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await request(limitedApp).post('/api/v1/limited')).status);
    }
    const blocked = await request(limitedApp).post('/api/v1/limited');

    expect(statuses).toEqual([204, 204, 429]);
    expect(errorOf(blocked).code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
  });

  it('applies the global limit to API routes but never to health probes', async () => {
    const tightApp = buildTestApp({
      apiRoutes: testRoutes(),
      globalRateLimit: { limit: 1, windowMs: 60_000 },
    });

    await request(tightApp).get('/api/v1/nope');
    const second = await request(tightApp).get('/api/v1/nope');
    const health = await Promise.all([1, 2, 3].map(() => request(tightApp).get('/health/live')));

    expect(second.status).toBe(429);
    expect(health.map((r) => r.status)).toEqual([200, 200, 200]);
  });
});

describe('security headers and CORS', () => {
  it('sends helmet headers and hides the framework', async () => {
    const response = await request(app).get('/health/live');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a listed origin', async () => {
    const response = await request(app).get('/api/v1/nope').set('Origin', ALLOWED_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('does not allow an origin outside the allowlist', async () => {
    const response = await request(app).get('/api/v1/nope').set('Origin', 'http://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('counts CORS preflight requests against the rate limit', async () => {
    const tightApp = buildTestApp({
      apiRoutes: testRoutes(),
      globalRateLimit: { limit: 1, windowMs: 60_000 },
    });
    const preflight = () =>
      request(tightApp)
        .options('/api/v1/echo')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

    const first = await preflight();
    const second = await preflight();

    expect(first.status).toBe(204);
    expect(first.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(second.status).toBe(429);
  });
});

describe('request logging', () => {
  it('logs one structured line per request without credentials, body or query', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({ logger: capture.logger, apiRoutes: testRoutes() });

    const response = await request(loggedApp)
      .post('/api/v1/echo?search=ana@example.com')
      .set('Authorization', 'Bearer secret-access-token-xyz')
      .set('Cookie', 'session=secret-cookie-value')
      .send({ name: 'Ana', password: 'super-secret-password-123' });

    const text = capture.text();
    for (const secret of [
      'secret-access-token-xyz',
      'secret-cookie-value',
      'super-secret-password-123',
      'ana@example.com',
    ]) {
      expect(text).not.toContain(secret);
    }
    const [entry] = capture.entries();
    expect(capture.lines).toHaveLength(1);
    expect(entry).toMatchObject({
      level: 30,
      msg: 'request completed',
      req: { id: response.headers['x-request-id'], method: 'POST', path: '/api/v1/echo' },
      res: { statusCode: 200 },
    });
  });

  it('logs a 500 once, at error level, with the error but not in the response', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({ logger: capture.logger, apiRoutes: testRoutes() });

    await request(loggedApp).get('/api/v1/boom');

    const entries = capture.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 50,
      msg: 'request failed',
      res: { statusCode: 500 },
    });
    expect(entries[0]?.err).toMatchObject({ type: 'Error' });
  });

  it('logs a 4xx at info level, not as an error', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({ logger: capture.logger, apiRoutes: testRoutes() });

    await request(loggedApp).post('/api/v1/echo').send({});

    expect(capture.entries()[0]).toMatchObject({ level: 30, res: { statusCode: 400 } });
    expect(capture.entries()[0]).not.toHaveProperty('err');
  });

  it('logs a malformed path at info level, so anonymous clients cannot flood error logs', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({ logger: capture.logger, apiRoutes: testRoutes() });

    await request(loggedApp).get('/api/v1/items/%E0%A4%A');

    expect(capture.entries()[0]).toMatchObject({ level: 30, res: { statusCode: 400 } });
    expect(capture.entries()[0]).not.toHaveProperty('err');
  });

  it('redacts credentials that application code logs explicitly', () => {
    const capture = createLogCapture();

    capture.logger.info(
      { password: 'p1', user: { passwordHash: 'h1', refreshToken: 'r1' }, accessToken: 'a1' },
      'explicit log',
    );

    expect(capture.text()).not.toMatch(/"(p1|h1|r1|a1)"/);
    expect(capture.entries()[0]).toMatchObject({
      password: '[REDACTED]',
      user: { passwordHash: '[REDACTED]', refreshToken: '[REDACTED]' },
    });
  });
});
