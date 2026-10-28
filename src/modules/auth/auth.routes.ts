import type { RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../http/errors.js';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import { emailSchema, nameSchema, publicUserSchema } from '../users/user.schema.js';
import type { UserService } from '../users/user.service.js';
import type { AuthService } from './auth.service.js';
import { newPasswordSchema } from './password.js';

export const registerBodySchema = z
  .strictObject({ name: nameSchema, email: emailSchema, password: newPasswordSchema })
  .meta({ id: 'RegisterRequest' });

/** Upper bound on what login hashes, so a huge input cannot be used to burn CPU in Argon2id. */
const LOGIN_PASSWORD_MAX_LENGTH = 1024;

/** Login does not apply the new-password policy: it only bounds the input Argon2id will hash. */
export const loginBodySchema = z
  .strictObject({
    email: emailSchema,
    password: z
      .string()
      .min(1)
      .max(LOGIN_PASSWORD_MAX_LENGTH)
      .meta({ example: 'uma frase longa que so eu sei' }),
  })
  .meta({ id: 'LoginRequest' });

export const loginResponseSchema = z
  .object({
    data: z.object({
      accessToken: z.string().meta({ description: 'JWT de acesso; envie como `Bearer`.' }),
      tokenType: z.literal('Bearer'),
      expiresIn: z
        .number()
        .int()
        .meta({ description: 'Validade do access token, em segundos.', example: 900 }),
      refreshToken: z.string().meta({ description: 'Opaco; usado para renovar a sessão.' }),
      user: publicUserSchema,
    }),
  })
  .meta({ id: 'LoginResponse' });

export interface AuthRoutesDeps {
  userService: UserService;
  authService: AuthService;
  /** Shared by every credential route, so one client has one quota across all of them. */
  authLimiter: RequestHandler;
}

export function createAuthRoutes({
  userService,
  authService,
  authLimiter,
}: AuthRoutesDeps): RouteDefinition[] {
  return [
    defineRoute({
      method: 'post',
      path: '/auth/register',
      tags: ['Auth'],
      summary: 'Cria uma conta de usuário',
      description:
        'Cadastro público. Sempre cria o papel USER; enviar `role` (ou qualquer campo extra) resulta em 400.',
      schemas: { body: registerBodySchema },
      access: 'public',
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
    defineRoute({
      method: 'post',
      path: '/auth/login',
      tags: ['Auth'],
      summary: 'Entra com e-mail e senha',
      description:
        'Devolve um access token de 15 minutos e um refresh token. Qualquer falha (e-mail desconhecido, conta excluída ou senha errada) tem a mesma resposta 401.',
      schemas: { body: loginBodySchema },
      access: 'public',
      middlewares: [authLimiter],
      success: { status: 200, description: 'Sessão iniciada.', schema: loginResponseSchema },
      errors: {
        400: 'Dados inválidos (e-mail mal formado, senha vazia ou campo extra).',
        401: '`INVALID_CREDENTIALS`: e-mail ou senha incorretos. A resposta não diz qual.',
        429: 'Limite de tentativas nas rotas de credencial excedido.',
      },
      handler: async ({ body }, req, res) => {
        try {
          const result = await authService.login(body);
          req.log.info({ event: 'login_succeeded', userId: result.user.id }, 'login succeeded');
          res.status(200).json({ data: result });
        } catch (error) {
          // No email in the log: the failure is counted, the target account is not exposed.
          if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS') {
            req.log.info({ event: 'login_failed' }, 'login failed');
          }
          throw error;
        }
      },
    }),
  ];
}
