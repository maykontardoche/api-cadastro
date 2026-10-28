import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError, toAppError, toErrorBody } from '../errors.js';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND'));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const appError = toAppError(error);
  // The HTTP logger writes res.err once, on the request's completion line; 4xx are not errors.
  if (appError.status >= 500) res.err = error instanceof Error ? error : new Error(String(error));
  res.status(appError.status).json(toErrorBody(appError, requestIdOf(req.id)));
};

/** The HTTP logger always generates a string id; anything else means it is not mounted. */
function requestIdOf(id: unknown): string {
  return typeof id === 'string' ? id : 'unknown';
}
