import type { RequestHandler } from 'express';
import { z } from 'zod';

import { defineRoute, type RouteDefinition } from '../../http/route.js';
import { emailSchema, nameSchema, publicUserSchema } from '../users/user.schema.js';
import type { UserService } from '../users/user.service.js';
import { newPasswordSchema } from './password.js';

export const registerBodySchema = z
  .strictObject({ name: nameSchema, email: emailSchema, password: newPasswordSchema })
  .meta({ id: 'RegisterRequest' });

export interface AuthRoutesDeps {
  userService: UserService;
  /** Shared by every credential route, so one client has one quota across all of them. */
  authLimiter: RequestHandler;
}

export function createAuthRoutes({ userService, authLimiter }: AuthRoutesDeps): RouteDefinition[] {
  return [
    defineRoute({
      method: 'post',
      path: '/auth/register',
      tags: ['Auth'],
      summary: 'Cria uma conta de usuário',
      description:
        'Cadastro público. Sempre cria o papel USER; enviar `role` (ou qualquer campo extra) resulta em 400.',
      schemas: { body: registerBodySchema },
      middlewares: [authLimiter],
      success: {
        status: 201,
        description: 'Conta criada. A resposta nunca traz senha nem hash.',
        schema: z.object({ data: publicUserSchema }),
      },
      errors: {
        400: 'Dados inválidos (campo ausente, extra, e-mail inválido, senha curta ou comum).',
        409: '`EMAIL_TAKEN`: o e-mail já pertence a uma conta, inclusive excluída.',
        429: 'Limite de tentativas nas rotas de credencial excedido.',
      },
      handler: async ({ body }, req, res) => {
        const user = await userService.register(body);
        req.log.info({ event: 'user_registered', userId: user.id }, 'user registered');
        res.status(201).json({ data: user });
      },
    }),
  ];
}
