import type { OpenAPIRegistry, ResponseConfig } from '@asteasolutions/zod-to-openapi';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';

import { errorBodySchema } from './errors.js';
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
  /** Runs before validation (e.g. rate limiter, authentication). */
  middlewares?: RequestHandler[];
  handler: (input: ValidatedOf<S>, req: Request, res: Response) => Promise<void> | void;
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

  return {
    method: spec.method,
    path: spec.path,
    mount: (router) => {
      router[spec.method](
        spec.path,
        ...(spec.middlewares ?? []),
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
      for (const [status, description] of Object.entries(spec.errors)) {
        responses[Number(status)] = {
          description,
          content: { 'application/json': { schema: errorBodySchema } },
        };
      }
      registry.registerPath({
        method: spec.method,
        path: toOpenApiPath(prefix + spec.path),
        tags: spec.tags,
        summary: spec.summary,
        ...(spec.description ? { description: spec.description } : {}),
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

export function mountRoutes(router: Router, routes: readonly RouteDefinition[]): Router {
  for (const route of routes) route.mount(router);
  return router;
}
