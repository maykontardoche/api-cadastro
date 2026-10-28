---
status: Aceito
date: 2026-10-28
decision-makers: Maykon Tardoche
---

# ADR-0003: Sessão com access JWT curto e refresh token opaco rotativo, com detecção estrita de reutilização

## Contexto e problema

A API precisa manter o usuário autenticado sem pedir a senha a cada requisição, e limitar o
estrago de uma credencial vazada. O PRD exige três coisas:

- a renovação troca a credencial e invalida a anterior (RF-09);
- reapresentar uma credencial já usada encerra todas as sessões da mesma cadeia (RF-10);
- nada que permita recuperar a credencial é guardado (RF-15).

Também exige que rebaixar ou excluir um usuário tenha efeito imediato.

Para clientes públicos, a RFC 9700 (OAuth 2.0 Security BCP) pede refresh tokens presos ao
remetente ou rotacionados a cada uso, com detecção de reutilização. Este MVP não tem infraestrutura
para prender o token ao remetente (DPoP, mTLS).

## Drivers da decisão

1. Uma credencial vazada deve ter vida curta, e o roubo de um refresh token deve ser detectável.
2. Rebaixamento e exclusão valem na hora.
3. Nenhuma infraestrutura além do PostgreSQL.
4. Correto sob requisições concorrentes.

## Alternativas consideradas

1. **Access JWT curto + refresh opaco rotativo, com detecção estrita de reutilização, e usuário
   relido a cada requisição.**
2. **Access JWT longo, sem refresh.**
3. **Sessão opaca no servidor, sem JWT** (cookie ou token de sessão consultado a cada
   requisição).
4. **Rotação com janela de tolerância:** o token antigo continua aceito por alguns segundos depois
   de usado.

## Decisão

Escolhida: **a alternativa 1**, porque atende aos quatro drivers só com o PostgreSQL.

### Access token

- JWT HS256 de 15 minutos, com header `typ: at+jwt` (RFC 9068).
- Carrega só o id do usuário (`sub`), sem papel nem e-mail.
- A cada requisição autenticada, o usuário é relido no banco, então papel e exclusão valem na hora.

### Refresh token

- Valor aleatório de 256 bits; o banco guarda só o SHA-256 dele.
- Válido por `REFRESH_TOKEN_TTL_DAYS`. Cada login inicia uma família (`familyId`).
- A renovação acontece numa transação. Primeiro ela toma um advisory lock de transação por
  usuário (`pg_advisory_xact_lock`) e relê a sessão. Em seguida, revoga a sessão por
  compare-and-set (`UPDATE … WHERE id = ? AND revoked_at IS NULL`) e só então cria a sessão nova
  na mesma família.
- O lock é necessário porque, em Read Committed, cada comando só enxerga linhas commitadas antes
  de começar. Sem ele, um `UPDATE` em massa (revogar a família ou todas as sessões do usuário) que
  espera o lock da linha de uma rotação em curso não enxerga a sessão nova que essa rotação está
  inserindo. Essa sessão sobreviveria à detecção de roubo. Revogar todas as sessões do usuário toma
  o mesmo lock e pode participar de uma transação externa, como troca de senha ou exclusão de
  conta.
- Se o compare-and-set afeta 0 linhas, ou se o token apresentado já estava revogado, é
  reutilização. Todas as sessões ativas da família são revogadas, e a resposta é o mesmo 401 de
  qualquer outra falha. O evento `refresh_reuse_detected` é logado sem o token, com
  `afterRotation`, que separa o replay de um token já trocado (sinal forte de roubo) de um token
  encerrado por logout (em geral, um cliente desatualizado).
- Sessões revogadas não são apagadas antes do próprio `expiresAt`, porque a detecção depende
  delas.
- O logout revoga a sessão do token enviado e responde 204 em qualquer caso, sem revelar o
  estado.

## Consequências

