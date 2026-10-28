import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

const checkStateSchema = z.enum(['ok', 'unavailable']);

const readinessSchema = z
  .object({ status: checkStateSchema, checks: z.object({ database: checkStateSchema }) })
  .meta({ id: 'Readiness' });

export function registerHealthDocs(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/health/live',
    tags: ['Health'],
    summary: 'O processo está no ar',
    description: 'Não consulta nenhuma dependência. Não tem limite de taxa.',
    responses: {
      200: {
        description: 'Processo respondendo.',
        content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/health/ready',
    tags: ['Health'],
    summary: 'A API está pronta para atender',
    description:
      'Confere o banco com prazo de 2 s. Nunca expõe o erro, o host ou a connection string.',
    responses: {
      200: {
        description: 'Banco respondendo.',
        content: { 'application/json': { schema: readinessSchema } },
      },
      503: {
        description: 'Banco indisponível ou sem resposta no prazo.',
        content: { 'application/json': { schema: readinessSchema } },
      },
    },
  });
}
