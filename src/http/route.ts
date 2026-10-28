import type { OpenAPIRegistry, ResponseConfig } from '@asteasolutions/zod-to-openapi';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';

import type { Role } from '../generated/prisma/client.js';
import { currentUserOf } from './current-user.js';
import {
  AppError,
  errorBodySchema,
  errorCatalog,
  type ErrorBody,
  type ErrorCode,
} from './errors.js';
import {
  createValidation,
  type ValidatedOf,
  type ValidationSchemas,
} from './middlewares/validate.js';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

export interface RouteResponse {
  description: string;
  schema?: z.ZodType;
}

export interface RouteSpec<S extends ValidationSchemas> {
  method: HttpMethod;
  /** Express syntax (`/users/:id`), relative to the router it is mounted on. */
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  schemas: S;
  /** Success response (2xx) and the error codes this route can answer with. */
  success: { status: number } & RouteResponse;
  errors: Partial<Record<400 | 401 | 403 | 404 | 409 | 413 | 429 | 500, string>>;
  /** Runs before authentication and validation (e.g. rate limiter). */
  middlewares?: RequestHandler[];
  /**
   * Required on purpose, so no route becomes public by omission. `'public'` is an explicit
   * choice; a middleware makes the route require a bearer access token — it runs after
   * `middlewares`, marks the operation as secured in the OpenAPI document and documents the 401.
   */
  access: 'public' | RequestHandler;
  /**
   * Role the authenticated user must have, checked right after authentication against the role
   * re-read from the database (never the token). Requires a non-public `access`.
   */
  requireRole?: Role;
  handler: (input: ValidatedOf<S>, req: Request, res: Response) => Promise<void> | void;
}

/** Name of the security scheme registered in the OpenAPI document. */
export const BEARER_AUTH = 'bearerAuth';
/** OpenAPI extension that marks the role an operation requires (checked by the contract test). */
export const REQUIRED_ROLE_EXTENSION = 'x-required-role';
const FORBIDDEN_DESCRIPTION = '`FORBIDDEN`: o usuário autenticado não tem o papel exigido.';
const UNAUTHORIZED_DESCRIPTION =
  '`UNAUTHORIZED`: token ausente, inválido, expirado ou de uma conta que não existe mais.';
// Responses documented here so no route forgets them: 429 and 500 on every route, 413 on every
// route with a body. A route's own `errors` entry for the same status wins.
const PAYLOAD_TOO_LARGE_DESCRIPTION =
  '`PAYLOAD_TOO_LARGE`: corpo acima de 100 KiB (recusado antes da autenticação).';
const RATE_LIMITED_DESCRIPTION =
  '`RATE_LIMITED`: limite global de requisições por IP excedido (cabeçalhos `RateLimit` e `RateLimit-Policy`).';
const INTERNAL_DESCRIPTION =
  '`INTERNAL`: falha inesperada; a mensagem é genérica e o `requestId` liga a resposta ao log.';

/** Code an error example falls back to when its description names none. */
const DEFAULT_ERROR_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
};
const EXAMPLE_REQUEST_ID = '0192f3a1-0000-7000-8000-00000000e001';

/**
 * Example body of a documented error, so the Swagger UI does not show the first enum value
 * (`VALIDATION_ERROR`) on every status: the first catalog code of that status the description
 * names between backticks, else the status default.
 */
export function errorExample(status: number, description: string): ErrorBody {
  const named = [...description.matchAll(/`([A-Z_]+)`/g)]
    .map((match) => match[1])
    .find(
      (code): code is ErrorCode =>
        code !== undefined &&
        code in errorCatalog &&
        errorCatalog[code as ErrorCode].status === status,
    );
  const code = named ?? DEFAULT_ERROR_CODE[status] ?? 'INTERNAL';
  return {
    error: {
      code,
      message: errorCatalog[code].message,
      requestId: EXAMPLE_REQUEST_ID,
      ...(code === 'VALIDATION_ERROR'
        ? { details: [{ field: 'email', code: 'invalid_format' }] }
        : {}),
    },
  };
}

/** One declaration feeds both the Express route and its OpenAPI operation, so they cannot drift. */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  mount: (router: Router) => void;
  document: (registry: OpenAPIRegistry, prefix: string) => void;
}

/** `/users/:id` → `/users/{id}` */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, '{$1}');
}

export function defineRoute<S extends ValidationSchemas>(spec: RouteSpec<S>): RouteDefinition {
  const validation = createValidation(spec.schemas);
  const authenticate = spec.access === 'public' ? undefined : spec.access;
  if (spec.requireRole && !authenticate) {
    throw new Error(`${spec.method} ${spec.path}: requireRole needs an authenticated route`);
  }
  const authorize = spec.requireRole ? requireRole(spec.requireRole) : undefined;

  return {
    method: spec.method,
    path: spec.path,
    mount: (router) => {
      router[spec.method](
        spec.path,
        ...(spec.middlewares ?? []),
        ...(authenticate ? [authenticate] : []),
        ...(authorize ? [authorize] : []),
        validation.middleware,
        async (req, res) => {
          await spec.handler(validation.read(res), req, res);
        },
      );
    },
    document: (registry, prefix) => {
      const responses: Record<number, ResponseConfig> = {
        [spec.success.status]: {
          description: spec.success.description,
          ...(spec.success.schema
            ? { content: { 'application/json': { schema: spec.success.schema } } }
            : {}),
        },
      };
      const errors = {
        ...(authenticate ? { 401: UNAUTHORIZED_DESCRIPTION } : {}),
        ...(authorize ? { 403: FORBIDDEN_DESCRIPTION } : {}),
        ...(spec.schemas.body ? { 413: PAYLOAD_TOO_LARGE_DESCRIPTION } : {}),
        429: RATE_LIMITED_DESCRIPTION,
        500: INTERNAL_DESCRIPTION,
        ...spec.errors,
      };
      for (const [status, description] of Object.entries(errors)) {
        responses[Number(status)] = {
          description,
          content: {
            'application/json': {
              schema: errorBodySchema,
              example: errorExample(Number(status), description),
            },
          },
        };
      }
      registry.registerPath({
        method: spec.method,
        path: toOpenApiPath(prefix + spec.path),
        tags: spec.tags,
        summary: spec.summary,
        ...(spec.description ? { description: spec.description } : {}),
        ...(authenticate ? { security: [{ [BEARER_AUTH]: [] }] } : {}),
        ...(spec.requireRole ? { [REQUIRED_ROLE_EXTENSION]: spec.requireRole } : {}),
        request: {
          ...(spec.schemas.body
            ? { body: { content: { 'application/json': { schema: spec.schemas.body } } } }
            : {}),
          ...(spec.schemas.query ? { query: spec.schemas.query as z.ZodObject } : {}),
          ...(spec.schemas.params ? { params: spec.schemas.params as z.ZodObject } : {}),
        },
        responses,
      });
    },
  };
}

/** 403 unless the authenticated user (as re-read by authentication) has the role. */
function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (currentUserOf(res).role !== role) throw new AppError('FORBIDDEN');
    next();
  };
}

export function mountRoutes(router: Router, routes: readonly RouteDefinition[]): Router {
  for (const route of routes) route.mount(router);
  return router;
}
