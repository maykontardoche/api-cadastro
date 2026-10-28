# API Cadastro

API REST de cadastro e gestão de usuários em Node.js e TypeScript, com PostgreSQL. É um projeto
de portfólio com quatro metas: ser segura por padrão, persistente, testada e reproduzível a
partir de um clone limpo. Os comandos e as respostas deste README foram executados a partir de
um clone limpo, e nenhum número de desempenho é citado sem medição.

## Sumário

- [O que a API faz](#o-que-a-api-faz)
- [Stack e arquitetura](#stack-e-arquitetura)
- [Instalação do zero](#instalação-do-zero)
- [Rodando tudo em containers](#rodando-tudo-em-containers)
- [Testando pelo navegador (Swagger)](#testando-pelo-navegador-swagger)
- [Exemplos com curl](#exemplos-com-curl)
- [Testes e qualidade](#testes-e-qualidade)
- [Segurança](#segurança)
- [Limitações conhecidas](#limitações-conhecidas)
- [Solução de problemas](#solução-de-problemas)
- [Estrutura e documentação](#estrutura-e-documentação)

## O que a API faz

Há três papéis de quem usa: o **USER** cuida da própria conta, o **ADMIN** gerencia todas as contas e o
**desenvolvedor ou avaliador** instala e consome a API.

| Área | Endpoints | Regras principais |
|---|---|---|
| Cadastro | `POST /api/v1/auth/register` | Sempre cria `USER`. Senha de 15 a 128 caracteres, sem regra de composição, recusada se estiver numa lista de senhas comuns. E-mail normalizado e único, inclusive entre contas excluídas. |
| Sessão | `POST /api/v1/auth/login`, `/refresh`, `/logout` | Access token JWT de 15 minutos e refresh token opaco de 30 dias, do qual só o hash é guardado. Cada renovação troca o refresh token; reapresentar um token já usado encerra toda a cadeia de sessões. Login inválido tem sempre a mesma resposta. |
| Senha | `POST /api/v1/auth/change-password` | Exige a senha atual e encerra todas as sessões de renovação. |
| Perfil | `GET` e `PATCH /api/v1/users/me` | Só nome e e-mail são editáveis; enviar `role` ou outro campo dá `400`. |
| Administração | `GET /api/v1/users`, `GET`/`PATCH`/`DELETE /api/v1/users/{id}`, `PATCH /api/v1/users/{id}/role` | Só ADMIN. Listagem paginada (20 por página, até 100), com busca e ordenação por allowlist. Exclusão lógica: o usuário some das listagens, não entra mais e perde as sessões. O último ADMIN ativo não pode ser rebaixado nem excluído, nem sob operações simultâneas. |
| Saúde | `GET /health/live`, `GET /health/ready` | `live` não depende do banco; `ready` responde `503` se o banco não responder em 2 s. |
| Documentação | `GET /docs`, `GET /openapi.json` | Swagger UI e OpenAPI 3.1 gerados das mesmas declarações que montam as rotas. |

O papel e o estado do usuário são relidos do banco a cada requisição, então um rebaixamento ou
uma exclusão valem na hora, sem esperar o token expirar. O contrato completo, com todos os
códigos de erro, está em [`docs/arquitetura/api-contract.md`](docs/arquitetura/api-contract.md).

## Stack e arquitetura

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 24 LTS (`>=24.11.0`) |
| Linguagem | TypeScript 6.0 (`strict`), ESM |
| HTTP | Express 5, helmet, CORS, express-rate-limit |
| Validação | Zod 4, que também gera o OpenAPI |
| Banco | PostgreSQL 17 com Prisma 7.10.1 (versão exata) |
| Autenticação | Argon2id para senhas, JWT HS256 (jose) para o access token |
| Logs | pino, em JSON e com redaction |
| Testes | Vitest 5, Supertest e fast-check |
| Entrega | Docker (imagem multi-stage) e GitHub Actions |

É um monólito modular: um único processo com os módulos `auth`, `users` e `health` e uma camada
HTTP compartilhada. A visão geral, o fluxo de uma requisição e as convenções estão em
[`docs/arquitetura/`](docs/arquitetura/README.md); as decisões e seus trade-offs, em
[`docs/adr/`](docs/adr/README.md).

## Instalação do zero

**Pré-requisitos:** Node.js 24 (`node -v` ≥ 24.11), Docker com o Compose (Docker Desktop no
Windows e no macOS) e Git. Os comandos abaixo funcionam no bash, no Git Bash e no PowerShell; quando
a sintaxe muda, a alternativa para PowerShell vem logo abaixo.

**1. Clone e instale as dependências.** O `npm ci` também gera o client do banco.

```bash
git clone https://github.com/maykontardoche/api-cadastro.git
cd api-cadastro
npm ci
```

**2. Crie o `.env`** a partir do exemplo. Ele fica fora do Git (`.gitignore`); só o
`.env.example`, sem segredos, é versionado.

```bash
cp .env.example .env
```

```powershell
Copy-Item .env.example .env
```

**3. Gere o segredo do JWT** e cole o valor em `JWT_ACCESS_SECRET=` no `.env`. Ele precisa ter
pelo menos 32 bytes; a API não sobe sem ele.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

**4. Suba o banco e aplique as migrations.** O `db:deploy` (`prisma migrate deploy`) só aplica as
migrations versionadas que faltam; ele nunca reseta o banco. Os dados ficam no volume `db-data`
do Compose e sobrevivem a reinícios da API e do container.

```bash
docker compose up -d --wait db
npm run db:deploy
```

**5. Crie o primeiro administrador.** Não existe senha padrão. Preencha `ADMIN_NAME`,
`ADMIN_EMAIL` e `ADMIN_PASSWORD` no `.env` (a senha segue a política do cadastro: de 15 a 128
caracteres) e rode:

```bash
npm run db:seed:admin
```

A saída esperada é `Admin account created.` Depois, **apague o `ADMIN_PASSWORD` do `.env`**.
Rodar o comando de novo não altera a senha de quem já existe. Se o e-mail já pertence a um USER, ele
só é promovido quando `ADMIN_PASSWORD` é a senha daquela conta. Como o cadastro é público,
alguém pode ter se cadastrado antes com esse e-mail; nesse caso o comando recusa e você deve usar
outro. O e-mail de uma conta excluída também é recusado, porque continua reservado.

**6. Inicie a API:**

```bash
npm run dev          # recarrega ao salvar
```

Para rodar a versão compilada, use `npm run build` e depois `npm start`.

Ela responde em `http://localhost:3000`. O log mostra `api listening` quando está pronta.

## Rodando tudo em containers

Com o `.env` preenchido (pelo menos o `JWT_ACCESS_SECRET`), API e banco sobem pelo Compose, e o
Node.js só é usado para gerar o segredo. Sem ele, qualquer gerador serve, por exemplo
`openssl rand -base64 48`.

```bash
docker compose up -d --wait db
docker compose run --rm migrate      # aplica as migrations pendentes
docker compose up -d --wait api      # builda a imagem na primeira vez
docker compose run --rm seed-admin   # primeiro administrador, com as ADMIN_* do .env
```

- As migrations nunca rodam sozinhas no `up`. O serviço `migrate` é um passo explícito e só
  aplica o que falta (`prisma migrate deploy`).
- O container da API recebe do `.env` só as variáveis que usa. As `ADMIN_*` vão apenas para o
  `seed-admin`. Sem `JWT_ACCESS_SECRET`, a API não sobe e o log diz qual variável falta.
- Dentro do Compose, o banco é o host `db`. O `DATABASE_URL` do `.env`, que aponta para
  `127.0.0.1`, vale só para rodar a API fora do container.
- A API fica em `127.0.0.1:3000` e roda com o usuário `node`, sem root, com o sistema de arquivos
  só de leitura e sem capabilities do Linux. O healthcheck do container usa o `/health/ready`.
- `DB_PASSWORD` troca a senha do banco local, mas só vale para um volume novo, porque o
  PostgreSQL guarda a senha na primeira inicialização. Use só letras, números, `-` e `_`, porque
  ela entra na URL de conexão sem escape. Para rodar a API fora do container, troque a senha
  também no `DATABASE_URL` do `.env`.

Para parar: `docker compose stop`. Para apagar o banco local e começar de novo, veja o runbook
[`docs/runbooks/reset-banco-local.md`](docs/runbooks/reset-banco-local.md).

## Testando pelo navegador (Swagger)

Abra **http://localhost:3000/docs**, escolha um endpoint, clique em **Try it out** e depois em
**Execute**. O corpo de exemplo já vem preenchido.

Para as rotas com cadeado:

1. Cadastre-se em `POST /api/v1/auth/register` e entre em `POST /api/v1/auth/login`.
2. Copie o `accessToken` da resposta.
3. Clique em **Authorize**, no topo da página, cole o token e confirme.
4. Execute a rota. O token vale por 15 minutos.

As rotas de **Users (admin)** exigem o login de um ADMIN; com um USER, a resposta é `403`.

## Exemplos com curl

Os exemplos usam a API em `http://localhost:3000` e as respostas foram encurtadas com `…`. Os
tokens aparecem como `<accessToken>` e `<refreshToken>`: copie o valor da resposta do login. Os
comandos estão em sintaxe bash (Linux, macOS ou Git Bash no Windows). No PowerShell, a quebra de
linha com `\` e as aspas do JSON não funcionam do mesmo jeito: use os exemplos de
[PowerShell](#no-powershell) abaixo.

**Cadastro**

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ana Souza","email":"ana@example.com","password":"uma frase longa que so eu sei"}'
```

```text
HTTP/1.1 201 Created
X-Request-Id: 9b2f…
{"data":{"id":"01a1…","name":"Ana Souza","email":"ana@example.com","role":"USER","createdAt":"…","updatedAt":"…"}}
```

Repetir o mesmo e-mail dá `409` com `"code":"EMAIL_TAKEN"`. Uma senha curta ou comum dá `400`
com `"code":"VALIDATION_ERROR"` e o campo em `details`.

**Login**

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"uma frase longa que so eu sei"}'
```

```text
{"data":{"accessToken":"eyJ…","tokenType":"Bearer","expiresIn":900,"refreshToken":"…","user":{"id":"01a1…","name":"Ana Souza",…}}}
```

Senha errada, e-mail desconhecido e conta excluída recebem a mesma resposta: `401` com
`"code":"INVALID_CREDENTIALS"`.

**Perfil próprio**

```bash
curl http://localhost:3000/api/v1/users/me -H "Authorization: Bearer <accessToken>"
```

```text
{"data":{"id":"01a1…","name":"Ana Souza","email":"ana@example.com","role":"USER",…}}
```

**Renovação da sessão**

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}'
```

A resposta tem o mesmo formato do login, com um par novo. O refresh token enviado deixa de valer:
enviá-lo de novo dá `401` e encerra todas as sessões daquela cadeia, inclusive a que acabou de ser
criada.

**Logout**

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}'
```

```text
HTTP/1.1 204 No Content
```

O logout responde `204` também para um token já encerrado ou desconhecido, sem revelar o estado.

**Rota de administração** (com o `accessToken` de um ADMIN)

```bash
curl "http://localhost:3000/api/v1/users?search=ana&limit=5&sortBy=name&order=asc" \
  -H "Authorization: Bearer <accessToken>"
```

```text
{"data":[{"id":"01a1…","name":"Ana Souza","email":"ana@example.com","role":"USER",…}],"meta":{"page":1,"limit":5,"total":1,"totalPages":1}}
```

Com o token de um USER, a resposta é `403` com `"code":"FORBIDDEN"`.

### No PowerShell

O `Invoke-RestMethod` monta o JSON e lê a resposta sem problemas de aspas:

```powershell
$api = "http://localhost:3000/api/v1"
$body = @{ email = "ana@example.com"; password = "uma frase longa que so eu sei" } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType "application/json" -Body $body
$headers = @{ Authorization = "Bearer $($login.data.accessToken)" }
(Invoke-RestMethod -Uri "$api/users/me" -Headers $headers).data
```

## Testes e qualidade

Os testes de integração rodam contra um PostgreSQL real, no serviço `db-test` do Compose. Esse
banco guarda os dados em memória e é limpo entre os testes.

```bash
docker compose up -d --wait db-test
npm test                     # unitários + integração
npm run test:unit
npm run test:integration
```

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm audit --audit-level=high
```

Os testes cobrem os invariantes de segurança e concorrência que não podem quebrar:
- um USER nunca acessa dados de outro usuário nem se promove a ADMIN;
- um refresh token só é aceito uma vez, inclusive com duas renovações simultâneas;
- nunca fica zero ADMIN ativo, inclusive com dois admins rebaixando um ao outro ao mesmo tempo;
- um usuário excluído não autentica;
- nenhuma resposta e nenhum log contêm senha, hash ou token;
- o documento OpenAPI e as rotas registradas são o mesmo conjunto.

**Mudando o schema do banco:** edite `prisma/schema.prisma` e gere uma migration nova com
`npm run db:migrate -- --name <nome>`. Esse comando usa o `prisma migrate dev` e é só para o
banco local. O client é regenerado junto; para regenerá-lo sozinho, use `npm run db:generate`.
Migration já aplicada não se edita: a correção vem numa migration nova.

**Integração contínua:** o GitHub Actions roda a cada push e pull request. Um job executa a
instalação, as migrations, o typecheck, o lint, a formatação, o build, os testes contra
PostgreSQL 17 e o `npm audit`. Um segundo job builda a imagem, confere que ela não roda como
root, sobe o Compose num banco vazio, chama os health checks, faz cadastro e login e confere o
encerramento gracioso. O Dependabot acompanha npm, GitHub Actions e a imagem base.

## Segurança

- **Senhas:** Argon2id (m = 19 MiB, t = 2, p = 1), de 15 a 128 caracteres e sem regra de
  composição, com uma lista local de senhas comuns, como recomenda a NIST SP 800-63B-4 para senha
  como fator único.
- **Sessão:**
  - o access token é um JWT HS256 de 15 minutos, que carrega só o id do usuário;
  - o refresh token é opaco, guardado só como SHA-256 e trocado a cada uso;
  - um token reutilizado encerra toda a cadeia de sessões ([ADR-0003](docs/adr/0003-modelo-de-sessao.md)).
- **Autorização:**
  - é sempre decidida no servidor, com o papel relido do banco a cada requisição;
  - o cadastro e a edição de perfil recusam qualquer campo fora da allowlist;
  - toda rota declara se é pública, e o teste de contrato trava essa lista.
- **Entrada e transporte:**
  - limite de taxa por IP: 300 requisições a cada 15 min no geral e 20 nas rotas de credencial;
  - corpo JSON de até 100 KiB e cabeçalhos de segurança (helmet);
  - CORS restrito a `CORS_ORIGINS`.
- **Privacidade:**
  - os logs são JSON com allowlist de campos e redaction;
  - senha, hash, token, `Authorization` e cookie não aparecem em log nem em resposta;
  - erros inesperados viram uma mensagem genérica com `requestId`, sem stack nem SQL.

Para reportar uma vulnerabilidade, veja o [`SECURITY.md`](SECURITY.md). Não há alegação de
conformidade formal (LGPD, ISO ou outra).

## Limitações conhecidas

- **Renovação estrita:** um refresh token vale uma única vez, sem janela de tolerância. Algumas
  situações legítimas são tratadas como reutilização: um cliente que repete a renovação depois de
  perder a resposta, ou duas abas que renovam ao mesmo tempo. Nesses casos a cadeia é encerrada e
  é preciso entrar de novo.
- **Access token até expirar:** logout e troca de senha encerram as sessões de renovação, mas um
  access token já emitido continua válido até expirar, por no máximo 15 minutos. A exclusão e o
  rebaixamento valem na hora, porque o usuário é relido a cada requisição: o token de uma conta
  excluída passa a receber `401`, e o de um admin rebaixado, `403` nas rotas de admin.
- **Rate limit em memória:** o contador vale para uma instância só. Mais de uma instância exige
  um store compartilhado.
- **Lista local de senhas comuns:** tem 5.328 senhas de 15 a 128 caracteres, tiradas do SecLists.
  É menor que uma base de senhas vazadas, e não há consulta a serviço externo.
- **Troca de e-mail sem confirmação:** o e-mail muda só com o access token, sem pedir a senha nem
  confirmar o endereço novo, porque não há envio de e-mail no MVP.
- **Sem `Cache-Control: no-store`:** as respostas de token (login e refresh) e as leituras
  autenticadas não mandam `no-store`. Nas leituras, caches compartilhados já não guardam
  respostas a requisições com `Authorization`. Nas respostas de token, que são `POST`, o risco é
  baixo, mas a RFC 6749 pede o `no-store`, e essa é a primeira correção prevista.
- **Fora do MVP:**
  - recuperação de senha e verificação de e-mail;
  - reativação de conta excluída;
  - métricas e tracing (os sinais saem dos logs);
  - deploy em produção.

## Solução de problemas

| Sintoma | Causa provável e solução |
|---|---|
| `Invalid environment variables: JWT_ACCESS_SECRET` | O `.env` não tem o segredo ou ele tem menos de 32 bytes. Gere um no passo 3. O erro lista só os nomes, nunca os valores. |
| `npm run db:deploy` falha com `P1001` (não alcança o banco) | O banco não está no ar. Rode `docker compose up -d --wait db` e confira com `docker compose ps`. |
| `docker compose` falha com erro de conexão ao Docker | O Docker Desktop não está aberto ou o motor não iniciou. Abra o Docker Desktop e espere "Engine running". |
| Porta `5432`, `5433` ou `3000` em uso | Outro PostgreSQL ou outra API está usando a porta. Pare o outro serviço ou mude a porta publicada no `compose.yaml` (e o `DATABASE_URL` junto). |
| Testes de integração falham ao conectar | O `db-test` não está no ar: `docker compose up -d --wait db-test`. |
| `429` com `"code":"RATE_LIMITED"` | O limite das rotas de credencial é de 20 requisições a cada 15 min por IP. Espere a janela ou reinicie a API, porque o contador fica em memória. |
| `401` em todas as rotas com cadeado | O access token expirou (15 min) ou foi copiado incompleto. Faça login de novo ou use o `/refresh`. |
| `curl` no PowerShell pede parâmetros | No Windows PowerShell 5.1, `curl` é um apelido de `Invoke-WebRequest`. Use os exemplos com `Invoke-RestMethod` ou rode os exemplos `curl` no Git Bash. |
| `npm ci` reclama da versão do Node | O projeto exige Node 24.11 ou mais novo (`engines` no `package.json`). |

## Estrutura e documentação

```text
src/
  app.ts            monta o Express sem abrir porta (usado pelos testes)
  server.ts         bootstrap, conexão com o banco e encerramento gracioso
  api-routes.ts     liga os serviços às rotas de /api/v1
  admin-seed.ts     criação do primeiro administrador
  scripts/          comandos executáveis, como o seed do admin
  config/           validação do ambiente
  db/               client do banco e transações
  http/             erros, logs, validação, rate limit, OpenAPI e declaração de rotas
  modules/          auth, users e health
prisma/             schema e migrations
scripts/            (na raiz) geração da lista de senhas comuns
tests/              unit/, integration/ e helpers/
docs/               arquitetura, contrato da API, ADRs, runbooks e status
```

| Documento | Conteúdo |
|---|---|
| [`docs/arquitetura/README.md`](docs/arquitetura/README.md) | Componentes, fluxo de uma requisição e convenções |
| [`docs/arquitetura/api-contract.md`](docs/arquitetura/api-contract.md) | Todos os endpoints, erros e regras do contrato |
| [`docs/adr/`](docs/adr/README.md) | Decisões de arquitetura e seus trade-offs |
| [`docs/runbooks/`](docs/runbooks/README.md) | Procedimentos operacionais, como o reset do banco local |
| [`docs/status.md`](docs/status.md) | O que está pronto e o que vem depois |
| [`SECURITY.md`](SECURITY.md) | Como reportar uma vulnerabilidade |

## Licença

[MIT](LICENSE) © 2026 Maykon Tardoche
