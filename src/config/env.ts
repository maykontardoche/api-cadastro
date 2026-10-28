import { z } from 'zod';

const MIN_SECRET_BYTES = 32;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_ACCESS_SECRET: z
    .string()
    .refine((value) => Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES),
  JWT_ISSUER: z.string().min(1).default('api-cadastro'),
  JWT_AUDIENCE: z.string().min(1).default('api-cadastro-client'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

export type Env = z.infer<typeof envSchema>;

/** Carries only the names of the invalid variables — never their values. */
export class EnvValidationError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid environment variables: ${variables.join(', ')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort();
  throw new EnvValidationError(variables);
}
