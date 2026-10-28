import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../../src/http/errors.js';
import type { UsersPage } from '../../../src/modules/users/user.schema.js';
import { buildTestApiRoutes } from '../../helpers/api.js';
import { buildTestApp } from '../../helpers/app.js';
import { createTestPrisma, resetDb } from '../../helpers/db.js';
import { ADMIN, loginAsAdmin, registerAndLogin } from '../../helpers/sessions.js';

const prisma = createTestPrisma();
const app = buildTestApp({ apiRoutes: buildTestApiRoutes(prisma) });

function list(accessToken: string | undefined, query = '') {
  const req = request(app).get(`/api/v1/users${query}`);
  return accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`);
}

const pageOf = (response: request.Response) => response.body as UsersPage;
const errorOf = (response: request.Response) => (response.body as ErrorBody).error;

/** 25 regular users inserted directly (no Argon2 needed), with names that sort predictably. */
async function seedUsers(): Promise<void> {
  await prisma.user.createMany({
    data: Array.from({ length: 25 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return { name: `Pessoa ${n}`, email: `pessoa${n}@example.com`, passwordHash: 'x' };
    }),
  });
}

describe('GET /api/v1/users', () => {
  let adminToken = '';

  beforeAll(async () => {
    await resetDb(prisma);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminToken = (await loginAsAdmin(app, prisma)).accessToken;
    await seedUsers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses a USER with 403, an anonymous client with 401', async () => {
    const user = await registerAndLogin(app);

    const forbidden = await list(user.accessToken);
    const anonymous = await list(undefined);

    expect(forbidden.status).toBe(403);
    expect(errorOf(forbidden).code).toBe('FORBIDDEN');
    expect(anonymous.status).toBe(401);
  });

  it('stops working the moment an admin is demoted, without a new token', async () => {
    await prisma.user.update({ where: { email: ADMIN.email }, data: { role: 'USER' } });

    expect((await list(adminToken)).status).toBe(403);
  });

  it('paginates with meta', async () => {
    const response = await list(adminToken, '?page=2&limit=10&sortBy=name&order=asc');

    expect(response.status).toBe(200);
    const page = pageOf(response);
    expect(page.meta).toEqual({ page: 2, limit: 10, total: 26, totalPages: 3 });
    expect(page.data.map((u) => u.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Pessoa ${String(i + 10).padStart(2, '0')}`),
    );
  });

  it('returns an empty page past the end, with the real total', async () => {
    const page = pageOf(await list(adminToken, '?page=9&limit=10'));

    expect(page.data).toEqual([]);
    expect(page.meta).toMatchObject({ total: 26, totalPages: 3 });
  });

  it('defaults to 20 items, newest first', async () => {
    const page = pageOf(await list(adminToken));

    expect(page.data).toHaveLength(20);
    expect(page.meta).toEqual({ page: 1, limit: 20, total: 26, totalPages: 2 });
    const created = page.data.map((u) => u.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it('searches name and email, case-insensitively, and counts only matches', async () => {
    const byName = pageOf(await list(adminToken, '?search=PESSOA%2007'));
    const byEmail = pageOf(await list(adminToken, '?search=pessoa1'));

    expect(byName.data.map((u) => u.email)).toEqual(['pessoa07@example.com']);
    expect(byName.meta.total).toBe(1);
    expect(byEmail.meta.total).toBe(10); // pessoa10 … pessoa19
  });

  it('treats LIKE wildcards in the search as literal characters', async () => {
    expect(pageOf(await list(adminToken, '?search=%25')).meta.total).toBe(0); // "%"
    expect(pageOf(await list(adminToken, '?search=_')).meta.total).toBe(0);
    expect(pageOf(await list(adminToken, '?search=%5C')).meta.total).toBe(0); // "\"
    expect(pageOf(await list(adminToken, '?search=pessoa_7')).meta.total).toBe(0);
  });

  it('still finds names that really contain those characters', async () => {
    await prisma.user.create({
      data: { name: 'Taxa 100% _ok_', email: 'taxa@example.com', passwordHash: 'x' },
    });

    const percent = pageOf(await list(adminToken, '?search=100%25'));
    const underscore = pageOf(await list(adminToken, '?search=_ok_'));

    expect(percent.data.map((u) => u.email)).toEqual(['taxa@example.com']);
    expect(underscore.data.map((u) => u.email)).toEqual(['taxa@example.com']);
  });

  it('sorts by name both ways', async () => {
    const asc = pageOf(await list(adminToken, '?sortBy=name&order=asc&limit=3'));
    const desc = pageOf(await list(adminToken, '?sortBy=name&order=desc&limit=3'));

    expect(asc.data.map((u) => u.name)).toEqual(['Admin Root', 'Pessoa 01', 'Pessoa 02']);
    expect(desc.data.map((u) => u.name)).toEqual(['Pessoa 25', 'Pessoa 24', 'Pessoa 23']);
  });

  it('never shows soft-deleted users, in the data or the total', async () => {
    await prisma.user.update({
      where: { email: 'pessoa07@example.com' },
      data: { deletedAt: new Date() },
    });

    const all = pageOf(await list(adminToken, '?limit=100'));
    const searched = pageOf(await list(adminToken, '?search=pessoa07'));

    expect(all.meta.total).toBe(25);
    expect(all.data.map((u) => u.email)).not.toContain('pessoa07@example.com');
    expect(searched.meta.total).toBe(0);
  });

  it('exposes only public fields', async () => {
    const response = await list(adminToken, '?limit=1');

    expect(Object.keys(pageOf(response).data[0] ?? {}).sort()).toEqual(
      ['createdAt', 'email', 'id', 'name', 'role', 'updatedAt'].sort(),
    );
    expect(response.text).not.toMatch(/passwordHash|deletedAt|argon2/);
  });

  it.each([
    ['an unknown parameter', '?role=ADMIN'],
    ['a column outside the allowlist', '?sortBy=passwordHash'],
    ['a limit above 100', '?limit=1000'],
    ['page zero', '?page=0'],
  ])('rejects %s with 400', async (_case, query) => {
    const response = await list(adminToken, query);

    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
  });
});
