import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../../src/http/errors.js';
import { hashRefreshToken } from '../../../src/modules/auth/token.service.js';
import { buildTestApiRoutes } from '../../helpers/api.js';
import { buildTestApp, createLogCapture } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';
import {
  ANA,
  loginAgain,
  refresh,
  registerAndLogin,
  type SessionData,
} from '../../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });

function dataOf(response: request.Response): SessionData {
  return (response.body as { data: SessionData }).data;
}

function sessionByToken(token: string) {
  return prisma.refreshSession.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(token) } });
}

async function activeInFamily(familyId: string): Promise<number> {
  return prisma.refreshSession.count({ where: { familyId, revokedAt: null } });
}

function expectUnauthorized(response: request.Response): void {
  expect(response.status).toBe(401);
  expect((response.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
}

describe('POST /api/v1/auth/refresh', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('exchanges the refresh token for a new pair and retires the old one', async () => {
    const login = await registerAndLogin(app);

    const response = await refresh(app, login.refreshToken);

    expect(response.status).toBe(200);
    const next = dataOf(response);
    expect(next).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user: login.user });
    expect(next.refreshToken).not.toBe(login.refreshToken);

    const old = await sessionByToken(login.refreshToken);
    const current = await sessionByToken(next.refreshToken);
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedBySessionId).toBe(current.id);
    expect(current.familyId).toBe(old.familyId);
    expect(current.revokedAt).toBeNull();

    const me = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${next.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('accepts a refresh token exactly once', async () => {
    const login = await registerAndLogin(app);

    expect((await refresh(app, login.refreshToken)).status).toBe(200);
    expectUnauthorized(await refresh(app, login.refreshToken));
  });

  it('revokes the whole family when an already used token comes back', async () => {
    const login = await registerAndLogin(app);
    const second = dataOf(await refresh(app, login.refreshToken));
    const third = dataOf(await refresh(app, second.refreshToken));
    const { familyId } = await sessionByToken(login.refreshToken);
    expect(await activeInFamily(familyId)).toBe(1);

    // An attacker replays the first token: the legitimate, newest token dies with it.
    expectUnauthorized(await refresh(app, login.refreshToken));

    expect(await activeInFamily(familyId)).toBe(0);
    expectUnauthorized(await refresh(app, third.refreshToken));
  });

  it('lets at most one of two concurrent refreshes with the same token succeed, and leaves no active session', async () => {
    const login = await registerAndLogin(app);
    const { familyId } = await sessionByToken(login.refreshToken);

    const responses = await Promise.all([
      refresh(app, login.refreshToken),
      refresh(app, login.refreshToken),
    ]);

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(1);
    expect(statuses.every((status) => status === 200 || status === 401)).toBe(true);
    // Strict reuse detection: the loser looks like a replay, so the family is revoked.
    expect(await activeInFamily(familyId)).toBe(0);
    expect(await prisma.refreshSession.count({ where: { familyId } })).toBeLessThanOrEqual(2);
  });

  it('holds under repeated races: never two winners, never a 500, never an active session left', async () => {
    const login = await registerAndLogin(app);
    let current = login.refreshToken;

    for (let round = 0; round < 8; round += 1) {
      // Each round starts from a fresh, valid token in a new family.
      if (round > 0) current = (await loginAgain(app)).refreshToken;
      const { familyId } = await sessionByToken(current);

      const statuses = (
        await Promise.all(Array.from({ length: 5 }, () => refresh(app, current)))
      ).map((r) => r.status);

      expect(
        statuses.filter((status) => status === 200).length,
        `round ${String(round)}`,
      ).toBeLessThanOrEqual(1);
      expect(
        statuses.every((status) => status === 200 || status === 401),
        `round ${String(round)}: ${statuses.join(',')}`,
      ).toBe(true);
      expect(await activeInFamily(familyId)).toBe(0);
    }
  });

  it('does not touch other families of the same user on reuse', async () => {
    const phone = await registerAndLogin(app);
    const laptop = await loginAgain(app);
    await refresh(app, phone.refreshToken);

    expectUnauthorized(await refresh(app, phone.refreshToken));

    expect((await refresh(app, laptop.refreshToken)).status).toBe(200);
  });

  it('rejects an expired token without treating it as reuse', async () => {
    const login = await registerAndLogin(app);
    const session = await sessionByToken(login.refreshToken);
    await prisma.refreshSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expectUnauthorized(await refresh(app, login.refreshToken));
    expect((await sessionByToken(login.refreshToken)).revokedAt).toBeNull();
  });

  it.each([
    ['an unknown token', 'A'.repeat(43)],
    ['a malformed token', 'not a token'],
  ])('rejects %s with 401', async (_case, token) => {
    expectUnauthorized(await refresh(app, token));
  });

  it.each([
    ['an empty token', { refreshToken: '' }],
    ['no token', {}],
    ['an extra field', { refreshToken: 'x', userId: 'someone' }],
  ])('rejects a body with %s with 400', async (_case, body) => {
    const response = await request(app).post('/api/v1/auth/refresh').send(body);

    expect(response.status).toBe(400);
  });

  it('refuses to refresh for a deleted account', async () => {
    const login = await registerAndLogin(app);
    await prisma.user.update({ where: { email: ANA.email }, data: { deletedAt: new Date() } });

    expectUnauthorized(await refresh(app, login.refreshToken));
  });

  it('logs reuse with the family and user, never the token', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({
      logger: capture.logger,
      apiRoutes: buildTestApiRoutes(prisma),
    });
    const login = await registerAndLogin(loggedApp);
    const next = dataOf(await refresh(loggedApp, login.refreshToken));
    const { familyId, userId } = await sessionByToken(login.refreshToken);

    await refresh(loggedApp, login.refreshToken);

    const reuse = capture.entries().find((entry) => entry.event === 'refresh_reuse_detected');
    expect(reuse).toMatchObject({
      level: 40,
      userId,
      familyId,
      revokedSessions: 1,
      afterRotation: true,
    });
    for (const token of [
      login.refreshToken,
      next.refreshToken,
      login.accessToken,
      next.accessToken,
    ]) {
      expect(capture.text()).not.toContain(token);
    }
  });

  it('shares the credential rate limit', async () => {
    const limitedApp = buildTestApp({
      apiRoutes: buildTestApiRoutes(prisma, { authRateLimit: { limit: 3, windowMs: 60_000 } }),
    });
    const login = await registerAndLogin(limitedApp); // uses 2 of 3

    const statuses = [
      (await refresh(limitedApp, login.refreshToken)).status,
      (await refresh(limitedApp, login.refreshToken)).status,
    ];

    expect(statuses).toEqual([200, 429]);
  });
});

describe('refresh_reuse_detected signal', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('marks a token revoked by logout as not rotated, to tell stale clients from theft', async () => {
    const capture = createLogCapture();
    const loggedApp = buildTestApp({
      logger: capture.logger,
      apiRoutes: buildTestApiRoutes(prisma),
    });
    const login = await registerAndLogin(loggedApp);
    await request(loggedApp).post('/api/v1/auth/logout').send({ refreshToken: login.refreshToken });

    await refresh(loggedApp, login.refreshToken);

    expect(
      capture.entries().find((entry) => entry.event === 'refresh_reuse_detected'),
    ).toMatchObject({
      afterRotation: false,
      revokedSessions: 0,
    });
  });
});
