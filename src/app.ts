import express, { type Express } from 'express';

import { healthRouter } from './modules/health/health.routes.js';

/** Builds the Express app without opening a port, so tests can drive it directly. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use('/health', healthRouter);

  return app;
}
