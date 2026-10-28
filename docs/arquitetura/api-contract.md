# API Contract — API Cadastro

> Registro de endpoints da **API Cadastro** (diretório `.`).
>
> **Consulte antes de criar endpoint novo**, para não duplicar.
> **Atualize ao criar ou alterar endpoint, na mesma mudança que o código.**
>
> Fonte gerada: `GET /openapi.json` (OpenAPI 3.1), com o Swagger UI em `GET /docs`. Os dois saem
> das mesmas declarações que montam as rotas (ADR-0004). Este registro resume o contrato e as
> regras; em caso de dúvida sobre um campo, o `/openapi.json` vence.

## Convenções

- **Estilo e prefixo:** REST com JSON e prefixo `/api/v1`. Os recursos usam nomes em inglês
  (`auth`, `users`). Os endpoints de saúde ficam fora do prefixo (`/health/*`).
- **Versionamento:** `/v1` no caminho. Uma breaking change exige `/v2` ou evolução aditiva; ver
  *Compatibilidade*.
- **Formatos:** ids são UUID v7 em string; instantes seguem ISO 8601 em UTC
  (`2026-10-28T12:00:00.000Z`).
- **Nulabilidade:** campos opcionais ausentes não são enviados. Uma lista nunca é `null`.
- **Enums de resposta:** `role` ∈ {`USER`, `ADMIN`}, **fechado**.
- **Paginação:** offset com `?page=&limit=`; padrão 20, máximo 100. Envelope
  `{ data: [], meta: { page, limit, total, totalPages } }`. Ordenação com `?sortBy=&order=`
  restrita a uma whitelist, com desempate por `id`.
- **Filtros:** `search` com até 100 caracteres. Um parâmetro desconhecido resulta em **400**.
- **Erro** ✅: envelope próprio
  `{ "error": { "code", "message", "requestId", "details?": [{ "field", "code" }] } }`. A
  mensagem vem em pt-BR e o `code` é estável, em inglês. Um erro inesperado nunca expõe stack,
  SQL ou detalhe interno. `details` só aparece quando há campos a apontar.
  - `field`: nome do campo do body (`email`, `profile.name`); `query.<campo>` e
    `params.<campo>` para query e path; `body` quando o problema é o corpo inteiro.
  - `details[].code`: o código do Zod (`invalid_type`, `too_small`, `invalid_format`...),
    `unrecognized_key` (campo não permitido), `invalid_json` (JSON malformado),
    `invalid_body` (charset ou encoding não suportado) ou `invalid_encoding` (`field: params`,
    path com percent-encoding malformado).
  - Todos os problemas de body, query e params vêm juntos num único 400.
- **Status de recusa:**

  | Status | `code` | Quando |
  |---|---|---|
  | 400 | `VALIDATION_ERROR` | Entrada malformada ou inválida, inclusive campo não permitido |
  | 401 | `UNAUTHORIZED`, `INVALID_CREDENTIALS` | Sem sessão ou credencial inválida |
  | 403 | `FORBIDDEN` | Sem permissão |
  | 404 | `NOT_FOUND` | Recurso ou rota inexistente |
  | 409 | `EMAIL_TAKEN`, `LAST_ADMIN`, `CONFLICT` | Conflito com o estado |
  | 413 | `PAYLOAD_TOO_LARGE` | Corpo acima de 100 kB |
  | 429 | `RATE_LIMITED` | Limite de taxa excedido |
  | 500 | `INTERNAL` | Falha inesperada (mensagem genérica) |
  | 503 | — | Dependência indisponível (só no `ready`, fora do envelope) |

- **Rastreio** ✅: toda resposta, inclusive as de erro e de health, traz `X-Request-Id` (UUID
  gerado pelo servidor). O valor enviado pelo cliente é ignorado. O mesmo id aparece no
  `requestId` do erro e no log da requisição.
- **Limite de taxa** ✅: o limite global é de 300 requisições a cada 15 min por IP, para todas as
  rotas exceto `/health/*` (inclui `/api/v1`, rotas inexistentes e preflight de CORS). Rotas de
  credencial terão um limite próprio de 20 a cada 15 min por IP. Cabeçalhos `RateLimit` e
  `RateLimit-Policy` (IETF draft-8). O contador fica em memória: vale para uma instância só.
