import { describe, expect, it } from 'vitest';

import { passesWithin } from '../../../src/modules/health/passes-within.js';

describe('passesWithin', () => {
  it('is true when the check resolves in time', async () => {
    await expect(passesWithin(() => Promise.resolve(), 100)).resolves.toBe(true);
  });

  it('is false when the check rejects', async () => {
    await expect(passesWithin(() => Promise.reject(new Error('down')), 100)).resolves.toBe(false);
  });

  it('is false when the check throws synchronously', async () => {
    const throwing = (): Promise<void> => {
      throw new Error('boom');
    };

    await expect(passesWithin(throwing, 100)).resolves.toBe(false);
  });

  it('is false when the check outlives the deadline', async () => {
    await expect(passesWithin(() => new Promise<void>(() => undefined), 20)).resolves.toBe(false);
  });
});
