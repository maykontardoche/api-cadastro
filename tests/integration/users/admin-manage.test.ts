import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../../src/http/errors.js';
import type { PublicUser, UsersPage } from '../../../src/modules/users/user.schema.js';
import { buildTestApiRoutes } from '../../helpers/api.js';
import { buildTestApp, createLogCapture } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';
import {
  ADMIN,
  ANA,
  loginAsAdmin,
  refresh,
  registerAndLogin,
  type SessionData,
} from '../../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });
const UNKNOWN_ID = '0192f000-0000-7000-8000-00000000dead';

const errorOf = (response: request.Response) => (response.body as ErrorBody).error;
const userOf = (response: request.Response) => (response.body as { data: PublicUser }).data;

function as(session: SessionData) {
  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${session.accessToken}`);
  return {
    get: (id: string) => auth(request(app).get(`/api/v1/users/${id}`)),
    patch: (id: string, body: object) => auth(request(app).patch(`/api/v1/users/${id}`).send(body)),
    role: (id: string, body: object) =>
      auth(request(app).patch(`/api/v1/users/${id}/role`).send(body)),
    remove: (id: string) => auth(request(app).delete(`/api/v1/users/${id}`)),
    list: (query = '') => auth(request(app).get(`/api/v1/users${query}`)),
  };
}

describe('admin management of a user', () => {
  let admin: SessionData;
  let ana: SessionData;

  beforeEach(async () => {
    await resetDb(prisma);
    admin = await loginAsAdmin(app, prisma);
    ana = await registerAndLogin(app);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('access control', () => {
    it('refuses every admin route to a USER, even on their own id (BOLA)', async () => {
      const bob = await registerAndLogin(app, {
        name: 'Bob Silva',
        email: 'bob@example.com',
        password: 'bob long enough passphrase',
      });
      const asAna = as(ana);

      for (const response of [
        await asAna.get(bob.user.id),
        await asAna.patch(bob.user.id, { name: 'Hacked' }),
        await asAna.role(ana.user.id, { role: 'ADMIN' }),
        await asAna.remove(bob.user.id),
        await asAna.get(ana.user.id),
      ]) {
        expect(response.status).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
      const bobNow = await prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } });
      expect(bobNow).toMatchObject({ name: 'Bob Silva', deletedAt: null });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ana.user.id } })).role).toBe(
        'USER',
      );
    });

    it('answers 400 for a malformed id and 404 for an unknown one', async () => {
      const invalid = await as(admin).get('not-a-uuid');
      const unknown = await as(admin).get(UNKNOWN_ID);

      expect(invalid.status).toBe(400);
      expect(errorOf(invalid).details).toEqual([{ field: 'params.id', code: 'invalid_format' }]);
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('NOT_FOUND');
    });

    it('still serves /users/me to everyone (not captured by /users/:id)', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${ana.accessToken}`);

      expect(response.status).toBe(200);
      expect(userOf(response).id).toBe(ana.user.id);
    });
  });

  describe('GET and PATCH /users/:id', () => {
    it('reads a user', async () => {
      const response = await as(admin).get(ana.user.id);

      expect(response.status).toBe(200);
      expect(userOf(response)).toEqual(ana.user);
    });

    it('edits name and email, normalized', async () => {
      const response = await as(admin).patch(ana.user.id, {
        name: '  Ana Maria ',
        email: ' ANA.M@Example.com',
      });

      expect(response.status).toBe(200);
      expect(userOf(response)).toMatchObject({ name: 'Ana Maria', email: 'ana.m@example.com' });
    });

    it('refuses the role and other fields through this route', async () => {
      const response = await as(admin).patch(ana.user.id, { role: 'ADMIN' });

      expect(response.status).toBe(400);
      expect(errorOf(response).details).toContainEqual({ field: 'role', code: 'unrecognized_key' });
    });

    it('answers 409 for a taken email and 404 for an unknown user', async () => {
      expect((await as(admin).patch(ana.user.id, { email: ADMIN.email })).status).toBe(409);
      expect((await as(admin).patch(UNKNOWN_ID, { name: 'Ninguém' })).status).toBe(404);
    });
  });

  describe('PATCH /users/:id/role', () => {
    it('promotes and demotes; the change applies to the next request', async () => {
      const promoted = await as(admin).role(ana.user.id, { role: 'ADMIN' });
      expect(userOf(promoted).role).toBe('ADMIN');
      expect((await as(ana).list()).status).toBe(200);

      const demoted = await as(admin).role(ana.user.id, { role: 'USER' });
      expect(userOf(demoted).role).toBe('USER');
      expect((await as(ana).list()).status).toBe(403);
    });

    it.each([
      ['an invalid role', { role: 'ROOT' }],
      ['a missing role', {}],
      ['an extra field', { role: 'ADMIN', name: 'x' }],
    ])('refuses %s with 400', async (_case, body) => {
      expect((await as(admin).role(ana.user.id, body)).status).toBe(400);
    });

    it('refuses to demote the last active admin, even by themselves', async () => {
      const response = await as(admin).role(admin.user.id, { role: 'USER' });

      expect(response.status).toBe(409);
      expect(errorOf(response).code).toBe('LAST_ADMIN');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).role).toBe(
        'ADMIN',
      );
    });

    it('allows an admin to step down when another admin exists', async () => {
      await as(admin).role(ana.user.id, { role: 'ADMIN' });

      expect((await as(admin).role(admin.user.id, { role: 'USER' })).status).toBe(200);
      expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
    });

    it('keeps two admins demoting each other at the same time from leaving none', async () => {
      const second = await as(admin).role(ana.user.id, { role: 'ADMIN' });
      expect(second.status).toBe(200);

      const statuses = (
        await Promise.all([
          as(admin).role(ana.user.id, { role: 'USER' }),
          as(ana).role(admin.user.id, { role: 'USER' }),
        ])
      ).map((response) => response.status);

      // The loser sees either the guard (409) or, if it authenticates after the winner commits,
      // that it is no longer an admin (403). Never two 200s.
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.every((status) => [200, 403, 409].includes(status))).toBe(true);
      expect(await prisma.user.count({ where: { role: 'ADMIN', deletedAt: null } })).toBe(1);
    });
  });

  describe('DELETE /users/:id', () => {
    it('soft deletes: 204, no login, no refresh, gone from reads and lists, email reserved', async () => {
      const response = await as(admin).remove(ana.user.id);

      expect(response.status).toBe(204);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: ana.user.id } });
      expect(stored.deletedAt).not.toBeNull();
      expect(
        await prisma.refreshSession.count({ where: { userId: ana.user.id, revokedAt: null } }),
      ).toBe(0);

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: ANA.email, password: ANA.password });
      expect(login.status).toBe(401);
      expect((await refresh(app, ana.refreshToken)).status).toBe(401);
      expect(
        (
          await request(app)
            .get('/api/v1/users/me')
            .set('Authorization', `Bearer ${ana.accessToken}`)
        ).status,
      ).toBe(401);
      expect((await as(admin).get(ana.user.id)).status).toBe(404);
      const list = (await as(admin).list('?limit=100')).body as UsersPage;
      expect(list.data.map((u) => u.id)).not.toContain(ana.user.id);
      const reRegister = await request(app).post('/api/v1/auth/register').send(ANA);
      expect(reRegister.status).toBe(409);
    });

    it('answers 404 when deleting again or deleting an unknown user', async () => {
      await as(admin).remove(ana.user.id);

      expect((await as(admin).remove(ana.user.id)).status).toBe(404);
      expect((await as(admin).remove(UNKNOWN_ID)).status).toBe(404);
    });

    it('refuses to delete the last active admin, even by themselves', async () => {
      const response = await as(admin).remove(admin.user.id);

      expect(response.status).toBe(409);
      expect(errorOf(response).code).toBe('LAST_ADMIN');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).deletedAt,
      ).toBeNull();
    });
  });

  describe('audit log', () => {
    it('records who changed whom, without personal data', async () => {
      const capture = createLogCapture();
      const loggedApp = buildTestApp({
        logger: capture.logger,
        apiRoutes: buildTestApiRoutes(prisma),
      });
      const bearer = (req: request.Test) => req.set('Authorization', `Bearer ${admin.accessToken}`);

      await bearer(
        request(loggedApp).patch(`/api/v1/users/${ana.user.id}`).send({ name: 'Ana M' }),
      );
      await bearer(
        request(loggedApp).patch(`/api/v1/users/${ana.user.id}/role`).send({ role: 'ADMIN' }),
      );
      await bearer(
        request(loggedApp).patch(`/api/v1/users/${ana.user.id}/role`).send({ role: 'ADMIN' }),
      );
      const deletion = await bearer(request(loggedApp).delete(`/api/v1/users/${ana.user.id}`));

      const events = capture.entries().filter((entry) => typeof entry.event === 'string');
      expect(events).toMatchObject([
        {
          event: 'user_updated_by_admin',
          actorId: admin.user.id,
          targetId: ana.user.id,
          fields: ['name'],
        },
        {
          event: 'role_changed',
          actorId: admin.user.id,
          targetId: ana.user.id,
          from: 'USER',
          to: 'ADMIN',
        },
        // The second, no-op role change is not logged.
        {
          event: 'user_deleted',
          actorId: admin.user.id,
          targetId: ana.user.id,
          revokedSessions: 1,
        },
      ]);
      expect(capture.text()).not.toContain(ANA.email);
      expect(capture.text()).not.toContain('Ana M');
      // Each audit event carries the request id the client saw, to tie a complaint to the log.
      const deleted = events.find((entry) => entry.event === 'user_deleted') as
        { req?: { id?: unknown } } | undefined;
      expect(deleted?.req?.id).toBe(deletion.headers['x-request-id']);
    });
  });
});
