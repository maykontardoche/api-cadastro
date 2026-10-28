import { Router } from 'express';

import { passesWithin, type DependencyCheck } from './passes-within.js';

export interface HealthDeps {
  checkDatabase: DependencyCheck;
  readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export function createHealthRouter({
  checkDatabase,
  readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
}: HealthDeps): Router {
  const router = Router();

  // Liveness never touches dependencies: it only says the process is serving requests.
  router.get('/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness reports only up/down per dependency — never the error or the connection details.
  router.get('/ready', async (_req, res) => {
    const databaseUp = await passesWithin(checkDatabase, readinessTimeoutMs);
    const state = databaseUp ? 'ok' : 'unavailable';
    res.status(databaseUp ? 200 : 503).json({ status: state, checks: { database: state } });
  });

  return router;
}
