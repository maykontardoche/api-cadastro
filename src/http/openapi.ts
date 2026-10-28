import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import { registerHealthDocs } from '../modules/health/health.openapi.js';
import { BEARER_AUTH, type RouteDefinition } from './route.js';

export const API_PREFIX = '/api/v1';
const API_VERSION = '0.1.0';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export function buildOpenApiDocument(apiRoutes: readonly RouteDefinition[]): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', BEARER_AUTH, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Access token devolvido pelo login (`accessToken`), válido por 15 minutos. No Swagger, use o botão Authorize.',
  });
  registerHealthDocs(registry);
  for (const route of apiRoutes) route.document(registry, API_PREFIX);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'API Cadastro',
      version: API_VERSION,
      description:
        'API REST de cadastro e gestão de usuários. Todo erro segue o envelope `ErrorResponse` e ' +
        'toda resposta traz `X-Request-Id`.',
    },
  });
}

/** Serves the document at /openapi.json and the interactive Swagger UI at /docs. */
export function createDocsRouter(document: OpenApiDocument): Router {
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });
  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(document, { customSiteTitle: 'API Cadastro' }),
  );
  return router;
}
