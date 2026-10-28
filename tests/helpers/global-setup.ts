import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { testDatabaseUrl } from './db.js';

const prismaCli = resolve(import.meta.dirname, '../../node_modules/prisma/build/index.js');

/** Applies the versioned migrations to the test database once per run. */
export default function setup(): void {
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}
