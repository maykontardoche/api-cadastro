import type { PrismaClient, RefreshSession } from '../../generated/prisma/client.js';

export interface NewSession {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface SessionRepository {
  create: (data: NewSession) => Promise<RefreshSession>;
}

export function createSessionRepository(prisma: PrismaClient): SessionRepository {
  return {
    create: (data) => prisma.refreshSession.create({ data }),
  };
}
