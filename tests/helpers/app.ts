import { Writable } from 'node:stream';

import type { Express } from 'express';

import { createApp, type AppDeps } from '../../src/app.js';
import { createLogger } from '../../src/http/logger.js';

export const ALLOWED_ORIGIN = 'http://allowed.example';

/** Collects every log line the app writes, so tests can assert on (and against) its content. */
export function createLogCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      done();
    },
  });
  return {
    logger: createLogger('info', stream),
    lines,
    text: () => lines.join('\n'),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export function buildTestApp(overrides: Partial<AppDeps> = {}): Express {
  return createApp({
    logger: createLogger('silent'),
    corsOrigins: [ALLOWED_ORIGIN],
    trustProxy: false,
    checkDatabase: () => Promise.resolve(),
    ...overrides,
  });
}
