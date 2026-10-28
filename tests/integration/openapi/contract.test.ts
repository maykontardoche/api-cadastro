import type { Express } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { buildTestApiRoutes } from '../../helpers/api.js';
import type { ErrorBody } from '../../../src/http/errors.js';
import { API_PREFIX, type OpenApiDocument } from '../../../src/http/openapi.js';
import { toOpenApiPath } from '../../../src/http/route.js';
import { buildTestApp } from '../../helpers/app.js';
import { createTestPrisma } from '../../helpers/db.js';

const prisma = createTestPrisma();
const apiRoutes = buildTestApiRoutes(prisma);
const app = buildTestApp({ apiRoutes });

/** Routes that serve the documentation itself and are not part of it. */
const DOCS_ROUTES = ['get /openapi.json'];

async function fetchDocument(): Promise<OpenApiDocument> {
  const response = await request(app).get('/openapi.json');
  expect(response.status).toBe(200);
  return response.body as OpenApiDocument;
}

function operationsOf(document: OpenApiDocument): string[] {
  return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method} ${path}`),
  );
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
}

/**
 * Every route Express actually has, read from its router stack. Express 5 does not keep the mount
 * path of sub-routers, so routes are compared by their path inside the router that holds them.
 */
function routesMountedIn(target: Express): string[] {
  const walk = (stack: ExpressLayer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route) {
        const { path, methods } = layer.route;
        return Object.keys(methods).map((method) => `${method} ${toOpenApiPath(path)}`);
      }
      return layer.handle?.stack ? walk(layer.handle.stack) : [];
    });
  return walk((target as unknown as { router: { stack: ExpressLayer[] } }).router.stack).sort();
}

/** Documented operations with the mount prefix removed, comparable to routesMountedIn. */
function documentedRelative(document: OpenApiDocument): string[] {
  return operationsOf(document)
    .map((operation) => operation.replace(` ${API_PREFIX}/`, ' /').replace(' /health/', ' /'))
    .concat(DOCS_ROUTES)
    .sort();
}

describe('OpenAPI document', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is served as OpenAPI 3.1', async () => {
    const document = await fetchDocument();

    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.info.title).toBe('API Cadastro');
  });

  it('documents exactly the routes Express has mounted — no more, no less', async () => {
    expect(routesMountedIn(app)).toEqual(documentedRelative(await fetchDocument()));
  });

  it('would catch a route mounted without documentation', async () => {
    const drifted = buildTestApp({ apiRoutes });
    drifted.get('/api/v1/undocumented', (_req, res) => {
      res.status(200).end();
    });

    expect(routesMountedIn(drifted)).not.toEqual(documentedRelative(await fetchDocument()));
    expect(routesMountedIn(drifted)).toContain('get /api/v1/undocumented');
  });

  it('documents every API route under the /api/v1 prefix', async () => {
    const documented = operationsOf(await fetchDocument());

    for (const route of apiRoutes) {
      expect(documented).toContain(`${route.method} ${toOpenApiPath(API_PREFIX + route.path)}`);
    }
  });

  it('has every documented API route actually mounted (no 404 NOT_FOUND from the fallback)', async () => {
    for (const route of apiRoutes) {
      const path = API_PREFIX + route.path.replace(/:\w+/g, '00000000-0000-7000-8000-000000000000');
      const response = await request(app)[route.method](path).send({});
      expect((response.body as Partial<ErrorBody>).error?.code, `${route.method} ${path}`).not.toBe(
        'NOT_FOUND',
      );
    }
  });

  it('keeps public only the routes that are meant to be public', async () => {
    const document = await fetchDocument();
    const publicOperations = Object.entries(document.paths ?? {})
      .filter(([path]) => path.startsWith(API_PREFIX))
      .flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([, operation]) => !(operation as { security?: unknown }).security)
          .map(([method]) => `${method} ${path}`),
      )
      .sort();

    // Adding a public route is a deliberate decision: it must be added here too.
    expect(publicOperations).toEqual(['post /api/v1/auth/login', 'post /api/v1/auth/register']);
  });

  it('answers 401 without a token on every secured route, and documents it', async () => {
    const document = await fetchDocument();
    const secured = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => (operation as { security?: unknown }).security)
        .map(([method, operation]) => ({
          method,
          path,
          operation: operation as { responses: object },
        })),
    );

    expect(secured.length).toBeGreaterThan(0);
    for (const { method, path, operation } of secured) {
      expect(operation.responses, `${method} ${path}`).toHaveProperty('401');
      const concretePath = path.replace(/\{\w+\}/g, '00000000-0000-7000-8000-000000000000');
      const response = await request(app)[method as 'get'](concretePath).send({});
      expect(response.status, `${method} ${path}`).toBe(401);
      expect((response.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
    }
  });

  it('describes errors with the shared ErrorResponse schema', async () => {
    const document = await fetchDocument();
    const register = document.paths?.['/api/v1/auth/register']?.post;

    expect(register?.responses?.['409']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    });
    expect(document.components?.schemas).toHaveProperty('ErrorResponse');
    expect(document.components?.schemas).toHaveProperty('PublicUser');
  });

  it('contains no real-looking tokens or credentials in examples', async () => {
    const text = JSON.stringify(await fetchDocument());

    expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
    expect(text).not.toMatch(/\$argon2/);
  });
});

describe('Swagger UI', () => {
  it('is served at /docs', async () => {
    const response = await request(app).get('/docs/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('swagger-ui');
  });
});
