import { createApiRoutes } from './api-routes.js';
import { createApp } from './app.js';
import { EnvValidationError, parseEnv, type Env } from './config/env.js';
import { createPrismaClient, pingDatabase } from './db/prisma.js';
import { createLogger } from './http/logger.js';

const SHUTDOWN_DEADLINE_MS = 10_000;

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // The logger depends on the env, so this one message goes straight to stderr.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const prisma = createPrismaClient(env.DATABASE_URL, {
  onPoolError: (err) => {
    logger.error({ err }, 'database pool error');
  },
});
const app = createApp({
  logger,
  corsOrigins: env.CORS_ORIGINS,
  trustProxy: env.TRUST_PROXY,
  checkDatabase: () => pingDatabase(prisma),
  apiRoutes: createApiRoutes({
    prisma,
    tokens: {
      secret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  }),
});

// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
const server = app.listen(env.PORT, (error?: Error) => {
  if (error) {
    logger.fatal({ err: error, port: env.PORT }, 'could not start listening');
    process.exit(1);
  }
  logger.info({ port: env.PORT }, 'api listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  // Requests still in flight get a deadline; after it the process exits anyway.
  setTimeout(() => {
    logger.error('shutdown deadline exceeded, forcing exit');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  server.close(() => {
    prisma.$disconnect().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'database disconnect failed during shutdown');
        process.exit(1);
      },
    );
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
