import type { RequestHandler } from 'express';
import { z } from 'zod';

import { currentUserOf } from '../../http/current-user.js';
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

/** Fictitious, with the real length (43) so the example matches the documented format. */
const EXAMPLE_REFRESH_TOKEN = 'EXAMPLE-refresh-token-43-chars-base64url-xx';

export const loginResponseSchema = z
  .object({
    data: z.object({
      accessToken: z.string().meta({
        description: 'JWT de acesso; envie como `Bearer`.',
        example: 'EXAMPLE-access-token-not-a-real-jwt',
      }),
      tokenType: z.literal('Bearer'),
      expiresIn: z
        .number()
        .int()
        .meta({ description: 'Validade do access token, em segundos.', example: 900 }),
      refreshToken: z.string().meta({
        description: 'Opaco; usado para renovar a sessão.',
        example: EXAMPLE_REFRESH_TOKEN,
      }),
      user: publicUserSchema,
    }),
  })
  .meta({ id: 'LoginResponse' });

/** Refresh tokens are 43 base64url characters; the upper bound only rejects absurd input. */
const REFRESH_TOKEN_MAX_LENGTH = 256;

export const refreshTokenBodySchema = z
  .strictObject({
    refreshToken: z.string().min(1).max(REFRESH_TOKEN_MAX_LENGTH).meta({
      description: 'O `refreshToken` recebido no login ou na última renovação.',
      example: EXAMPLE_REFRESH_TOKEN,
    }),
  })
  .meta({ id: 'RefreshTokenRequest' });

export const changePasswordBodySchema = z
  .strictObject({
    currentPassword: z
      .string()
      .min(1)
      .max(LOGIN_PASSWORD_MAX_LENGTH)
      .meta({ example: 'uma frase longa que so eu sei' }),
    newPassword: newPasswordSchema,
  })
  .meta({ id: 'ChangePasswordRequest' });

const CREDENTIAL_RATE_LIMITED_DESCRIPTION =
  '`RATE_LIMITED`: limite das rotas de credencial (20 a cada 15 min por IP, cota compartilhada entre elas) ou o limite global excedido. Cabeçalhos `RateLimit` e `RateLimit-Policy`.';

export interface AuthRoutesDeps {
  userService: UserService;
  authService: AuthService;
  /** Shared by every credential route, so one client has one quota across all of them. */
  authLimiter: RequestHandler;
  authenticate: RequestHandler;
}

export function createAuthRoutes({
  userService,
  authService,
  authLimiter,
  authenticate,
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
        429: CREDENTIAL_RATE_LIMITED_DESCRIPTION,
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
        429: CREDENTIAL_RATE_LIMITED_DESCRIPTION,
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
    defineRoute({
      method: 'post',
      path: '/auth/refresh',
      tags: ['Auth'],
      summary: 'Renova a sessão',
      description:
        'Troca o refresh token por um par novo; o token enviado deixa de valer. Reapresentar um token já usado encerra todas as sessões daquela cadeia (sinal de roubo). Credencial no body: não usa o access token.',
      schemas: { body: refreshTokenBodySchema },
      access: 'public',
      middlewares: [authLimiter],
      success: { status: 200, description: 'Sessão renovada.', schema: loginResponseSchema },
      errors: {
        400: 'Body inválido (sem `refreshToken`, vazio ou com campo extra).',
        401: '`UNAUTHORIZED`: token desconhecido, expirado, já usado ou de conta excluída. A resposta não diz qual.',
        429: CREDENTIAL_RATE_LIMITED_DESCRIPTION,
      },
      handler: async ({ body }, req, res) => {
        const result = await authService.refresh(body.refreshToken);
        if (result.outcome === 'rotated') {
          res.status(200).json({ data: result.session });
          return;
        }
        if (result.outcome === 'reused') {
          // Never the token itself: the family and the account are enough to investigate.
          req.log.warn(
            {
              event: 'refresh_reuse_detected',
              userId: result.userId,
              familyId: result.familyId,
              revokedSessions: result.revokedSessions,
              afterRotation: result.afterRotation,
            },
            'refresh token reuse detected',
          );
        }
        throw new AppError('UNAUTHORIZED');
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/logout',
      tags: ['Auth'],
      summary: 'Encerra a sessão',
      description:
        'Revoga a sessão do refresh token enviado. Responde 204 também quando o token é desconhecido ou já foi revogado, sem revelar o estado. O access token já emitido continua válido até expirar (até 15 min).',
      schemas: { body: refreshTokenBodySchema },
      access: 'public',
      success: { status: 204, description: 'Sessão encerrada (ou já não existia).' },
      errors: { 400: 'Body inválido (sem `refreshToken`, vazio ou com campo extra).' },
      handler: async ({ body }, _req, res) => {
        await authService.logout(body.refreshToken);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/change-password',
      tags: ['Auth'],
      summary: 'Troca a própria senha',
      description:
        'Exige a senha atual. A nova segue a política do cadastro. Em sucesso, encerra todas as sessões de renovação do usuário, inclusive a atual; o access token já emitido vale até expirar (até 15 min).',
      schemas: { body: changePasswordBodySchema },
      access: authenticate,
      middlewares: [authLimiter],
      success: { status: 204, description: 'Senha trocada e sessões encerradas.' },
      errors: {
        400: 'Dados inválidos ou nova senha fora da política (curta, longa ou comum).',
        401: '`INVALID_CREDENTIALS`: senha atual incorreta. `UNAUTHORIZED`: token ausente ou inválido.',
        429: CREDENTIAL_RATE_LIMITED_DESCRIPTION,
      },
      handler: async ({ body }, req, res) => {
        const userId = currentUserOf(res).id;
        try {
          const { revokedSessions } = await authService.changePassword(userId, body);
          req.log.info({ event: 'password_changed', userId, revokedSessions }, 'password changed');
          res.status(204).end();
        } catch (error) {
          if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS') {
            req.log.info({ event: 'password_change_rejected', userId }, 'password change rejected');
          }
          throw error;
        }
      },
    }),
  ];
}
