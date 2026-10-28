import { z, ZodError, type core } from 'zod';

import { Prisma } from '../generated/prisma/client.js';

/** Stable codes (English) and default messages (pt-BR) of the error envelope. */
export const errorCatalog = {
  VALIDATION_ERROR: { status: 400, message: 'Os dados enviados são inválidos.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Credenciais inválidas.' },
  UNAUTHORIZED: { status: 401, message: 'Autenticação necessária.' },
  FORBIDDEN: { status: 403, message: 'Você não tem permissão para esta ação.' },
  NOT_FOUND: { status: 404, message: 'Recurso não encontrado.' },
  EMAIL_TAKEN: { status: 409, message: 'Este e-mail já está em uso.' },
  CONFLICT: { status: 409, message: 'A operação conflita com um registro existente.' },
  LAST_ADMIN: {
    status: 409,
    message: 'O último administrador ativo não pode ser rebaixado nem excluído.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: 'O corpo da requisição excede o tamanho permitido.',
  },
  RATE_LIMITED: { status: 429, message: 'Muitas requisições. Tente novamente mais tarde.' },
  INTERNAL: { status: 500, message: 'Erro interno. Tente novamente mais tarde.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof errorCatalog;

export interface ErrorDetail {
  field: string;
  code: string;
}

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly details?: ErrorDetail[],
  ) {
    super(errorCatalog[code].message);
    this.name = 'AppError';
    this.status = errorCatalog[code].status;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: ErrorDetail[] };
}

/** OpenAPI description of ErrorBody (documentation only; responses are built by toErrorBody). */
export const errorBodySchema = z
  .object({
    error: z.object({
      code: z.enum(Object.keys(errorCatalog) as [ErrorCode, ...ErrorCode[]]),
      message: z.string().meta({ example: 'Os dados enviados são inválidos.' }),
      requestId: z.uuid(),
      details: z
        .array(
          z.object({
            field: z.string().meta({ example: 'email' }),
            code: z.string().meta({ example: 'invalid_format' }),
          }),
        )
        .optional(),
    }),
  })
  .meta({ id: 'ErrorResponse' });

/** Custom Zod issues carry their stable detail code in `params.reason`. */
export function customIssue(reason: string): { params: { reason: string } } {
  return { params: { reason } };
}

function detailCodeOf(issue: core.$ZodIssue): string {
  const reason =
    issue.code === 'custom'
      ? (issue.params as { reason?: unknown } | undefined)?.reason
      : undefined;
  return typeof reason === 'string' ? reason : issue.code;
}

export function toErrorBody(error: AppError, requestId: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details?.length ? { details: error.details } : {}),
    },
  };
}

/** Field names for body issues are bare (`email`); query and params are prefixed (`query.limit`). */
export function zodIssuesToDetails(
  issues: readonly core.$ZodIssue[],
  location?: 'query' | 'params',
): ErrorDetail[] {
  const fieldOf = (path: readonly PropertyKey[]): string =>
    [location, ...path.map(String)].filter(Boolean).join('.') || 'body';

  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          field: fieldOf([...issue.path, key]),
          code: 'unrecognized_key',
        }))
      : [{ field: fieldOf(issue.path), code: detailCodeOf(issue) }],
  );
}

/**
 * A 4xx raised by Express itself: body-parser errors carry a `type`; the router raises a
 * URIError with `status` 400 for a malformed percent-encoded path.
 */
interface ClientHttpError extends Error {
  status: number;
  type?: string;
}

function isClientHttpError(error: unknown): error is ClientHttpError {
  const status = (error as Partial<ClientHttpError> | undefined)?.status;
  return error instanceof Error && typeof status === 'number' && status >= 400 && status < 500;
}

function clientErrorDetail(error: ClientHttpError): ErrorDetail {
  if (error.type === 'entity.parse.failed') return { field: 'body', code: 'invalid_json' };
  if (error.type) return { field: 'body', code: 'invalid_body' };
  if (error instanceof URIError) return { field: 'params', code: 'invalid_encoding' };
  return { field: 'request', code: 'invalid_request' };
}

/** Maps anything thrown in a request to an AppError; unknown errors become INTERNAL. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', zodIssuesToDetails(error.issues));
  }
  if (isClientHttpError(error)) {
    if (error.status === 413) return new AppError('PAYLOAD_TOO_LARGE');
    return new AppError('VALIDATION_ERROR', [clientErrorDetail(error)]);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new AppError('CONFLICT');
  }
  return new AppError('INTERNAL');
}
