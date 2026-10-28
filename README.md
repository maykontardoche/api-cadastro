# API Cadastro

API REST de cadastro e gestão de usuários em Node.js e TypeScript, com PostgreSQL. O objetivo é
ser uma API segura por padrão, persistente, testada e reproduzível a partir de um clone limpo.

> **Status: em desenvolvimento.** A fundação do projeto e a persistência estão prontas. Cadastro,
> login, sessões, administração de usuários e a documentação OpenAPI ainda estão sendo
> construídos. Este README descreve só o que já existe e funciona hoje.

## O que já funciona

- Validação do ambiente na inicialização: a API não sobe com configuração inválida e o erro
  mostra só o nome da variável, nunca o valor.
- Persistência em PostgreSQL 17 com schema versionado por migrations (Prisma).
- `GET /health/live`: indica se o processo está no ar, sem depender do banco.
- `GET /health/ready`: indica se o banco responde. Retorna `503` quando ele não responde em 2 s,
  sem expor detalhes internos.
- Testes unitários e de integração contra um PostgreSQL real.

## Planejado para o MVP

- Cadastro e login com senha protegida por Argon2id.
- Sessão com access token curto e refresh token rotativo, com detecção de reutilização.
- Perfis `USER` e `ADMIN`, com autorização sempre no servidor.
- Administração de usuários com paginação, busca e exclusão lógica.
- Erros padronizados, logs estruturados, rate limit e cabeçalhos de segurança.
- Documentação OpenAPI com Swagger UI.
- Containers da aplicação e integração contínua no GitHub Actions.

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 24 LTS (`>=24.11.0`) |
| Linguagem | TypeScript 6.0 (`strict`), ESM |
| HTTP | Express 5 |
| Validação | Zod 4 |
| Banco | PostgreSQL 17 |
| ORM | Prisma 7.10.1 (versão exata) |
| Testes | Vitest 5 e Supertest |
| Qualidade | ESLint (typescript-eslint) e Prettier |

As decisões de arquitetura estão registradas em [`docs/adr/`](docs/adr/README.md).

## Como rodar localmente

Pré-requisitos: Node.js 24 e Docker.

```bash
npm ci                       # instala as dependências e gera o client do banco
cp .env.example .env         # PowerShell: Copy-Item .env.example .env
```

Preencha o `JWT_ACCESS_SECRET` no `.env` com um valor aleatório de pelo menos 32 bytes:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Suba o banco, aplique as migrations e inicie a API:

```bash
docker compose up -d db
npm run db:deploy
npm run dev                  # http://localhost:3000
```

```bash
curl http://localhost:3000/health/live    # {"status":"ok"}
curl http://localhost:3000/health/ready   # {"status":"ok","checks":{"database":"ok"}}
```

As credenciais do `compose.yaml` servem só para os bancos locais descartáveis.

## Testes

Os testes de integração usam o banco `db-test` do Compose, que guarda os dados em memória e é
limpo entre os testes.

```bash
docker compose up -d db-test
npm test                     # unitários + integração
npm run test:unit
npm run test:integration
```

Verificações de qualidade:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Estrutura

```text
src/
  app.ts            monta o Express sem abrir porta (usado pelos testes)
  server.ts         bootstrap, conexão com o banco e encerramento
  config/           validação do ambiente
  db/               client do banco
  modules/          módulos de negócio (health por enquanto)
prisma/             schema e migrations
tests/              unit/, integration/ e helpers/
docs/               ADRs, contrato da API e status
```

## Licença

[MIT](LICENSE) © 2026 Maykon Tardoche
