# Status do projeto

> Atualizado ao **fechar uma feature** (não a cada tarefa) e ao liberar uma versão.

**Última atualização:** 2026-10-28

## Em andamento

| Feature | Pasta | Tarefas | Observação |
|---|---|---|---|
| — | — | — | — |

## Pronto para implementar

| Feature | Pasta | Depende de |
|---|---|---|
| — | — | — |

## Planejado

| Feature | Próximo passo |
|---|---|
| API Cadastro MVP: review da branch e QA | Multi-review da feature e QA contra o PRD, rodando os exemplos do README contra o Compose |
| `Cache-Control: no-store` nas respostas de token e nas leituras autenticadas | Primeira correção prevista; ver *Notas* |

## Bloqueado

| Feature | Bloqueio | Quem destrava |
|---|---|---|
| — | — | — |

## Concluído

| Feature | Data | Pasta | Release |
|---|---|---|---|
| API Cadastro MVP: cadastro, sessão, perfil, administração, saúde, OpenAPI, containers, CI e documentação (12 de 12 tarefas) | 2026-10-28 | — | Sem release; integrado na `main` |

## Notas

- Decisões aceitas: ADR-0001 (monólito modular), ADR-0002 (TypeScript + Prisma 7.10.1), ADR-0003 (modelo de sessão) e ADR-0004 (OpenAPI gerado das declarações de rota).
- Pendência para o review de segurança antes do release: as respostas de token (`login`, `refresh`) e as leituras autenticadas ainda não mandam `Cache-Control: no-store` (RFC 6749 §5.1). O risco é baixo (sem frontend; caches compartilhados não guardam respostas a requisições com `Authorization`), mas a política precisa ser explícita.
