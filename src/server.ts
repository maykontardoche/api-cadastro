import { createApp } from './app.js';
import { EnvValidationError, parseEnv, type Env } from './config/env.js';
import { createPrismaClient, pingDatabase } from './db/prisma.js';

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const app = createApp({ checkDatabase: () => pingDatabase(prisma) });

// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
const server = app.listen(env.PORT, (error?: Error) => {
  if (error) {
    console.error(`Could not listen on port ${String(env.PORT)}: ${error.message}`);
    process.exit(1);
  }
  console.info(`API listening on port ${String(env.PORT)}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.info(`${signal} received, closing server`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
