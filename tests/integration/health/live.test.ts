import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../../helpers/app.js';

describe('GET /health/live', () => {
  // A check that always fails proves liveness does not depend on the database.
  const app = buildTestApp({ checkDatabase: () => Promise.reject(new Error('database is down')) });

  it('responds 200 even when the database is down', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('does not expose the framework header', async () => {
    const response = await request(app).get('/health/live');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('does not answer 200 for an unknown route', async () => {
    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
  });
});