- **Cabeçalhos de segurança** ✅: helmet com os padrões dele (CSP, `X-Content-Type-Options:
  nosniff`, HSTS etc.) e sem `X-Powered-By`.
- **CORS** ✅: só as origens de `CORS_ORIGINS`, e só fora de `/health/*` (os probes não são
  chamados por navegador). Outra origem não recebe `Access-Control-Allow-Origin`. Sem
  credenciais (cookies) no CORS.
- **Idempotência:** `logout` e `DELETE` são idempotentes por natureza. Não há `Idempotency-Key`.

## Autenticação

Fechado por padrão: toda rota em `/api/v1` exige `Authorization: Bearer <accessToken>`, exceto as
marcadas como públicas. Sem credencial válida, a resposta é **401**; sem permissão, **403** com
mensagem genérica. O papel e o estado do usuário são relidos do banco a cada requisição.

---

## Health

Rotas públicas, sem autenticação e sem prefixo de versão. Não expõem endereços, credenciais nem
detalhes internos.

| Método | Endpoint | Descrição | Auth / permissão | Épico/Spec |
|--------|----------|-----------|------------------|------------|
| GET | `/health/live` | Sem body → **200** `{ status: "ok" }`. Não consulta nenhuma dependência. Idempotência: natural (leitura). ✅ | pública | MVP · RF-28 |
| GET | `/health/ready` | Sem body → **200** `{ status: "ok", checks: { database: "ok" } }` quando o banco responde; **503** `{ status: "unavailable", checks: { database: "unavailable" } }` quando falha ou não responde em 2 s. O corpo nunca traz erro, host nem connection string. Idempotência: natural (leitura). ✅ | pública | MVP · RF-29, RF-30 |

---

## Auth

Prefixo `/api/v1/auth`. Rotas de credencial compartilham um limite próprio, de 20 requisições a
cada 15 min por IP, somado ao limite global.

| Método | Endpoint | Descrição | Auth / permissão | Épico/Spec |
|--------|----------|-----------|------------------|------------|
| POST | `/api/v1/auth/register` | `{ name, email, password }` (body estrito: qualquer outro campo, inclusive `role`, dá **400** `unrecognized_key`) → **201** `{ data: PublicUser }`. `email` é normalizado (trim + minúsculas); `name` com trim, de 2 a 100 caracteres; `password` de 15 a 128 caracteres (code points, após NFKC), sem composição, e recusada com `common_password` se estiver na lista de senhas comuns. Sempre cria `role: "USER"`. **409** `EMAIL_TAKEN` se o e-mail já existe, inclusive em conta excluída. **429** `RATE_LIMITED`. A resposta nunca traz senha nem hash. Idempotência: não idempotente; repetir dá 409. ✅ | pública | MVP · RF-01–RF-06 |

`PublicUser`: `{ id: uuid, name, email, role: "USER" | "ADMIN", createdAt, updatedAt }`, com
instantes em ISO 8601 UTC.

---

## Documentação

| Método | Endpoint | Descrição | Auth / permissão | Épico/Spec |
|--------|----------|-----------|------------------|------------|
| GET | `/openapi.json` | Documento OpenAPI 3.1 de todas as rotas. ✅ | pública | MVP · RF-31 |
| GET | `/docs` | Swagger UI: lista os endpoints e permite testá-los ("Try it out"). ✅ | pública | MVP · RF-32 |

---

## Deprecações

| Endpoint / campo | Depreciado em | Sunset | Substituto | Uso ainda medido? |
|---|---|---|---|---|
| `POST /user`, `GET /user` | 2026-10-28 | 2026-10-28 (removidos) | `/api/v1/auth/register`, `/api/v1/users` | Não. Nunca houve contrato publicado nem consumidor conhecido. |

## Compatibilidade — changelog de breaking changes

| Data | Endpoint | Mudança | Estratégia | Consumidores avisados |
|---|---|---|---|---|
| 2026-10-28 | `/user` | Removido junto com o exercício original | Remoção direta (sem consumidores) | Não se aplica |
