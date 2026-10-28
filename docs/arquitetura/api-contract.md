# API Contract — <nome do projeto>

> Registro de endpoints da API de **<produto>** (`<diretório do back>`).
>
> **Consulte antes de criar endpoint novo**, para não duplicar.
> **Atualize ao criar ou alterar endpoint, na mesma passada que o código** — contrato que só
> existe no código é contrato que ninguém encontra.
>
> Fonte gerada: <caminho do OpenAPI gerado \| "não há — este registro é a única fonte">.

## Convenções

- **Estilo e prefixo:** <REST, prefixo `/api`, recursos em <idioma>, `kebab-case`>.
- **Versionamento:** <sem versão (evolução aditiva + expand/contract) \| `/v1` no caminho>. Regra de
  breaking change: ver seção *Compatibilidade*.
- **Formatos:** dinheiro como <string decimal `"1234.56"`, nunca `number`>; data `YYYY-MM-DD`;
  instante ISO 8601 com fuso; mês `YYYY-MM`; ids <uuid \| inteiro>. Fuso de referência: <x>.
- **Nulabilidade:** campo ausente × `null` × `[]`: <regra>. Lista nunca é `null`.
- **Enums de resposta:** <abertos — o cliente trata valor desconhecido \| fechados>.
- **Paginação:** <offset `?pagina=&porPagina=` \| cursor `?cursor=&limite=`>; default <n>, máximo
  <n>; envelope `<forma>`; ordenação `?ordenarPor=&direcao=` por whitelist, desempate `id`.
- **Filtros:** intervalos <inclusivos>, multivalor <forma>, filtro desconhecido → 400.
- **Erro:** <`application/problem+json` (RFC 9457) com `code`, `errors[]`, `traceId` \| envelope
  próprio `{ … }`>. Mensagem em <idioma>. Erro inesperado nunca expõe detalhe interno.
- **Status de recusa:** 400 entrada malformada · 401 sem sessão · 403 sem permissão · 404 não
  encontrado · 409 conflito com o estado · 422 regra de negócio · 429 limite de taxa.
- **Idempotência:** <quais mutações exigem `Idempotency-Key`; TTL; comportamento>.

## Autenticação

<Fechado por padrão: toda rota exige <mecanismo>, exceto as marcadas como públicas. Sem
credencial → 401; sem permissão → 403 com mensagem genérica.>

---

## <Módulo> (<épico>)

<Prefixo do módulo, permissões de leitura e escrita, regras que valem para todas as rotas.>

| Método | Endpoint | Descrição | Auth / permissão | Épico/Spec |
|--------|----------|-----------|------------------|------------|
| | | | | |

<!-- Uma seção por módulo. Entrada no formato de endpoint-entry-template.md. -->

---

## Deprecações

| Endpoint / campo | Depreciado em | Sunset | Substituto | Uso ainda medido? |
|---|---|---|---|---|

## Compatibilidade — changelog de breaking changes

| Data | Endpoint | Mudança | Estratégia | Consumidores avisados |
|---|---|---|---|---|
