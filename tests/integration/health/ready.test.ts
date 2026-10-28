import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../../src/app.js';
import { createPrismaClient, pingDatabase } from '../../../src/db/prisma.js';
import { createTestPrisma } from '../../helpers/db.js';

describe('GET /health/ready', () => {
  const prisma = createTestPrisma();
  // Port 1 refuses connections immediately; the credentials are fictitious.
  const unreachableUrl = 'postgresql://example:EXAMPLE@127.0.0.1:1/unreachable_db';
  const unreachable = createPrismaClient(unreachableUrl);

  afterAll(async () => {
    await Promise.all([prisma.$disconnect(), unreachable.$disconnect()]);
  });

  it('responds 200 when the database answers', async () => {
    const app = createApp({ checkDatabase: () => pingDatabase(prisma) });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('responds 503 without leaking details when the database is unreachable', async () => {
    const app = createApp({ checkDatabase: () => pingDatabase(unreachable) });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable', checks: { database: 'unavailable' } });
    for (const leak of ['127.0.0.1', 'unreachable_db', 'EXAMPLE', 'ECONNREFUSED', 'postgresql']) {
      expect(response.text).not.toContain(leak);
    }
  });

  it('responds 503 when the database does not answer within the deadline', async () => {
    const app = createApp({
      checkDatabase: () => new Promise<void>(() => undefined),
      readinessTimeoutMs: 50,
    });

    const startedAt = Date.now();
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
