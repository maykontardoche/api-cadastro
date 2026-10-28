import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { Prisma } from '../../../src/generated/prisma/client.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';

const prisma = createTestPrisma();

const buildUser = (email: string) => ({ name: 'Ana', email, passwordHash: 'not-a-real-hash' });

describe('database schema', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects a duplicate email at the database level', async () => {
    await prisma.user.create({ data: buildUser('ana@example.com') });

    const duplicate = prisma.user.create({ data: buildUser('ana@example.com') });

    await expect(duplicate).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(duplicate).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps the email reserved after a soft delete', async () => {
    const deleted = await prisma.user.create({ data: buildUser('ana@example.com') });
    await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    await expect(prisma.user.create({ data: buildUser('ana@example.com') })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('defaults new users to the USER role', async () => {
    const created = await prisma.user.create({ data: buildUser('ana@example.com') });

    expect(created.role).toBe('USER');
  });

  it('rejects a duplicate refresh token hash', async () => {
    const owner = await prisma.user.create({ data: buildUser('ana@example.com') });
    const session = {
      userId: owner.id,
      familyId: '0192f000-0000-7000-8000-000000000001',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await prisma.refreshSession.create({ data: session });

    await expect(prisma.refreshSession.create({ data: session })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('removes sessions when their user row is physically deleted (cascade)', async () => {
    const owner = await prisma.user.create({ data: buildUser('ana@example.com') });
    await prisma.refreshSession.create({
      data: {
        userId: owner.id,
        familyId: '0192f000-0000-7000-8000-000000000002',
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.user.delete({ where: { id: owner.id } });

    expect(await prisma.refreshSession.count()).toBe(0);
  });

  it('keeps data across client restarts', async () => {
    await prisma.user.create({ data: buildUser('persisted@example.com') });

    const restarted = createTestPrisma();
    const found = await restarted.user.findUnique({ where: { email: 'persisted@example.com' } });
    await restarted.$disconnect();

    expect(found?.email).toBe('persisted@example.com');
  });
});
