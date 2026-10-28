# API Cadastro

API REST de cadastro e gestão de usuários em Node.js e TypeScript, com PostgreSQL. O objetivo é
ser uma API segura por padrão, persistente, testada e reproduzível a partir de um clone limpo.

> **Status: em desenvolvimento.** Cadastro, login, renovação de sessão, logout, perfil próprio e
> a documentação interativa estão prontos. A edição de perfil, a troca de senha e a administração
> de usuários ainda estão sendo construídas. Este README descreve só o que já existe e funciona
> hoje.

## O que já funciona

- **Cadastro de usuários** (`POST /api/v1/auth/register`): sempre cria o papel `USER`, guarda
  a senha com Argon2id e recusa e-mail repetido com `409`. A senha tem de 15 a 128
  caracteres, sem regra de composição, e é recusada se estiver numa lista de senhas comuns.
- **Login** (`POST /api/v1/auth/login`): devolve um access token JWT de 15 minutos e um refresh
  token opaco, do qual só o hash é guardado. E-mail desconhecido, conta excluída e senha errada
  recebem a mesma resposta `401`.
- **Renovação de sessão** (`POST /api/v1/auth/refresh`): troca o refresh token por um par novo, e
  o antigo deixa de valer. Reapresentar um token já usado, sinal de roubo, encerra todas as
  sessões daquela cadeia, inclusive uma que esteja sendo criada naquele instante. Decisão em
  [ADR-0003](docs/adr/0003-modelo-de-sessao.md).
- **Logout** (`POST /api/v1/auth/logout`): encerra a sessão do refresh token enviado.
- **Perfil próprio** (`GET /api/v1/users/me`): exige o access token e relê o usuário no banco a
  cada requisição, então uma conta excluída perde o acesso na hora.
- **Swagger UI em `/docs`**: lista os endpoints e permite testá-los no navegador. O documento
  OpenAPI 3.1 fica em `/openapi.json` e é gerado do próprio código, então não diverge do
  comportamento.
- Validação do ambiente na inicialização: a API não sobe com configuração inválida e o erro
  mostra só o nome da variável, nunca o valor.
- Persistência em PostgreSQL 17 com schema versionado por migrations (Prisma).
- `GET /health/live`: indica se o processo está no ar, sem depender do banco.
- `GET /health/ready`: indica se o banco responde. Retorna `503` quando ele não responde em 2 s,
  sem expor detalhes internos.
- Erros num formato único (`{ "error": { "code", "message", "requestId", "details" } }`), sem
  expor stack, SQL ou detalhes internos.
- `X-Request-Id` em toda resposta, igual ao `requestId` do erro e do log.
- Logs estruturados em JSON, sem headers, corpo, query string, senhas nem tokens.
- Rate limit por IP, cabeçalhos de segurança (helmet), CORS restrito às origens configuradas e
  corpo JSON limitado a 100 kB.
- Testes unitários e de integração contra um PostgreSQL real.

## Planejado para o MVP

- Edição do perfil próprio e troca de senha.
- Perfis `USER` e `ADMIN`, com autorização sempre no servidor.
- Administração de usuários com paginação, busca e exclusão lógica.
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

### Testando pelo navegador

Abra **http://localhost:3000/docs**, escolha um endpoint, clique em **Try it out** e depois em
**Execute**. O corpo de exemplo já vem preenchido.

Para as rotas com cadeado (como `GET /api/v1/users/me`):

1. Cadastre-se em `POST /api/v1/auth/register` e entre em `POST /api/v1/auth/login`.
2. Copie o `accessToken` da resposta do login.
3. Clique em **Authorize** no topo da página, cole o token e confirme.
4. Execute a rota com cadeado. O token vale por 15 minutos.

### Testando pelo terminal

No PowerShell, use `curl.exe`, porque `curl` sozinho é outro comando:

```bash
curl http://localhost:3000/health/live    # {"status":"ok"}
curl http://localhost:3000/health/ready   # {"status":"ok","checks":{"database":"ok"}}

curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ana Souza","email":"ana@example.com","password":"uma frase longa que so eu sei"}'
# 201 {"data":{"id":"…","name":"Ana Souza","email":"ana@example.com","role":"USER",…}}

curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"uma frase longa que so eu sei"}'
# 200 {"data":{"accessToken":"…","tokenType":"Bearer","expiresIn":900,"refreshToken":"…","user":{…}}}

curl http://localhost:3000/api/v1/users/me -H "Authorization: Bearer <accessToken>"
# 200 {"data":{"id":"…","name":"Ana Souza","email":"ana@example.com","role":"USER",…}}
```

As credenciais do `compose.yaml` servem só para os bancos locais descartáveis.

## Limitações conhecidas

- **Renovação estrita.** Um token de renovação vale uma única vez. Um cliente que repete a
  renovação depois de perder a resposta, ou duas abas que renovam ao mesmo tempo, são tratados
  como reutilização: a sessão daquela cadeia é encerrada e é preciso entrar de novo.
- **Access token até expirar.** Logout e encerramento de sessões não invalidam um access token
  já emitido; ele vale até expirar, no máximo 15 minutos.
- **Rate limit em memória.** O contador vale para uma instância só. Mais de uma instância exige um
  store compartilhado.

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
  api-routes.ts     liga os serviços às rotas de /api/v1
  config/           validação do ambiente
  db/               client do banco
  http/             erros, logs, validação, rate limit, OpenAPI e declaração de rotas
  modules/          auth, users e health
prisma/             schema e migrations
scripts/            geração da lista de senhas comuns
tests/              unit/, integration/ e helpers/
docs/               ADRs, contrato da API e status
```

## Licença

[MIT](LICENSE) © 2026 Maykon Tardoche
