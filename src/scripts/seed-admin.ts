import { AdminSeedError, seedAdmin, type AdminSeedOutcome } from '../admin-seed.js';
import { createPrismaClient } from '../db/prisma.js';
import { hashPassword, verifyPassword } from '../modules/auth/password.js';

const MESSAGES: Record<AdminSeedOutcome, string> = {
  created: 'Admin account created.',
  promoted: 'Existing account promoted to ADMIN (password unchanged).',
  'already-admin': 'Account is already ADMIN; nothing changed (password unchanged).',
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Invalid or missing variables: DATABASE_URL');
  process.exit(1);
}

const prisma = createPrismaClient(databaseUrl);
try {
  console.info(
    MESSAGES[await seedAdmin({ prisma, source: process.env, hashPassword, verifyPassword })],
  );
} catch (error) {
  if (error instanceof AdminSeedError) {
    console.error(error.message);
  } else {
    // Name and code only (e.g. a Prisma P1001 when the database is unreachable), never the message,
    // which can carry the connection string.
    const { name, code } = error as { name?: unknown; code?: unknown };
    const label = typeof name === 'string' ? name : 'Error';
    const suffix = typeof code === 'string' ? ` (${code})` : '';
    console.error(`Admin seed failed: ${label}${suffix}`);
  }
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
