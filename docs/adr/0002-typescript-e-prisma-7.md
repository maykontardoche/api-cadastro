---
status: Aceito
date: 2026-10-28
decision-makers: Maykon Tardoche
---

# ADR-0002: Usar TypeScript com Prisma 7 (versão exata 7.10.1)

## Contexto e problema

O plano original previa JavaScript ESM com Prisma como ORM. Ao verificar as versões estáveis em
2026-10-28, apareceram três fatos que mudam essa escolha:

- O gerador padrão do Prisma 7, `prisma-client`, emite o client em arquivos `.ts`. O gerador
  `prisma-client-js`, que funcionava com JavaScript puro, é tratado como legado na v7 (documentação
  oficial: `https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators`).
- No registry do npm, a dist-tag `latest` do CLI `prisma` aponta para `8.0.0-rc.28`, uma release
  candidate, enquanto `@prisma/client@latest` é `7.10.1`. Um `npm i prisma` sem versão instalaria
  uma RC (verificado com `npm view prisma dist-tags`).
- O `typescript-eslint@8.72.1` exige `typescript >=4.8.4 <6.1.0`, e o `latest` do TypeScript é
  a 7.0.2 (verificado com `npm view typescript-eslint peerDependencies`).

## Drivers da decisão

1. Usar o caminho suportado do ORM, sem depender de um gerador legado.
2. Ter verificação de tipos real no pipeline (typecheck no CI).
3. Nunca instalar prerelease sem querer.

## Alternativas consideradas

1. **TypeScript + Prisma 7.10.1**, com o gerador `prisma-client`.
2. **JavaScript ESM + Prisma 7** com o gerador legado `prisma-client-js`.
3. **JavaScript ESM com outro acesso a dados** (Drizzle ou Kysely).

## Decisão

Escolhida: **TypeScript 6.0.x com Prisma 7.10.1**, porque é o caminho padrão do ORM e transforma
o typecheck num gate real.

Passa a valer:

- TypeScript `~6.0.3` em modo `strict`, ESM e `module: nodenext`;
- `prisma`, `@prisma/client` e `@prisma/adapter-pg` fixados em `7.10.1`, a versão exata;
- Node.js `>=24.11.0`, o mínimo da linha 24 exigido pelo Prisma 7;
- `tsx` no desenvolvimento e `tsc` no build para `dist/`.

## Consequências

- **Positivas:** os tipos gerados pelo Prisma alcançam serviços e handlers; erros de contrato
  interno aparecem no `npm run typecheck`, antes dos testes.
- **Negativas:** há uma etapa de build e mais configuração (`tsconfig.json`,
  `tsconfig.build.json`); o TypeScript fica uma major atrás do `latest` até o `typescript-eslint`
  suportar a 7.
- **Riscos e mitigação:** um `npm install prisma` sem versão traria a RC. Mitigação: a versão
  exata fica no `package.json` e a revisão recusa ranges no Prisma.
- **Passa a ser obrigatório:** atualizar o Prisma só para uma versão estável, numa mudança
  própria, conferindo a documentação daquela versão.

## Confirmação

- O `package.json` declara `prisma`, `@prisma/client` e `@prisma/adapter-pg` sem `^` nem `~`.
- O CI roda `npm run typecheck`.
- `npm ls typescript` mostra 6.0.x.

## Prós e contras das alternativas

### JavaScript ESM + `prisma-client-js`

- Prós: mantém o JavaScript do plano original, sem build.
- Contras: depende de um gerador legado, com risco de remoção numa próxima major; sem typecheck.
- Drivers: perde em 1 e 2.

### JavaScript ESM com Drizzle ou Kysely

- Prós: funciona bem com JavaScript.
- Contras: foge da referência de ORM do projeto e muda a forma de escrever as migrations.
- Drivers: neutro em 1; perde em 2.

## Links

- ADRs relacionados: ADR-0001 (monólito modular).
- Doc oficial consultada: Prisma ORM v7, `https://www.prisma.io/docs/v7/prisma-orm/add-to-existing-project/postgresql`.
