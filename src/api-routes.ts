import type { PrismaClient } from './generated/prisma/client.js';
import {
  createRateLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  type RateLimitOptions,
} from './http/middlewares/rate-limit.js';
import type { RouteDefinition } from './http/route.js';
import { createAuthRoutes } from './modules/auth/auth.routes.js';
import { hashPassword } from './modules/auth/password.js';
import { createUserRepository } from './modules/users/user.repository.js';
import { createUserService } from './modules/users/user.service.js';

export interface ApiRoutesDeps {
  prisma: PrismaClient;
  authRateLimit?: RateLimitOptions;
}

/** Wires services into every /api/v1 route; the same list feeds Express and the OpenAPI document. */
export function createApiRoutes({
  prisma,
  authRateLimit = DEFAULT_AUTH_RATE_LIMIT,
}: ApiRoutesDeps): RouteDefinition[] {
  const userService = createUserService({ users: createUserRepository(prisma), hashPassword });
  const authLimiter = createRateLimiter(authRateLimit);

  return [...createAuthRoutes({ userService, authLimiter })];
}
