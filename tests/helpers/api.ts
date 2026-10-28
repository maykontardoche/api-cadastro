import { createApiRoutes, type ApiRoutesDeps } from '../../src/api-routes.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { RouteDefinition } from '../../src/http/route.js';

/** Fictitious signing config for tests only (EXAMPLE secret, never used outside the suite). */
export const TEST_TOKEN_CONFIG = {
  secret: 'EXAMPLE-test-only-secret-with-at-least-32-bytes',
  issuer: 'api-cadastro',
  audience: 'api-cadastro-client',
} as const;

/** Credential routes get a roomy quota so a test file can register and log in freely. */
export const ROOMY_RATE_LIMIT = { limit: 1_000, windowMs: 60_000 };

export function buildTestApiRoutes(
  prisma: PrismaClient,
  overrides: Partial<Omit<ApiRoutesDeps, 'prisma'>> = {},
): RouteDefinition[] {
  return createApiRoutes({
    prisma,
    tokens: TEST_TOKEN_CONFIG,
    refreshTtlDays: 30,
    authRateLimit: ROOMY_RATE_LIMIT,
    ...overrides,
  });
}
