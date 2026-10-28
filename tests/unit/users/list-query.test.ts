import { describe, expect, it } from 'vitest';

import { zodIssuesToDetails } from '../../../src/http/errors.js';
import { listUsersQuerySchema } from '../../../src/modules/users/user.schema.js';

function issuesOf(query: Record<string, unknown>) {
  const result = listUsersQuerySchema.safeParse(query);
  return result.success ? [] : zodIssuesToDetails(result.error.issues, 'query');
}

describe('listUsersQuerySchema', () => {
  it('applies defaults', () => {
    expect(listUsersQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      order: 'desc',
    });
  });

  it('coerces numbers from the query string', () => {
    expect(listUsersQuerySchema.parse({ page: '3', limit: '50' })).toMatchObject({
      page: 3,
      limit: 50,
    });
  });

  it.each([
    [{ page: '0' }, 'query.page'],
    [{ page: '-1' }, 'query.page'],
    [{ page: '1.5' }, 'query.page'],
    [{ page: '10001' }, 'query.page'],
    [{ page: 'abc' }, 'query.page'],
    [{ limit: '0' }, 'query.limit'],
    [{ limit: '101' }, 'query.limit'],
    [{ search: 'x'.repeat(101) }, 'query.search'],
    [{ search: '   ' }, 'query.search'],
    [{ sortBy: 'password' }, 'query.sortBy'],
    [{ sortBy: 'passwordHash' }, 'query.sortBy'],
    [{ sortBy: 'role; DROP TABLE users' }, 'query.sortBy'],
    [{ order: 'sideways' }, 'query.order'],
    [{ page: ['1', '2'] }, 'query.page'],
  ])('rejects %j', (query, field) => {
    expect(issuesOf(query).map((issue) => issue.field)).toEqual([field]);
  });

  it.each([
    [{ limit: '1' }],
    [{ limit: '100' }],
    [{ page: '10000' }],
    [{ search: 'x'.repeat(100) }],
    [{ sortBy: 'name', order: 'asc' }],
    [{ sortBy: 'email' }],
  ])('accepts the boundary %j', (query) => {
    expect(issuesOf(query)).toEqual([]);
  });

  it('rejects unknown parameters', () => {
    expect(issuesOf({ role: 'ADMIN', deletedAt: 'x' })).toEqual([
      { field: 'query.role', code: 'unrecognized_key' },
      { field: 'query.deletedAt', code: 'unrecognized_key' },
    ]);
  });

  it('trims the search term', () => {
    expect(listUsersQuerySchema.parse({ search: '  ana  ' }).search).toBe('ana');
  });
});
