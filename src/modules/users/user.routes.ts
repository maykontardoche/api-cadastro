import type { RequestHandler } from 'express';
import { z } from 'zod';

import { currentUserOf } from '../../http/current-user.js';
import { customIssue } from '../../http/errors.js';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import {
  emailSchema,
  listUsersQuerySchema,
  nameSchema,
  publicUserSchema,
  toPublicUser,
  usersPageSchema,
} from './user.schema.js';
import type { UserService } from './user.service.js';

/** Only name and email; any other field (role, id, password, dates) is an unknown key → 400. */
export const updateProfileBodySchema = z
  .strictObject({ name: nameSchema.optional(), email: emailSchema.optional() })
  .refine((changes) => changes.name !== undefined || changes.email !== undefined, {
    message: 'Envie ao menos um campo para alterar.',
    ...customIssue('empty_update'),
  })
  .meta({ id: 'UpdateProfileRequest' });

const profileResponseSchema = z.object({ data: publicUserSchema });

export interface UserRoutesDeps {
  userService: UserService;
  /** Injected, so this module does not depend on how authentication works. */
  authenticate: RequestHandler;
}

export function createUserRoutes({ userService, authenticate }: UserRoutesDeps): RouteDefinition[] {
  return [
    defineRoute({
      method: 'get',
      path: '/users',
      tags: ['Users (admin)'],
      summary: 'Lista usuários (paginado)',
      description:
        'Só ADMIN. Usuários excluídos não aparecem nem contam no total. Ordenação só pelos campos listados, com desempate por id; qualquer parâmetro fora da lista resulta em 400.',
      schemas: { query: listUsersQuerySchema },
      access: authenticate,
      requireRole: 'ADMIN',
      success: { status: 200, description: 'Uma página de usuários.', schema: usersPageSchema },
      errors: {
        400: 'Parâmetro desconhecido ou fora dos limites (page, limit, search, sortBy, order).',
      },
      handler: async ({ query }, _req, res) => {
        res.status(200).json(await userService.list(query));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/users/me',
      tags: ['Users'],
      summary: 'Perfil do usuário autenticado',
      description: 'Resolvido pelo token, nunca por parâmetro: não há como ler outro usuário aqui.',
      schemas: {},
      access: authenticate,
      success: { status: 200, description: 'Perfil público.', schema: profileResponseSchema },
      errors: {},
      handler: (_input, _req, res) => {
        res.status(200).json({ data: toPublicUser(currentUserOf(res)) });
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/users/me',
      tags: ['Users'],
      summary: 'Edita o próprio nome e e-mail',
      description:
        'Aceita só `name` e `email`, normalizados como no cadastro. Qualquer outro campo, como `role`, resulta em 400.',
      schemas: { body: updateProfileBodySchema },
      access: authenticate,
      success: { status: 200, description: 'Perfil atualizado.', schema: profileResponseSchema },
      errors: {
        400: 'Dados inválidos, campo não permitido ou nenhum campo enviado (`empty_update`).',
        409: '`EMAIL_TAKEN`: o e-mail já pertence a outra conta, inclusive excluída.',
      },
      handler: async ({ body }, req, res) => {
        const user = await userService.updateSelf(currentUserOf(res).id, body);
        // Which fields changed, never their values (the email is personal data).
        req.log.info(
          { event: 'profile_updated', userId: user.id, fields: Object.keys(body).sort() },
          'profile updated',
        );
        res.status(200).json({ data: user });
      },
    }),
  ];
}
