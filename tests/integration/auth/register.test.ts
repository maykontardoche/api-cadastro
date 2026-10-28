import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiRoutes } from '../../../src/api-routes.js';
import type { ErrorBody } from '../../../src/http/errors.js';
import type { PublicUser } from '../../../src/modules/users/user.schema.js';
import { buildTestApp, createLogCapture } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';

const prisma = createTestPrisma();
const roomyLimit = { limit: 1_000, windowMs: 60_000 };
const app = buildTestApp({ apiRoutes: createApiRoutes({ prisma, authRateLimit: roomyLimit }) });

const valid = {
  name: 'Ana Souza',
  email: 'ana@example.com',
  password: 'correct horse battery staple',
};

function register(body: unknown, target = app) {
  return request(target)
    .post('/api/v1/auth/register')
    .send(body as object);
}

function errorOf(response: request.Response): ErrorBody['error'] {
  return (response.body as ErrorBody).error;
}

describe('POST /api/v1/auth/register', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a USER and returns only public data', async () => {
    const response = await register({
      ...valid,
      email: '  Ana@Example.COM ',
      name: '  Ana Souza ',
    });

    expect(response.status).toBe(201);
    const { data } = response.body as { data: PublicUser };
    expect(data).toMatchObject({ name: 'Ana Souza', email: 'ana@example.com', role: 'USER' });
    expect(Object.keys(data).sort()).toEqual(
      ['createdAt', 'email', 'id', 'name', 'role', 'updatedAt'].sort(),
    );
    expect(response.text).not.toMatch(/argon2|passwordHash|correct horse/);
  });

  it('stores an Argon2id hash, never the password', async () => {
    await register(valid);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: valid.email } });
    expect(stored.role).toBe('USER');
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.passwordHash).not.toContain(valid.password);
  });

  it('refuses a role in the payload and creates nobody', async () => {
    const response = await register({ ...valid, role: 'ADMIN' });

    expect(response.status).toBe(400);
    expect(errorOf(response).details).toEqual([{ field: 'role', code: 'unrecognized_key' }]);
    expect(await prisma.user.count()).toBe(0);
  });

  it('answers 409 EMAIL_TAKEN for an email that differs only in case', async () => {
    await register(valid);

    const response = await register({ ...valid, email: 'ANA@example.com' });

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('EMAIL_TAKEN');
    expect(await prisma.user.count()).toBe(1);
  });

  it('keeps the email of a soft-deleted account reserved', async () => {
    await register(valid);
    await prisma.user.update({ where: { email: valid.email }, data: { deletedAt: new Date() } });

    expect((await register(valid)).status).toBe(409);
  });

  it('lets only one of two concurrent registrations with the same email succeed', async () => {
    const statuses = (await Promise.all([register(valid), register(valid)])).map((r) => r.status);

    expect(statuses.sort()).toEqual([201, 409]);
    expect(await prisma.user.count()).toBe(1);
  });

  it.each([
    ['a short password', { ...valid, password: 'curta demais' }, 'password', 'too_small'],
    ['a common password', { ...valid, password: 'demon1q2w3e4r5t' }, 'password', 'common_password'],
    ['an empty name', { ...valid, name: '   ' }, 'name', 'too_small'],
    ['an invalid email', { ...valid, email: 'ana@' }, 'email', 'invalid_format'],
    // NUL would reach PostgreSQL (which rejects it in text) and turn into a 500.
    ['a name with NUL', { ...valid, name: 'Ana\u0000Souza' }, 'name', 'invalid_characters'],
    ['a name with a line break', { ...valid, name: 'Ana\nSouza' }, 'name', 'invalid_characters'],
  ])('rejects %s with 400 pointing at the field', async (_case, body, field, code) => {
    const response = await register(body);

    expect(response.status).toBe(400);
    expect(errorOf(response).details).toEqual([{ field, code }]);
    expect(response.text).not.toContain(body.password);
  });

  it('reports every missing field at once', async () => {
    const response = await register({});

    expect(
      errorOf(response)
        .details?.map((d) => d.field)
        .sort(),
    ).toEqual(['email', 'name', 'password']);
  });

  it('logs the registration with the user id but without email or password', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({
      logger: capture.logger,
      apiRoutes: createApiRoutes({ prisma, authRateLimit: roomyLimit }),
    });

    const response = await register(valid, loggedApp);

    const event = capture.entries().find((entry) => entry.event === 'user_registered');
    expect(event).toMatchObject({ userId: (response.body as { data: PublicUser }).data.id });
    expect(capture.text()).not.toContain(valid.email);
    expect(capture.text()).not.toContain(valid.password);
  });

  it('applies the credential rate limit', async () => {
    const limitedApp = buildTestApp({
      apiRoutes: createApiRoutes({ prisma, authRateLimit: { limit: 2, windowMs: 60_000 } }),
    });

    const statuses = [];
    for (const n of [1, 2, 3]) {
      statuses.push(
        (await register({ ...valid, email: `user${String(n)}@example.com` }, limitedApp)).status,
      );
    }

    expect(statuses).toEqual([201, 201, 429]);
  });
});
