import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../../src/http/errors.js';
import type { PublicUser } from '../../../src/modules/users/user.schema.js';
import { buildTestApiRoutes } from '../../helpers/api.js';
import { buildTestApp, createLogCapture } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';
import { ANA, registerAndLogin } from '../../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });
const BIA = { name: 'Bia Lima', email: 'bia@example.com', password: 'another long passphrase ok' };

function patchMe(accessToken: string | undefined, body: object) {
  const req = request(app).patch('/api/v1/users/me').send(body);
  return accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`);
}

const errorOf = (response: request.Response) => (response.body as ErrorBody).error;
const userOf = (response: request.Response) => (response.body as { data: PublicUser }).data;

describe('PATCH /api/v1/users/me', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('changes the name, normalized', async () => {
    const { accessToken, user } = await registerAndLogin(app);

    const response = await patchMe(accessToken, { name: '  Ana Maria  ' });

    expect(response.status).toBe(200);
    expect(userOf(response)).toMatchObject({ id: user.id, name: 'Ana Maria', email: ANA.email });
    expect(new Date(userOf(response).updatedAt).getTime()).toBeGreaterThan(
      new Date(user.updatedAt).getTime(),
    );
  });

  it('changes the email, normalized, and the new one works for login', async () => {
    const { accessToken } = await registerAndLogin(app);

    const response = await patchMe(accessToken, { email: '  Ana.Nova@Example.COM ' });

    expect(userOf(response).email).toBe('ana.nova@example.com');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ana.nova@example.com', password: ANA.password });
    expect(login.status).toBe(200);
  });

  it('never changes the role: role in the body is a 400 and the user stays USER', async () => {
    const { accessToken, user } = await registerAndLogin(app);

    const response = await patchMe(accessToken, { name: 'Ana', role: 'ADMIN' });

    expect(response.status).toBe(400);
    expect(errorOf(response).details).toEqual([{ field: 'role', code: 'unrecognized_key' }]);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe('USER');
    expect(stored.name).toBe(ANA.name);
  });

  it.each([
    ['id', { id: '00000000-0000-7000-8000-000000000000' }],
    ['passwordHash', { passwordHash: 'x' }],
    ['password', { password: 'a long enough new password' }],
    ['createdAt', { createdAt: '2000-01-01T00:00:00.000Z' }],
    ['deletedAt', { deletedAt: null }],
  ])('refuses the server-controlled field %s', async (field, body) => {
    const { accessToken } = await registerAndLogin(app);

    const response = await patchMe(accessToken, body);

    expect(response.status).toBe(400);
    expect(errorOf(response).details).toContainEqual({ field, code: 'unrecognized_key' });
  });

  it('refuses an empty body', async () => {
    const { accessToken } = await registerAndLogin(app);

    const response = await patchMe(accessToken, {});

    expect(response.status).toBe(400);
    expect(errorOf(response).details).toEqual([{ field: 'body', code: 'empty_update' }]);
  });

  it('answers 409 EMAIL_TAKEN for the email of another account, in any case', async () => {
    await registerAndLogin(app, BIA);
    const { accessToken } = await registerAndLogin(app);

    const response = await patchMe(accessToken, { email: 'BIA@example.com' });

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('EMAIL_TAKEN');
  });

  it('accepts its own current email (no conflict with itself)', async () => {
    const { accessToken } = await registerAndLogin(app);

    expect((await patchMe(accessToken, { email: ANA.email })).status).toBe(200);
  });

  it('validates the fields like registration does', async () => {
    const { accessToken } = await registerAndLogin(app);

    const response = await patchMe(accessToken, { name: 'A', email: 'not-an-email' });

    expect(
      errorOf(response)
        .details?.map((d) => d.field)
        .sort(),
    ).toEqual(['email', 'name']);
  });

  it('requires a token', async () => {
    expect((await patchMe(undefined, { name: 'Ana' })).status).toBe(401);
  });
});

describe('PATCH /api/v1/users/me logging', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('logs which fields changed, never their values', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({
      logger: capture.logger,
      apiRoutes: buildTestApiRoutes(prisma),
    });
    const { accessToken, user } = await registerAndLogin(loggedApp);

    await request(loggedApp)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'ana.nova@example.com', name: 'Ana Maria' });

    expect(capture.entries().find((entry) => entry.event === 'profile_updated')).toMatchObject({
      userId: user.id,
      fields: ['email', 'name'],
    });
    expect(capture.text()).not.toContain('ana.nova@example.com');
    expect(capture.text()).not.toContain('Ana Maria');
  });
});
