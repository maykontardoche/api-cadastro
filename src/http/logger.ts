import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { pino, type DestinationStream, type LevelWithSilent, type Logger } from 'pino';
import { pinoHttp, type HttpLogger } from 'pino-http';

/**
 * Defense in depth: request logs already use an allowlist serializer (no headers, no body),
 * but anything logged by application code is still scrubbed of these keys.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...[
    'password',
    'currentPassword',
    'newPassword',
    'refreshToken',
    'accessToken',
    'passwordHash',
  ].flatMap((key) => [key, `*.${key}`]),
];

export function createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'api-cadastro' },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

function pathOnly(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}

/** Request log with a server-generated id, echoed in X-Request-Id; the client's id is ignored. */
export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    genReqId: (_req: IncomingMessage, res: ServerResponse) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : 'info'),
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
    serializers: {
      req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
        id: req.id,
        method: req.method,
        path: pathOnly(req.url),
        remoteAddress: req.remoteAddress,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
