---
status: Aceito
date: 2026-10-28
decision-makers: Maykon Tardoche
---

# ADR-0001: Construir a API como um monólito modular

## Contexto e problema

A API Cadastro cobre um domínio pequeno e coeso: cadastro, autenticação, sessões e
administração de usuários, todos sobre as mesmas duas tabelas (`User` e `RefreshSession`).
O ponto de partida era um único `server.js` com um array em memória. É um projeto de portfólio
mantido por uma pessoa, sem tráfego de produção, sem equipes independentes e sem requisito de
escalar partes do sistema de forma separada.

Ainda assim, o código precisa de fronteiras claras: autenticação, usuários e saúde do serviço
têm regras próprias, e uma regra de segurança (por exemplo, a guarda do último administrador)
não pode ficar espalhada.

## Drivers da decisão

1. Simplicidade para instalar, testar e explicar a partir de um clone limpo.
2. Consistência transacional entre usuário e sessões (revogar sessões ao trocar a senha ou
   excluir a conta).
3. Fronteiras de código legíveis, que permitam extrair um módulo no futuro se houver motivo.

## Alternativas consideradas

1. **Monólito modular**: um processo e um banco, com módulos `auth`, `users` e `health`.
2. **Microsserviços**: serviços de identidade e de usuários separados, comunicando por HTTP ou
   mensageria.
3. **Monólito sem módulos**: rotas e regras num único nível, como no `server.js` original.

## Decisão

Escolhida: **monólito modular**, porque atende aos três drivers sem o custo operacional de
serviços distribuídos.

Vale para todo o código em `src/`. Cada módulo de `src/modules/` tem rotas, handlers, serviço e
acesso a dados próprios. A infraestrutura compartilhada (HTTP, configuração, banco) fica em
`src/http`, `src/config` e `src/db`. O módulo `users` não importa `auth`, exceto os middlewares
de autenticação compartilhados.

## Consequências

- **Positivas:** um único `docker compose up` e um único pipeline de CI; transações locais no
  PostgreSQL resolvem a consistência entre usuário e sessão.
- **Negativas:** o deploy é único: uma falha no processo derruba todas as rotas, e não dá para
  escalar a autenticação separadamente.
- **Riscos e mitigação:** os módulos podem se acoplar com o tempo. Mitigação: a regra de
  importação acima é item de revisão em todo PR.
- **Passa a ser obrigatório:** código novo entra num módulo existente ou num módulo novo em
  `src/modules/`, nunca solto em `src/`.

## Confirmação

Na revisão de cada PR: nenhum import de `src/modules/auth` dentro de `src/modules/users`, exceto
os middlewares de autenticação, e nenhum arquivo de regra de negócio fora de `src/modules/`.

## Prós e contras das alternativas

### Microsserviços

- Prós: deploy e escala independentes; isolamento de falhas.
- Contras: rede, contratos entre serviços, consistência eventual entre usuário e sessão, mais
  infraestrutura para instalar e explicar.
- Drivers: perde nos três para um domínio deste tamanho.

### Monólito sem módulos

- Prós: o menor número de arquivos.
- Contras: as regras de segurança se espalham e fica difícil testar cada parte isoladamente.
- Drivers: ganha em simplicidade, perde em fronteiras legíveis.

## Links

- ADRs relacionados: ADR-0002 (linguagem e ORM).
