import type { TransactionRunner } from './db/transaction.js';
import type { PrismaClient } from './generated/prisma/client.js';
import {
  createRateLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  type RateLimitOptions,
} from './http/middlewares/rate-limit.js';
import type { RouteDefinition } from './http/route.js';
import { createAuthRoutes } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createAuthenticate } from './modules/auth/authenticate.js';
import { hashPassword, verifyPassword } from './modules/auth/password.js';
import { createSessionRepository } from './modules/auth/session.repository.js';
import { createSessionService } from './modules/auth/session.service.js';
import { createTokenService, type TokenConfig } from './modules/auth/token.service.js';
import { createUserRepository } from './modules/users/user.repository.js';
import { createUserRoutes } from './modules/users/user.routes.js';
import { createUserService } from './modules/users/user.service.js';

export interface ApiRoutesDeps {
  prisma: PrismaClient;
  tokens: TokenConfig;
  refreshTtlDays: number;
  authRateLimit?: RateLimitOptions;
}

/** Wires services into every /api/v1 route; the same list feeds Express and the OpenAPI document. */
export function createApiRoutes({
  prisma,
  tokens: tokenConfig,
  refreshTtlDays,
  authRateLimit = DEFAULT_AUTH_RATE_LIMIT,
}: ApiRoutesDeps): RouteDefinition[] {
  const users = createUserRepository(prisma);
  const tokens = createTokenService(tokenConfig);
  const sessions = createSessionService({
    sessions: createSessionRepository(prisma),
    tokens,
    refreshTtlDays,
  });
  const transaction: TransactionRunner = (work) => prisma.$transaction(work);
  const userService = createUserService({
    users,
    hashPassword,
    revokeAllSessions: (userId, tx) => sessions.revokeAllForUser(userId, tx),
    transaction,
  });
  const authService = createAuthService({
    users,
    sessions,
    tokens,
    passwords: { hash: hashPassword, verify: verifyPassword },
    transaction,
  });
  const authenticate = createAuthenticate({ tokens, users });
  const authLimiter = createRateLimiter(authRateLimit);

  return [
    ...createAuthRoutes({ userService, authService, authLimiter, authenticate }),
    ...createUserRoutes({ userService, authenticate }),
  ];
}
