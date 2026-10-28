import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../../src/http/errors.js';
import { hashRefreshToken } from '../../../src/modules/auth/token.service.js';
import type { PublicUser } from '../../../src/modules/users/user.schema.js';
import { buildTestApiRoutes, TEST_TOKEN_CONFIG } from '../../helpers/api.js';
import { buildTestApp, createLogCapture } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });

const credentials = { email: 'ana@example.com', password: 'correct horse battery staple' };

interface LoginData {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
  user: PublicUser;
}

async function registerAna(): Promise<PublicUser> {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Ana Souza', ...credentials });
  return (response.body as { data: PublicUser }).data;
}

function login(body: object, target = app) {
  return request(target).post('/api/v1/auth/login').send(body);
}

function me(authorization?: string) {
  const req = request(app).get('/api/v1/users/me');
  return authorization === undefined ? req : req.set('Authorization', authorization);
}

/** Error body without the per-request id, to compare two failures byte for byte. */
function errorWithoutRequestId(response: request.Response): Partial<ErrorBody['error']> {
  const error: Partial<ErrorBody['error']> = { ...(response.body as ErrorBody).error };
  delete error.requestId;
  return error;
}

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('starts a session with an access token, a refresh token and the public user', async () => {
    const user = await registerAna();

    const response = await login({ ...credentials, email: '  ANA@example.com ' });

    expect(response.status).toBe(200);
    const data = (response.body as { data: LoginData }).data;
    expect(data).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user });
    expect(data.accessToken.split('.')).toHaveLength(3);
    expect(data.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.text).not.toMatch(/argon2|passwordHash|correct horse/);
  });

  it('stores only the SHA-256 of the refresh token, in a new family', async () => {
    await registerAna();

    const first = (await login(credentials)).body as { data: LoginData };
    const second = (await login(credentials)).body as { data: LoginData };

    const sessions = await prisma.refreshSession.findMany({ orderBy: { createdAt: 'asc' } });
    expect(sessions.map((s) => s.tokenHash)).toEqual([
      hashRefreshToken(first.data.refreshToken),
      hashRefreshToken(second.data.refreshToken),
    ]);
    expect(sessions[0]?.familyId).not.toBe(sessions[1]?.familyId);
    const stored = JSON.stringify(sessions);
    expect(stored).not.toContain(first.data.refreshToken);
    expect(stored).not.toContain(second.data.refreshToken);
  });

  it('sets the refresh session to expire in 30 days', async () => {
    await registerAna();
    await login(credentials);

    const session = await prisma.refreshSession.findFirstOrThrow();
    const days = (session.expiresAt.getTime() - session.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 1);
  });

  it('gives the same 401 for a wrong password, an unknown email and a deleted account', async () => {
    await registerAna();
    const wrongPassword = await login({ ...credentials, password: 'not the right password' });
    const unknownEmail = await login({ ...credentials, email: 'nobody@example.com' });
    await prisma.user.update({
      where: { email: credentials.email },
      data: { deletedAt: new Date() },
    });
    const deleted = await login(credentials);

    for (const response of [wrongPassword, unknownEmail, deleted]) {
      expect(response.status).toBe(401);
      expect(errorWithoutRequestId(response)).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Credenciais inválidas.',
      });
    }
    expect(await prisma.refreshSession.count()).toBe(0);
  });

  it('rejects a malformed body with 400, not 401', async () => {
    const response = await login({ email: 'ana@', password: '' });

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.details?.map((d) => d.field).sort()).toEqual([
      'email',
      'password',
    ]);
  });

  it('logs failures without the email and successes with only the user id', async () => {
    const user = await registerAna();
    const capture = createLogCapture();
    const loggedApp = buildTestApp({
      logger: capture.logger,
      apiRoutes: buildTestApiRoutes(prisma),
    });

    await login({ ...credentials, password: 'not the right password' }, loggedApp);
    await login(credentials, loggedApp);

    const events = capture.entries().filter((entry) => typeof entry.event === 'string');
    expect(events.map((entry) => entry.event)).toEqual(['login_failed', 'login_succeeded']);
    expect(events[1]).toMatchObject({ userId: user.id });
    expect(capture.text()).not.toContain(credentials.email);
    expect(capture.text()).not.toContain(credentials.password);
  });

  it('shares the credential rate limit with registration', async () => {
    const limitedApp = buildTestApp({
      apiRoutes: buildTestApiRoutes(prisma, { authRateLimit: { limit: 2, windowMs: 60_000 } }),
    });
    await request(limitedApp)
      .post('/api/v1/auth/register')
      .send({ name: 'Ana Souza', ...credentials });

    const statuses = [
      (await login(credentials, limitedApp)).status,
      (await login(credentials, limitedApp)).status,
    ];

    expect(statuses).toEqual([200, 429]);
  });
});

describe('GET /api/v1/users/me', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('returns the profile of the token owner', async () => {
    const user = await registerAna();
    const { accessToken } = ((await login(credentials)).body as { data: LoginData }).data;

    const response = await me(`Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect((response.body as { data: PublicUser }).data).toEqual(user);
    expect(response.text).not.toMatch(/argon2|passwordHash|deletedAt/);
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty Bearer', 'Bearer '],
    ['another scheme', 'Basic YW5hOnNlbmhh'],
    ['a malformed token', 'Bearer not-a-jwt'],
  ])('answers 401 UNAUTHORIZED for %s', async (_case, authorization) => {
    const response = await me(authorization);

    expect(response.status).toBe(401);
    expect((response.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('answers 401 for an expired token', async () => {
    const user = await registerAna();
    const expired = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject(user.id)
      .setIssuer(TEST_TOKEN_CONFIG.issuer)
      .setAudience(TEST_TOKEN_CONFIG.audience)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3_600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(TEST_TOKEN_CONFIG.secret));

    expect((await me(`Bearer ${expired}`)).status).toBe(401);
  });

  it('re-reads the user: a valid token of an account deleted afterwards is refused', async () => {
    await registerAna();
    const { accessToken } = ((await login(credentials)).body as { data: LoginData }).data;
    expect((await me(`Bearer ${accessToken}`)).status).toBe(200);

    await prisma.user.update({
      where: { email: credentials.email },
      data: { deletedAt: new Date() },
    });

    expect((await me(`Bearer ${accessToken}`)).status).toBe(401);
  });

  it('reflects a role change immediately, without a new token', async () => {
    await registerAna();
    const { accessToken } = ((await login(credentials)).body as { data: LoginData }).data;

    await prisma.user.update({ where: { email: credentials.email }, data: { role: 'ADMIN' } });
    const response = await me(`Bearer ${accessToken}`);

    expect((response.body as { data: PublicUser }).data.role).toBe('ADMIN');
  });

  it('accepts the scheme in any case', async () => {
    await registerAna();
    const { accessToken } = ((await login(credentials)).body as { data: LoginData }).data;

    expect((await me(`bearer ${accessToken}`)).status).toBe(200);
  });
});
