import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { hashRefreshToken } from '../../../src/modules/auth/token.service.js';
import { buildTestApiRoutes } from '../../helpers/api.js';
import { buildTestApp } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';
import { loginAgain, logout, refresh, registerAndLogin } from '../../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });

describe('POST /api/v1/auth/logout', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('ends the session: 204, and the refresh token stops working', async () => {
    const login = await registerAndLogin(app);

    const response = await logout(app, login.refreshToken);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    const session = await prisma.refreshSession.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(login.refreshToken) },
    });
    expect(session.revokedAt).not.toBeNull();
    expect((await refresh(app, login.refreshToken)).status).toBe(401);
  });

  it('answers 204 for a repeated logout and for a token that never existed', async () => {
    const login = await registerAndLogin(app);
    await logout(app, login.refreshToken);

    expect((await logout(app, login.refreshToken)).status).toBe(204);
    expect((await logout(app, 'A'.repeat(43))).status).toBe(204);
    expect((await logout(app, 'garbage')).status).toBe(204);
  });

  it('only ends that session, not the other sessions of the user', async () => {
    const phone = await registerAndLogin(app);
    const laptop = await loginAgain(app);

    await logout(app, phone.refreshToken);

    expect((await refresh(app, laptop.refreshToken)).status).toBe(200);
  });

  it('does not treat a logout of an old token as reuse', async () => {
    const login = await registerAndLogin(app);
    const next = (await refresh(app, login.refreshToken)).body as {
      data: { refreshToken: string };
    };

    await logout(app, login.refreshToken);

    expect((await refresh(app, next.data.refreshToken)).status).toBe(200);
  });

  it('rejects an invalid body with 400', async () => {
    expect((await logout(app, '')).status).toBe(400);
  });
});