- **Positivas:**
  - Um access token vazado dura no máximo 15 minutos.
  - Um refresh token roubado e usado pelo ladrão derruba a cadeia quando o dono legítimo tentar
    renovar, e vice-versa.
  - Sob renovações simultâneas, nunca sobram duas sessões válidas. Isso vale para o mesmo token e
    para o replay de um token antigo enquanto o mais novo é renovado; nos dois casos, a família
    termina sem sessão ativa.
- **Negativas:**
  - Uma consulta ao banco por requisição autenticada.
  - As renovações do mesmo usuário são serializadas pelo lock. O custo é pequeno: a transação é
    curta e não inclui Argon2id nem a assinatura do JWT.
  - Um cliente que repete a renovação depois de perder a resposta, ou que renova em duas abas ao
    mesmo tempo, perde a sessão e precisa entrar de novo. O trade-off foi aceito: sem janela de
    tolerância, a detecção não tem brecha.
  - Logout e troca de senha não invalidam o access token já emitido; ele vale até expirar.
- **Riscos e mitigação:**
  - Uma limpeza de sessões antes do `expiresAt` apagaria a evidência de reutilização. Por isso,
    a limpeza, quando existir, só remove registros já expirados.
  - Um segredo JWT fraco: ele é validado na inicialização, com no mínimo 32 bytes.
- **Passa a ser obrigatório:**
  - Nenhum dado do usuário no JWT além do `sub`.
  - Toda rota protegida usa o middleware que relê o usuário.
  - A renovação continua num único caminho transacional (`SessionService.rotate`).
  - Toda revogação em massa de sessões de um usuário passa por `SessionService.revokeAllForUser`,
    que toma o lock.
  - Numa transação que também altera o usuário, `revokeAllForUser(userId, tx)` vem **antes** do
    `UPDATE` em `users`. A rotação segura o lock do usuário e insere uma sessão, o que toma
    `FOR KEY SHARE` na linha do usuário por causa da FK. Uma transação que já tem `FOR UPDATE`
    nessa linha (por exemplo, mudando o `email`, que é único) e depois espera o lock entra em
    deadlock com ela.

## Confirmação

- **Interleavings forçados.** `tests/integration/auth/session-race.test.ts` força as
  intercalações: pausa a primeira rotação depois do compare-and-set e só a libera quando o
  `pg_stat_activity` mostra a operação concorrente esperando um lock. Cobre:
  - o replay de um token antigo durante a rotação do mais novo;
  - `revokeAllForUser` durante uma rotação;
  - o mesmo token duas vezes;
  - `revokeAllForUser` dentro de uma transação externa.

  Os dois primeiros casos falhavam (1 sessão ativa restante) antes do lock por usuário.
- **Integração.** `tests/integration/auth/refresh.test.ts` e `logout.test.ts` cobrem:
  - uso único;
  - reutilização revogando a família;
  - rodadas de renovações concorrentes;
  - famílias independentes;
  - token expirado sem tratamento de reutilização;
  - log sem o token.
- **Unidade.** `tests/unit/auth/token.service.test.ts` cobre a validação do JWT.

## Prós e contras das alternativas

### Access JWT longo, sem refresh

- Prós: o mais simples.
- Contras: um token vazado vale por horas ou dias; não há como detectar roubo.
- Drivers: perde em 1.

### Sessão opaca no servidor

- Prós: revogação imediata de tudo.
- Contras: o mesmo custo de consulta por requisição, sem o ganho de um access token
  autocontido para clientes. Se for por cookie, exige proteção contra CSRF; o MVP não tem frontend.
- Drivers: empata em 1 a 3; adiciona superfície de CSRF.

### Rotação com janela de tolerância

- Prós: perdoa a repetição legítima logo depois de uma resposta perdida.
- Contras: durante a janela, um token roubado é aceito sem disparar a detecção.
- Drivers: perde em 1.

## Links

- ADRs relacionados: ADR-0001 (monólito modular, uma única transação local), ADR-0004 (as rotas
  de sessão são declaradas e documentadas como as demais).
- Referências: RFC 9700 (OAuth 2.0 Security BCP), RFC 9068 (JWT para access tokens), OWASP
  Password Storage Cheat Sheet.
