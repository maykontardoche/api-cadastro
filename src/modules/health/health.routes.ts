import { Router } from 'express';

export const healthRouter = Router();

// Liveness never touches dependencies: it only says the process is serving requests.
healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
