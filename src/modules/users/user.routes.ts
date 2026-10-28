import type { RequestHandler } from 'express';
import { z } from 'zod';

import { currentUserOf } from '../../http/current-user.js';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import { publicUserSchema, toPublicUser } from './user.schema.js';

export interface UserRoutesDeps {
  /** Injected, so this module does not depend on how authentication works. */
  authenticate: RequestHandler;
}

export function createUserRoutes({ authenticate }: UserRoutesDeps): RouteDefinition[] {
  return [
    defineRoute({
      method: 'get',
      path: '/users/me',
      tags: ['Users'],
      summary: 'Perfil do usuário autenticado',
      description: 'Resolvido pelo token, nunca por parâmetro: não há como ler outro usuário aqui.',
      schemas: {},
      access: authenticate,
      success: {
        status: 200,
        description: 'Perfil público.',
        schema: z.object({ data: publicUserSchema }),
      },
      errors: {},
      handler: (_input, _req, res) => {
        res.status(200).json({ data: toPublicUser(currentUserOf(res)) });
      },
    }),
  ];
}
