# Política de segurança

## Versões cobertas

Este é um projeto de portfólio sem releases publicadas. Só o código da branch `main` recebe
correções de segurança.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública** para uma vulnerabilidade.

Use o reporte privado do GitHub (GitHub Security Advisories):

1. Abra a aba **Security** do repositório
   [maykontardoche/api-cadastro](https://github.com/maykontardoche/api-cadastro/security).
2. Clique em **Report a vulnerability**.
3. Descreva o problema, os passos para reproduzir, o impacto e, se tiver, uma sugestão de
   correção.

O relato fica visível só para você e para o mantenedor até a correção ser publicada.

## O que esperar

- Confirmação do recebimento e uma primeira avaliação assim que possível. Como o projeto é
  mantido por uma pessoa, não há prazo garantido.
- Correção na `main` e um advisory publicado com crédito a quem reportou, se você quiser.

## Escopo

Estão no escopo o código deste repositório, a imagem Docker definida no `Dockerfile` e o
workflow de CI. Não estão no escopo:

- ataques de negação de serviço por volume;
- vulnerabilidades em dependências sem um caminho de exploração por esta API (essas vão
  direto para o projeto da dependência);
- as credenciais dos bancos locais do `compose.yaml`, que são públicas de propósito e servem só
  para containers descartáveis.

Testes ativos só contra uma instância sua, rodando localmente. Não há ambiente público para
testar.
