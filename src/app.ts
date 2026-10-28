import express, { type Express } from 'express';

import { createHealthRouter, type HealthDeps } from './modules/health/health.routes.js';

export type AppDeps = HealthDeps;

/** Builds the Express app without opening a port, so tests can drive it directly. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use('/health', createHealthRouter(deps));

  return app;
}
