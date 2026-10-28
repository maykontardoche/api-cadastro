---
status: Aceito
date: 2026-10-28
decision-makers: Maykon Tardoche
---

# ADR-0004: Gerar o OpenAPI a partir das mesmas declarações que montam as rotas

## Contexto e problema

Um dos critérios de sucesso do MVP é que a documentação corresponda ao comportamento
implementado: cada endpoint documentado se comporta como descrito, e nenhuma rota existe fora da
documentação. A validação de entrada já é feita com schemas Zod (`src/http/middlewares/validate.ts`).

Um OpenAPI escrito à mão, em YAML, repetiria campos, limites e erros que já estão nesses schemas, e
divergiria do código na primeira mudança esquecida. A documentação também passou a ser a tela de
teste do projeto (Swagger UI em `/docs`), então um documento desatualizado engana quem testa.

## Drivers da decisão

1. Documentação e comportamento não podem divergir.
2. Uma tela de teste confiável desde o primeiro endpoint.
3. Pouca cerimônia por endpoint.

## Alternativas consideradas

1. **Declaração única por rota, com OpenAPI gerado dos schemas Zod**
   (`@asteasolutions/zod-to-openapi` 9).
2. **YAML escrito à mão**, mais um teste que compara o documento com as rotas.
3. **Gerar o OpenAPI a partir de anotações em comentários** (JSDoc).

## Decisão

Escolhida: **declaração única por rota**, porque é a única opção em que a divergência não tem como
acontecer: o mesmo objeto monta a rota e a documenta.

Passa a valer:

- Toda rota de `/api/v1` é declarada com `defineRoute` (`src/http/route.ts`), com método, path,
  schemas, resposta de sucesso, erros possíveis, middlewares e handler.
- Dessa declaração saem a rota do Express (`mount`) e a operação no OpenAPI (`document`).
- O documento é OpenAPI 3.1, servido em `/openapi.json`, com o Swagger UI em `/docs`.
- Os endpoints de health ficam fora de `/api/v1` e são documentados à parte, em
  `src/modules/health/health.openapi.ts`.

## Consequências

- **Positivas:** os limites, os formatos e os exemplos do Swagger são os mesmos que a validação
  aplica. Uma rota nova aparece na tela de teste sem passo extra.
- **Negativas:** rotas fora do `defineRoute` não são documentadas (hoje só as de health). O
  documento depende da cobertura do Zod 4 pelo `zod-to-openapi`.
- **Riscos e mitigação:** alguém montar uma rota direto no Express, sem `defineRoute`. Mitigação:
  o teste de contrato (`tests/integration/openapi/contract.test.ts`) lê as rotas que o Express de
  fato montou, percorrendo a pilha do router, e exige que sejam exatamente as operações
  documentadas (mais o próprio `/openapi.json`). Um caso do teste monta uma rota sem documentação
  e confirma que a comparação falha. Outro exige que cada rota documentada responda sem cair no
  404 de fallback.
- **Limitação conhecida:** regras escritas em `refine`/`superRefine` não viram JSON Schema. Os
  limites delas (como o tamanho da senha, contado por code point) são repetidos em `.meta()` ao
  lado da regra.
- **Passa a ser obrigatório:** rota nova em `/api/v1` só por `defineRoute`, com `summary` e os
  erros que ela pode devolver.

## Confirmação

O teste de contrato roda em `npm test`. Na revisão de cada PR, nenhum `router.get/post/...`
direto em `src/modules/`.

## Prós e contras das alternativas

### YAML escrito à mão

- Prós: controle total do texto do documento.
- Contras: duplica os schemas; o teste só detecta a divergência depois que ela existe.
- Drivers: perde em 1 e 3.

### Anotações em comentários

- Prós: fica perto do código.
- Contras: o comentário não é verificado contra a validação real; é YAML com outra sintaxe.
- Drivers: perde em 1.

## Links

- ADRs relacionados: ADR-0002 (TypeScript, que permite tipar o handler a partir dos schemas).
- Doc oficial consultada: README do `@asteasolutions/zod-to-openapi` 9.1.0 (pacote instalado),
  seção "Using zod's .meta".
