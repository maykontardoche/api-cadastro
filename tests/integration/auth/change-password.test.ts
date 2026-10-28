import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../../src/http/errors.js';
import { buildTestApiRoutes } from '../../helpers/api.js';
import { buildTestApp, createLogCapture } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';
import { ANA, loginAgain, refresh, registerAndLogin } from '../../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });
const NEW_PASSWORD = 'a brand new passphrase here';

function changePassword(accessToken: string | undefined, body: object, target = app) {
  const req = request(target).post('/api/v1/auth/change-password').send(body);
  return accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`);
}

function login(password: string) {
  return request(app).post('/api/v1/auth/login').send({ email: ANA.email, password });
}

const errorOf = (response: request.Response) => (response.body as ErrorBody).error;
const activeSessions = () => prisma.refreshSession.count({ where: { revokedAt: null } });

describe('POST /api/v1/auth/change-password', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('replaces the password and ends every refresh session', async () => {
    const phone = await registerAndLogin(app);
    const laptop = await loginAgain(app);

    const response = await changePassword(phone.accessToken, {
      currentPassword: ANA.password,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(204);
    expect(await activeSessions()).toBe(0);
    expect((await refresh(app, phone.refreshToken)).status).toBe(401);
    expect((await refresh(app, laptop.refreshToken)).status).toBe(401);
    expect((await login(ANA.password)).status).toBe(401);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });

  it('keeps the issued access token valid until it expires (documented limitation)', async () => {
    const { accessToken } = await registerAndLogin(app);
    await changePassword(accessToken, { currentPassword: ANA.password, newPassword: NEW_PASSWORD });

    const me = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(me.status).toBe(200);
  });

  it('refuses a wrong current password with 401 and changes nothing', async () => {
    const { accessToken, refreshToken } = await registerAndLogin(app);

    const response = await changePassword(accessToken, {
      currentPassword: 'not the current password',
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe('INVALID_CREDENTIALS');
    expect(await activeSessions()).toBe(1);
    expect((await refresh(app, refreshToken)).status).toBe(200);
    expect((await login(ANA.password)).status).toBe(200);
  });

  it.each([
    ['too short', 'curta demais', 'too_small'],
    ['common', 'demon1q2w3e4r5t', 'common_password'],
  ])(
    'refuses a %s new password with 400 and keeps the sessions',
    async (_case, newPassword, code) => {
      const { accessToken } = await registerAndLogin(app);

      const response = await changePassword(accessToken, {
        currentPassword: ANA.password,
        newPassword,
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).details).toEqual([{ field: 'newPassword', code }]);
      expect(await activeSessions()).toBe(1);
    },
  );

  it('refuses extra fields and requires a token', async () => {
    const { accessToken } = await registerAndLogin(app);

    const extra = await changePassword(accessToken, {
      currentPassword: ANA.password,
      newPassword: NEW_PASSWORD,
      userId: 'someone-else',
    });
    const anonymous = await changePassword(undefined, {
      currentPassword: ANA.password,
      newPassword: NEW_PASSWORD,
    });

    expect(extra.status).toBe(400);
    expect(anonymous.status).toBe(401);
    expect(errorOf(anonymous).code).toBe('UNAUTHORIZED');
  });

  it('lets only one of two concurrent changes with the same current password succeed', async () => {
    const { accessToken } = await registerAndLogin(app);

    const responses = await Promise.all([
      changePassword(accessToken, { currentPassword: ANA.password, newPassword: NEW_PASSWORD }),
      changePassword(accessToken, {
        currentPassword: ANA.password,
        newPassword: 'yet another long passphrase',
      }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([204, 401]);
    const [first] = responses;
    const winner = first.status === 204 ? NEW_PASSWORD : 'yet another long passphrase';
    expect((await login(winner)).status).toBe(200);
  });

  it('logs the change with the user id and never a password', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({
      logger: capture.logger,
      apiRoutes: buildTestApiRoutes(prisma),
    });
    const { accessToken, user } = await registerAndLogin(loggedApp);

    await changePassword(
      accessToken,
      { currentPassword: 'wrong current password', newPassword: NEW_PASSWORD },
      loggedApp,
    );
    await changePassword(
      accessToken,
      { currentPassword: ANA.password, newPassword: NEW_PASSWORD },
      loggedApp,
    );

    const events = capture.entries().filter((entry) => typeof entry.event === 'string');
    expect(events.map((entry) => entry.event)).toEqual([
      'user_registered',
      'login_succeeded',
      'password_change_rejected',
      'password_changed',
    ]);
    expect(events[3]).toMatchObject({ userId: user.id, revokedSessions: 1 });
    for (const secret of [ANA.password, NEW_PASSWORD, 'wrong current password', accessToken]) {
      expect(capture.text()).not.toContain(secret);
    }
  });

  it('applies the credential rate limit', async () => {
    const limitedApp = buildTestApp({
      apiRoutes: buildTestApiRoutes(prisma, { authRateLimit: { limit: 3, windowMs: 60_000 } }),
    });
    const { accessToken } = await registerAndLogin(limitedApp); // 2 of 3

    const statuses = [
      (
        await changePassword(
          accessToken,
          { currentPassword: 'wrong one', newPassword: NEW_PASSWORD },
          limitedApp,
        )
      ).status,
      (
        await changePassword(
          accessToken,
          { currentPassword: 'wrong two', newPassword: NEW_PASSWORD },
          limitedApp,
        )
      ).status,
    ];

    expect(statuses).toEqual([401, 429]);
  });
});
