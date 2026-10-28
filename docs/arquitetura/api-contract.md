# API Contract — API Cadastro

> Registro de endpoints da **API Cadastro** (diretório `.`).
>
> **Consulte antes de criar endpoint novo**, para não duplicar.
> **Atualize ao criar ou alterar endpoint, na mesma mudança que o código.**
>
> Fonte gerada: `/openapi.json`, gerado dos schemas Zod (planejado). Até lá, este registro é a
> única fonte.

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
- **Erro:** envelope próprio
  `{ "error": { "code", "message", "requestId", "details?": [{ "field", "code" }] } }`. A
  mensagem vem em pt-BR e o `code` é estável, em inglês. Um erro inesperado nunca expõe stack,
  SQL ou detalhe interno.
- **Status de recusa:**

  | Status | Quando |
  |---|---|
  | 400 | Entrada malformada ou inválida |
  | 401 | Sem sessão ou credencial inválida |
  | 403 | Sem permissão |
  | 404 | Recurso não encontrado |
  | 409 | Conflito com o estado (`EMAIL_TAKEN`, `LAST_ADMIN`) |
  | 413 | Payload acima de 100 kB |
  | 429 | Limite de taxa |
  | 503 | Dependência indisponível (só no `ready`) |

- **Rastreio** 🚧: toda resposta traz `X-Request-Id`, gerado pelo servidor; o valor enviado pelo
  cliente é ignorado. Ainda não implementado: hoje o `/health/live` responde sem esse header.
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

## Deprecações

| Endpoint / campo | Depreciado em | Sunset | Substituto | Uso ainda medido? |
|---|---|---|---|---|
| `POST /user`, `GET /user` | 2026-10-28 | 2026-10-28 (removidos) | `/api/v1/auth/register`, `/api/v1/users` | Não. Nunca houve contrato publicado nem consumidor conhecido. |

## Compatibilidade — changelog de breaking changes

| Data | Endpoint | Mudança | Estratégia | Consumidores avisados |
|---|---|---|---|---|
| 2026-10-28 | `/user` | Removido junto com o exercício original | Remoção direta (sem consumidores) | Não se aplica |
