import type { RequestHandler, Response } from 'express';
import type { z } from 'zod';

import { AppError, zodIssuesToDetails, type ErrorDetail } from '../errors.js';

export interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

export type ValidatedOf<S extends ValidationSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

export interface Validation<S extends ValidationSchemas> {
  /** Parses the request; any issue in body, query or params becomes a single 400. */
  middleware: RequestHandler;
  /** Typed parsed values; call only in handlers placed after `middleware`. */
  read: (res: Response) => ValidatedOf<S>;
}

/**
 * Builds the validator for a route from its schemas (use z.strictObject so unknown fields fail).
 * Parsed values live in res.locals, because Express 5 exposes req.query as read-only.
 */
export function createValidation<S extends ValidationSchemas>(schemas: S): Validation<S> {
  const middleware: RequestHandler = (req, res, next) => {
    const details: ErrorDetail[] = [];
    const validated: Record<string, unknown> = {};

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (result.success) validated.body = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues));
    }
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (result.success) validated.query = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues, 'query'));
    }
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (result.success) validated.params = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues, 'params'));
    }

    if (details.length > 0) {
      next(new AppError('VALIDATION_ERROR', details));
      return;
    }
    res.locals.validated = validated;
    next();
  };

  return { middleware, read: (res) => res.locals.validated as ValidatedOf<S> };
}
