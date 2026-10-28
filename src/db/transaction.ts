import type { Prisma } from '../generated/prisma/client.js';

/** Runs `work` in one database transaction; injected so services do not hold the client. */
export type TransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;
