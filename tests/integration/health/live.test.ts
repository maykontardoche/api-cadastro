import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../../src/app.js';

describe('GET /health/live', () => {
  const app = createApp();

  it('responds 200 without any dependency', async () => {
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
