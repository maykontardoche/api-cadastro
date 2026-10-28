import { createPrismaClient } from '../../src/db/prisma.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Integration tests run against the disposable `db-test` container (compose.yaml).
 * TEST_DATABASE_URL overrides it (CI service container); the default credentials are the
 * local-only ones from compose.yaml and never reach a shared database.
 */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const url = new URL('postgresql://127.0.0.1:5433/api_cadastro_test');
  url.username = 'app';
  url.password = 'app_local_only';
  return url.toString();
}

export function createTestPrisma(): PrismaClient {
  return createPrismaClient(testDatabaseUrl());
}

/** Empties every table. Guarded so it can never run against a non-test database. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const [{ name }] = await prisma.$queryRaw<[{ name: string }]>`SELECT current_database() AS name`;
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset "${name}": not a test database`);
  }
  await prisma.$executeRaw`TRUNCATE TABLE refresh_sessions, users CASCADE`;
}
