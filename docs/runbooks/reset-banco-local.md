# Runbook: reset do banco local

> **Destrutivo.** Este procedimento **apaga todos os dados** do banco local de desenvolvimento
> (`api_cadastro`, volume `db-data` do Compose): usuários, sessões e o administrador. Não há
> como desfazer. Nunca use contra um banco compartilhado ou de produção. Este projeto não tem
> nenhum dos dois.

## Quando usar

- O banco local ficou num estado que você quer descartar (dados de teste, migrations
  experimentais).
- Você trocou o `DB_PASSWORD`: o PostgreSQL só aplica a senha nova num volume novo.
- Uma migration local falhou no meio e você prefere recomeçar do zero.

O banco de testes (`db-test`) não precisa deste runbook: ele guarda os dados em memória (tmpfs),
e os testes limpam as tabelas entre si. Para zerá-lo, basta `docker compose restart db-test`.

## Antes de começar

1. Confirme que está na pasta do projeto: `docker compose config --services` lista `db`,
   `db-test` e `api`.
2. Confira qual volume será apagado: `docker volume ls --filter name=api-cadastro_db-data`.
3. Pare a API, se estiver rodando fora do container (`npm run dev`): o `down` do passo 1 só para
   os containers.
4. Se precisar de algum dado, exporte antes. O backup tem nomes, e-mails e hashes de senha e de
   token: **grave fora da pasta do projeto**, para ele nunca entrar num commit (o `.gitignore`
   também ignora `*.sql` fora de `prisma/migrations/`). O dump é feito dentro do container e
   copiado com `docker compose cp`, o que funciona igual no bash e no PowerShell:

   ```bash
   docker compose up -d --wait db
   docker compose exec -T db pg_dump -U app -d api_cadastro -f /tmp/backup.sql
   docker compose cp db:/tmp/backup.sql ../api-cadastro-backup.sql
   ```

   Apague o arquivo quando não precisar mais dele.

## Passos

1. Pare a API e o banco e apague o volume do banco local:

   ```bash
   docker compose down --volumes
   ```

   O `--volumes` apaga o `db-data`, o volume declarado no `compose.yaml`. O banco de testes não
   tem volume.

2. Suba o banco vazio:

   ```bash
   docker compose up -d --wait db
   ```

3. Recrie o schema com as migrations versionadas:

   ```bash
   npm run db:deploy                  # ou: docker compose run --rm migrate
   ```

4. Recrie o primeiro administrador. Preencha as `ADMIN_*` no `.env` e rode:

   ```bash
   npm run db:seed:admin              # ou: docker compose run --rm seed-admin
   ```

   Depois, apague o `ADMIN_PASSWORD` do `.env`.

## Verificação

```bash
npx prisma migrate status            # "Database schema is up to date!"
curl http://localhost:3000/health/ready
```

O `ready` só responde com a API no ar (`npm run dev` ou `docker compose up -d --wait api`). Ele
deve trazer `{"status":"ok","checks":{"database":"ok"}}`.

## Restaurar um backup

O `pg_dump` padrão já traz o schema e o histórico de migrations (`_prisma_migrations`). Por
isso, restaure num banco **vazio**, logo depois do passo 2, e pule os passos 3 e 4. O
`ON_ERROR_STOP` faz o restore parar no primeiro erro, em vez de terminar pela metade como se
tivesse dado certo:

```bash
docker compose cp ../api-cadastro-backup.sql db:/tmp/backup.sql
docker compose exec -T db psql -U app -d api_cadastro -v ON_ERROR_STOP=1 -q -f /tmp/backup.sql
npm run db:deploy                    # aplica só migrations mais novas que o backup, se houver
```
