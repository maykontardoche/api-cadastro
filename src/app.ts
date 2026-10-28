import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import { createHttpLogger } from './http/logger.js';
import { errorHandler, notFound } from './http/middlewares/error-handler.js';
import {
  createRateLimiter,
  DEFAULT_GLOBAL_RATE_LIMIT,
  type RateLimitOptions,
} from './http/middlewares/rate-limit.js';
import { API_PREFIX, buildOpenApiDocument, createDocsRouter } from './http/openapi.js';
import { mountRoutes, type RouteDefinition } from './http/route.js';
import { createHealthRouter, type HealthDeps } from './modules/health/health.routes.js';

const JSON_BODY_LIMIT = '100kb';

export interface AppDeps extends HealthDeps {
  logger: Logger;
  corsOrigins: string[];
  trustProxy: false | number;
  globalRateLimit?: RateLimitOptions;
  /** Every /api/v1 route; each one is also documented in /openapi.json and /docs. */
  apiRoutes?: readonly RouteDefinition[];
}

/** Builds the Express app without opening a port, so tests can drive it directly. */
export function createApp(deps: AppDeps): Express {
  const apiRoutes = deps.apiRoutes ?? [];
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy);

  // First, so every response — including errors from later middlewares — has X-Request-Id.
  app.use(createHttpLogger(deps.logger));
  app.use(helmet());

  // Health probes stay outside the rate limit so orchestrators are never throttled.
  app.use('/health', createHealthRouter(deps));

  // CORS after the limiter, so preflight requests count against the quota too.
  app.use(createRateLimiter(deps.globalRateLimit ?? DEFAULT_GLOBAL_RATE_LIMIT));
  app.use(cors({ origin: deps.corsOrigins }));
  app.use(createDocsRouter(buildOpenApiDocument(apiRoutes)));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(API_PREFIX, mountRoutes(Router(), apiRoutes));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
