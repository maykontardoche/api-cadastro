import type { Response } from 'express';

import type { UserWithoutSecrets } from '../modules/users/user.repository.js';
import { AppError } from './errors.js';

const KEY = 'currentUser';

/** Set by the authentication middleware with the user re-read from the database. */
export function setCurrentUser(res: Response, user: UserWithoutSecrets): void {
  res.locals[KEY] = user;
}

/** The authenticated user; only valid on routes behind the authentication middleware. */
export function currentUserOf(res: Response): UserWithoutSecrets {
  const user = res.locals[KEY] as UserWithoutSecrets | undefined;
  // Reaching here without a user is a wiring bug, never a client error: fail closed.
  if (!user) throw new AppError('UNAUTHORIZED');
  return user;
}
