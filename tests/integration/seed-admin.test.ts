import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminSeedError, seedAdmin } from '../../src/admin-seed.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { buildTestApiRoutes } from '../helpers/api.js';
import { buildTestApp } from '../helpers/app.js';
import { createTestPrisma, resetDb } from '../helpers/db.js';
import { ANA, registerAndLogin } from '../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });

const env = {
  ADMIN_NAME: 'Primeira Admin',
  ADMIN_EMAIL: '  Root@Example.com ',
  ADMIN_PASSWORD: 'the very first admin passphrase',
};

function seed(source: NodeJS.ProcessEnv) {
  return seedAdmin({ prisma, source, hashPassword, verifyPassword });
}

async function expectSeedError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof AdminSeedError && message.test(error.message),
  );
}

describe('seedAdmin', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates an ADMIN that can log in and reach admin routes', async () => {
    expect(await seed(env)).toBe('created');

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.com' } });
    expect(stored).toMatchObject({ role: 'ADMIN', name: 'Primeira Admin' });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'root@example.com', password: env.ADMIN_PASSWORD });
    const { accessToken } = (login.body as { data: { accessToken: string } }).data;
    const users = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(users.status).toBe(200);
  });

  it('is idempotent and never overwrites the password of an existing admin', async () => {
    await seed(env);
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.com' } });

    expect(await seed({ ...env, ADMIN_PASSWORD: 'someone trying to reset it' })).toBe(
      'already-admin',
    );

    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.com' } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await prisma.user.count()).toBe(1);
  });

  it('promotes an existing USER only when ADMIN_PASSWORD is that account password', async () => {
    await registerAndLogin(app);
    const before = await prisma.user.findUniqueOrThrow({ where: { email: ANA.email } });

    expect(await seed({ ...env, ADMIN_EMAIL: ANA.email, ADMIN_PASSWORD: ANA.password })).toBe(
      'promoted',
    );

    const after = await prisma.user.findUniqueOrThrow({ where: { email: ANA.email } });
    expect(after.role).toBe('ADMIN');
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('never promotes an account someone else pre-registered with the admin email', async () => {
    // Registration is public and emails are not verified: a third party can sign up first.
    const squatter = {
      name: 'Terceiro',
      email: 'admin@empresa.example',
      password: 'the squatter own passphrase',
    };
    await request(app).post('/api/v1/auth/register').send(squatter);

    await expectSeedError(
      seed({ ...env, ADMIN_EMAIL: squatter.email }),
      /already registered with a different password/,
    );

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: squatter.email } });
    expect(stored.role).toBe('USER');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: squatter.email, password: squatter.password });
    const { accessToken } = (login.body as { data: { accessToken: string } }).data;
    const users = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(users.status).toBe(403);
  });

  it('refuses to run without its variables and creates nobody, naming only the variables', async () => {
    await expectSeedError(
      seed({}),
      /^Invalid or missing variables: ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD$/,
    );
    expect(await prisma.user.count()).toBe(0);
  });

  it('applies the password policy and never prints the value', async () => {
    const weak = 'curta';
    await expectSeedError(
      seed({ ...env, ADMIN_PASSWORD: weak }),
      /^Invalid or missing variables: ADMIN_PASSWORD$/,
    );
    await expectSeedError(seed({ ...env, ADMIN_PASSWORD: 'demon1q2w3e4r5t' }), /ADMIN_PASSWORD/);
    await expect(seed({ ...env, ADMIN_PASSWORD: weak })).rejects.not.toThrow(new RegExp(weak));
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses an email that belongs to a soft-deleted account', async () => {
    await registerAndLogin(app);
    await prisma.user.update({ where: { email: ANA.email }, data: { deletedAt: new Date() } });

    await expectSeedError(seed({ ...env, ADMIN_EMAIL: ANA.email }), /deleted account/);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: ANA.email } });
    expect(stored.role).toBe('USER');
  });
});
