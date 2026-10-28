import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';

import { createApiRoutes } from '../../../src/api-routes.js';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import { errorCatalog, type ErrorCode } from '../../../src/http/errors.js';
import { API_PREFIX, buildOpenApiDocument } from '../../../src/http/openapi.js';
import { TEST_TOKEN_CONFIG } from '../../helpers/api.js';

// Building the document never touches the database, so no client is needed.
const document = buildOpenApiDocument(
  createApiRoutes({ prisma: {} as PrismaClient, tokens: TEST_TOKEN_CONFIG, refreshTtlDays: 30 }),
);

interface Operation {
  summary?: string;
  description?: string;
  requestBody?: unknown;
  parameters?: { in: string }[];
  responses: Record<
    string,
    {
      description: string;
      content?: Record<
        string,
        { schema?: { $ref?: string }; example?: { error?: { code?: string } } }
      >;
    }
  >;
}

const apiOperations = Object.entries(document.paths ?? {})
  .filter(([path]) => path.startsWith(API_PREFIX))
  .flatMap(([path, item]) =>
    Object.entries(item as Record<string, Operation>).map(([method, operation]) => ({
      name: `${method.toUpperCase()} ${path}`,
      operation,
    })),
  );

describe('OpenAPI document', () => {
  it('is valid against the official OpenAPI 3.1 schema', async () => {
    const validator = new Validator();
    const result = await validator.validate(
      JSON.parse(JSON.stringify(document)) as Record<string, unknown>,
    );

    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('documents every /api/v1 operation with a summary and a description', () => {
    expect(apiOperations.length).toBeGreaterThan(10);
    for (const { name, operation } of apiOperations) {
      expect(operation.summary, name).toBeTruthy();
      expect(operation.description, name).toBeTruthy();
    }
  });

  it('documents the responses every /api/v1 route can give', () => {
    for (const { name, operation } of apiOperations) {
      expect(Object.keys(operation.responses), name).toEqual(
        expect.arrayContaining(['429', '500']),
      );
      if (operation.requestBody) {
        expect(Object.keys(operation.responses), name).toEqual(
          expect.arrayContaining(['400', '413']),
        );
      }
      if (operation.parameters?.some((parameter) => parameter.in === 'path')) {
        expect(Object.keys(operation.responses), name).toContain('400');
      }
    }
  });

  it('describes every error response with the shared ErrorResponse envelope', () => {
    for (const { name, operation } of apiOperations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) continue;
        expect(response.content?.['application/json']?.schema?.$ref, `${name} ${status}`).toBe(
          '#/components/schemas/ErrorResponse',
        );
      }
    }
  });

  it('gives every error response an example whose code matches its status and description', () => {
    for (const { name, operation } of apiOperations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) continue;
        const code = response.content?.['application/json']?.example?.error?.code as
          ErrorCode | undefined;
        expect(code, `${name} ${status}`).toBeDefined();
        expect(errorCatalog[code as ErrorCode].status, `${name} ${status}`).toBe(Number(status));
        const named = [...response.description.matchAll(/`([A-Z_]+)`/g)]
          .map((match) => match[1])
          .filter(
            (candidate) =>
              candidate !== undefined &&
              candidate in errorCatalog &&
              errorCatalog[candidate as ErrorCode].status === Number(status),
          );
        if (named.length > 0) expect(named, `${name} ${status}`).toContain(code);
      }
    }
  });

  it('shows LAST_ADMIN, not VALIDATION_ERROR, as the 409 example of a role change', () => {
    const roleChange = apiOperations.find(({ name }) => name === 'PATCH /api/v1/users/{id}/role');
    expect(
      roleChange?.operation.responses['409']?.content?.['application/json']?.example?.error?.code,
    ).toBe('LAST_ADMIN');
  });

  it('gives every success response with a body a schema', () => {
    for (const { name, operation } of apiOperations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) >= 300 || !response.content) continue;
        expect(response.content['application/json']?.schema, `${name} ${status}`).toBeDefined();
      }
    }
  });

  it('has an example for every field of the public user and of every request body', () => {
    const schemas = (document.components?.schemas ?? {}) as Record<
      string,
      { properties?: Record<string, { example?: unknown }> }
    >;
    for (const component of [
      'PublicUser',
      'RegisterRequest',
      'LoginRequest',
      'RefreshTokenRequest',
      'ChangePasswordRequest',
      'UpdateProfileRequest',
      'ChangeRoleRequest',
    ]) {
      for (const [field, property] of Object.entries(schemas[component]?.properties ?? {})) {
        expect(property.example, `${component}.${field}`).toBeDefined();
      }
    }
  });
});
