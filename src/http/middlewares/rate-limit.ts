import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { AppError } from '../errors.js';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

const FIFTEEN_MINUTES_MS = 15 * 60_000;

export const DEFAULT_GLOBAL_RATE_LIMIT: RateLimitOptions = {
  limit: 300,
  windowMs: FIFTEEN_MINUTES_MS,
};

/** Stricter limit for credential endpoints (register, login, refresh, change-password). */
export const DEFAULT_AUTH_RATE_LIMIT: RateLimitOptions = {
  limit: 20,
  windowMs: FIFTEEN_MINUTES_MS,
};

/**
 * Per-IP limiter with the in-memory store: correct for a single instance only. Running more than
 * one instance requires a shared store.
 */
export function createRateLimiter({ limit, windowMs }: RateLimitOptions): RequestHandler {
  return rateLimit({
    limit,
    windowMs,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED'));
    },
  });
}
