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
  roleSchema,
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

/** A malformed id is a 400; a well-formed id of a missing or deleted user is a 404. */
const userIdParamsSchema = z.strictObject({ id: z.uuid() });

const changeRoleBodySchema = z.strictObject({ role: roleSchema }).meta({ id: 'ChangeRoleRequest' });

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
    // Admin routes on /users/:id come after /users/me, so 'me' is never read as an id.
    defineRoute({
      method: 'get',
      path: '/users/:id',
      tags: ['Users (admin)'],
      summary: 'Consulta um usuário',
      schemas: { params: userIdParamsSchema },
      access: authenticate,
      requireRole: 'ADMIN',
      success: { status: 200, description: 'Perfil público.', schema: profileResponseSchema },
      errors: {
        400: 'id não é um UUID.',
        404: '`NOT_FOUND`: não existe ou foi excluído.',
      },
      handler: async ({ params }, _req, res) => {
        res.status(200).json({ data: await userService.getById(params.id) });
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/users/:id',
      tags: ['Users (admin)'],
      summary: 'Edita nome e e-mail de um usuário',
      description: 'Só `name` e `email`. O papel muda por `PATCH /users/{id}/role`.',
      schemas: { params: userIdParamsSchema, body: updateProfileBodySchema },
      access: authenticate,
      requireRole: 'ADMIN',
      success: { status: 200, description: 'Usuário atualizado.', schema: profileResponseSchema },
      errors: {
        400: 'id inválido, campo não permitido ou nenhum campo enviado.',
        404: '`NOT_FOUND`: não existe ou foi excluído.',
        409: '`EMAIL_TAKEN`: o e-mail já pertence a outra conta.',
      },
      handler: async ({ params, body }, req, res) => {
        const user = await userService.updateById(params.id, body);
        req.log.info(
          {
            event: 'user_updated_by_admin',
            actorId: currentUserOf(res).id,
            targetId: user.id,
            fields: Object.keys(body).sort(),
          },
          'user updated by admin',
        );
        res.status(200).json({ data: user });
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/users/:id/role',
      tags: ['Users (admin)'],
      summary: 'Muda o papel de um usuário',
      description:
        'Entre `USER` e `ADMIN`. O último administrador ativo não pode ser rebaixado, nem por ele mesmo. Vale na hora: o papel é relido a cada requisição.',
      schemas: { params: userIdParamsSchema, body: changeRoleBodySchema },
      access: authenticate,
      requireRole: 'ADMIN',
      success: { status: 200, description: 'Papel atualizado.', schema: profileResponseSchema },
      errors: {
        400: 'id inválido ou `role` fora de USER/ADMIN.',
        404: '`NOT_FOUND`: não existe ou foi excluído.',
        409: '`LAST_ADMIN`: rebaixaria o último administrador ativo.',
      },
      handler: async ({ params, body }, req, res) => {
        const { user, previousRole } = await userService.changeRole(
          currentUserOf(res).id,
          params.id,
          body.role,
        );
        if (previousRole !== user.role) {
          req.log.info(
            {
              event: 'role_changed',
              actorId: currentUserOf(res).id,
              targetId: user.id,
              from: previousRole,
              to: user.role,
            },
            'role changed',
          );
        }
        res.status(200).json({ data: user });
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/users/:id',
      tags: ['Users (admin)'],
      summary: 'Exclui um usuário (exclusão lógica)',
      description:
        'O usuário sai das listagens e consultas, não consegue entrar e tem todas as sessões encerradas; o e-mail continua reservado. O último administrador ativo não pode ser excluído. Repetir a exclusão dá 404.',
      schemas: { params: userIdParamsSchema },
      access: authenticate,
      requireRole: 'ADMIN',
      success: { status: 204, description: 'Usuário excluído e sessões encerradas.' },
      errors: {
        400: 'id não é um UUID.',
        404: '`NOT_FOUND`: não existe ou já foi excluído.',
        409: '`LAST_ADMIN`: excluiria o último administrador ativo.',
      },
      handler: async ({ params }, req, res) => {
        const { revokedSessions } = await userService.softDelete(currentUserOf(res).id, params.id);
        req.log.info(
          {
            event: 'user_deleted',
            actorId: currentUserOf(res).id,
            targetId: params.id,
            revokedSessions,
          },
          'user deleted',
        );
        res.status(204).end();
      },
    }),
  ];
}
