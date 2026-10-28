import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import { createHttpLogger } from './http/logger.js';
import { errorHandler, notFound } from './http/middlewares/error-handler.js';
import {
  createRateLimiter,
  DEFAULT_GLOBAL_RATE_LIMIT,
  type RateLimitOptions,
} from './http/middlewares/rate-limit.js';
import { createHealthRouter, type HealthDeps } from './modules/health/health.routes.js';

const JSON_BODY_LIMIT = '100kb';

export interface AppDeps extends HealthDeps {
  logger: Logger;
  corsOrigins: string[];
  trustProxy: false | number;
  globalRateLimit?: RateLimitOptions;
  /** Routes mounted under /api/v1, behind the global rate limit and the JSON parser. */
  apiRouter?: Router;
}

/** Builds the Express app without opening a port, so tests can drive it directly. */
export function createApp(deps: AppDeps): Express {
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
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  if (deps.apiRouter) app.use('/api/v1', deps.apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
