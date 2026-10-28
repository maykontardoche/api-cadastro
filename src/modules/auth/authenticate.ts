import type { RequestHandler } from 'express';

import { setCurrentUser } from '../../http/current-user.js';
import { AppError } from '../../http/errors.js';
import type { UserRepository } from '../users/user.repository.js';
import type { TokenService } from './token.service.js';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export interface AuthenticateDeps {
  tokens: TokenService;
  users: UserRepository;
}

/**
 * Requires a valid access token and re-reads the user on every request, so a role change or a
 * deletion takes effect immediately instead of when the token expires. The role is never read
 * from the token.
 */
export function createAuthenticate({ tokens, users }: AuthenticateDeps): RequestHandler {
  return async (req, res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? '');
    if (!match?.[1]) throw new AppError('UNAUTHORIZED');

    const { userId } = await tokens.verifyAccess(match[1]);
    const user = await users.findActiveById(userId);
    if (!user) throw new AppError('UNAUTHORIZED');

    setCurrentUser(res, user);
    next();
  };
}
