# Contexto do projeto — Sistema de Peças (Outlet do Celular)

> Atualizado em: 2026-07-01, após implementar separação operacional (migration 009,
> `src/separation/`, API `/api/separation-batches/*`, tela `/separacao`).
> Mantenha este documento enxuto — veja "Regras de manutenção" no final antes de editar.

## 1. Projeto

- **Nome:** Sistema de Peças (outlet do celular).
- **Objetivo:** substituir gradualmente as planilhas Excel que controlam pedidos de peças,
  estoque, priorização e distribuição de peças para reparo de celulares. A função-alvo final
  (fase futura) é encontrar **MATCHs**: conectar uma peça disponível em estoque a um aparelho
  que precisa dela.
- **Operação atendida:** outlet de celulares com fluxo de análise técnica → pedido de peça →
  cotação/compra → recebimento → bipagem diária de estoque → (futuro) distribuição por match.
- **Estágio atual:** a importação Excel (`PEDIDOS.xlsx` + `ANALISE MI.xlsx`) é uma
  **inicialização única do sistema** — depois da primeira importação confirmada, o SQLite é a
  fonte operacional oficial e novas importações ficam bloqueadas (`system_state.initialized`).
  Implementados: bipagem operacional (snapshot oficial), solicitações de compra aprovadas,
  pedidos de compra, recebimento (com movimentações de estoque), estoque operacional
  (base oficial + movimentações posteriores), **motor de match** (`src/match/`, migration 007,
  API `/api/match-runs/*`, tela `/match`) e **separação operacional** (`src/separation/`,
  migration 009, API `/api/separation-batches/*`, tela `/separacao`). O match é recomendação
  calculada — apenas a separação cria `stock_movements` (`REPAIR_CONSUMPTION`) e
  `operational_events` (`PART_SEPARATED`). Estorno ainda não implementado.

## 2. Domínio

- **Uma linha = uma solicitação de uma peça.** Um aparelho que precisa de N peças gera N
  linhas.
- **`ID_PEDIDO`** é a identidade **única e estável** da linha/solicitação. Nunca se repete
  dentro do mesmo snapshot — se repetir, é erro de preenchimento da planilha
  (`DUPLICATE_ID_PEDIDO`), não uma "peça extra" do mesmo pedido.
- **`IMEI`** é a identidade do **aparelho/kit**. Várias linhas (vários `ID_PEDIDO`) com o
  mesmo IMEI são peças diferentes do mesmo aparelho — caso normal, não duplicidade. O
  agrupamento por IMEI acontece só na consulta (`groupByDevice`), nunca na identidade gravada.
- **`OS`** é contexto/validação, não identidade. O sistema avisa (não bloqueia) quando o
  mesmo IMEI aparece com OS diferentes entre suas linhas.
- **Estoque físico**: uma linha = uma unidade física (não uma referência consolidada). Uma
  mesma `REFERENCIA` pode aparecer em várias linhas — cada uma é uma unidade distinta. Não
  existe controle de localização física (e não deve ser criado).
- **Arquivos de origem e precedência:**
  - `PEDIDOS.xlsx` é a fonte primária do estado operacional (status, kit, prioridade, ordem,
    estoque, match) — **prevalece** em caso de conflito.
  - `ANALISE MI.xlsx` é a origem analítica e de cotações (marca/modelo/cor/solicitante,
    `PEÇAS A PEDIR`) — prevalece para esses campos.
  - Conflitos detectados (ex.: status divergente do mesmo `ID_PEDIDO` entre os dois arquivos)
    nunca são resolvidos silenciosamente — viram ocorrência `CONFLICT` (`STATUS_CONFLICT`),
    contada separadamente e **não fatal**.
- **Bipagem (contagem física)**: 1 beep = 1 unidade; beeps repetidos nunca são deduplicados —
  10 beeps da mesma referência geram 10 linhas em `count_scans` e quantidade 10. Cada sessão
  fica vinculada ao lote ativo no momento da criação (esse lote é o catálogo). A referência
  bipada é classificada contra o catálogo + mapeamentos manuais (`reference_mappings`) — nunca
  resolvida silenciosamente em caso de conflito (`CONFLICT`). O **estoque oficial** passa a ser
  o último `stock_snapshot` `OFFICIAL`, não mais o `source_inventory_items` importado; este
  último nunca é apagado/alterado pela bipagem — fica como base de comparação ("legado").

## 3. Regras definidas

Ver detalhes completos em [docs/regras-negocio.md](regras-negocio.md) e
[docs/importacao-legado.md](importacao-legado.md).

- **Status de pedido** (normalizados internamente, rótulo amigável preservado): `MATCH`,
  `MATCH PARCIAL`, `PEDIR PEÇA`, `SEM SALDO`, `VERIFICAR`, `CONCLUÍDO`, `SEPARADO`,
  `CANCELADO`.
- **Estados permanentes** (`CONCLUIDO`/`CONCLUÍDO`, `SEPARADO`, `CANCELADO`): implementados —
  preservados na importação, normalizados com/sem acento, nunca apagados por reimportação.
- **Status/prioridade de kit:** `KIT POSSÍVEL`=1, `MATCH PARCIAL`=2, `KIT INCOMPLETO`=9,
  `VERIFICAR`=9. Implementado como leitura/preservação do valor legado da planilha.
- **Margem** = VENDA − CUSTO; ausência de custo/venda → margem `null` + warning não fatal.
  Implementado em `src/domain/scoring.ts` (puro, testado), mas **não é recalculado** sobre os
  dados importados nesta fase — os valores legados das planilhas são preservados como estão.
- **Nota de idade** = `floor(IDADE/30)`, teto 15. **Nota de margem** = `INT(MARGEM/150)`
  (estilo Excel, arredonda para −∞; margem negativa pune). **Score** = soma das duas.
  Parâmetros configuráveis via tabela `decision_rules` (não fixos no código) — implementado
  como módulo de domínio testado; **ainda não há UI** para editar a regra nem motor que
  recalcule pedidos com ela.
- **`QTDE DE PEÇAS`**: é o total de linhas necessárias para o aparelho (repete em todas as
  linhas do mesmo aparelho na planilha) — semântica apenas documentada/preservada como valor
  legado; não há validação cruzada automática contra a contagem real de linhas do IMEI nesta
  fase.
- **Ordem de prioridade dos aparelhos** (implementada no motor de match): menor qtd. de
  peças abertas → maior score → maior margem → menor `id_pedido` estável como desempate.
  Implementada em `runMatchEngine` e usa `comparePriority` de `src/domain/scoring.ts`.
- **Bipagem e finalização** (implementadas — ver seção dedicada em
  [docs/regras-negocio.md](regras-negocio.md)): classificação de referência (RECOGNIZED/
  UNKNOWN_REFERENCE/MISSING_KEY/CONFLICT), bloqueadores absolutos vs. proteção de cobertura
  mínima (`COUNT_MIN_COMPLETENESS_RATIO`, padrão 0.80, bypassável só com força + justificativa
  ≥10 caracteres), finalização transacional com rollback completo e idempotência.
- **Motor de match/distribuição** (implementado em `src/match/`): 1ª passagem atende só
  kits completos (tudo ou nada, status `MATCH`, fase `FULL`); 2ª passagem usa saldo restante
  (`MATCH PARCIAL`/`PEDIR PEÇA`/`SEM SALDO`/`VERIFICAR`); ordem de consumo por `CHAVEPECA`,
  reiniciando em 1 para cada peça diferente. Consume `getCurrentOperationalStock()` (base
  oficial + movimentações posteriores). **Nunca** cria `stock_movements` nem
  `operational_events` — é recomendação calculada apenas. Fingerprint SHA-256 detecta
  reutilização (`force=false`) e staleness.

## 4. Arquitetura atual

**Stack:** Node.js 22.5+ (ambiente atual: Node 24 LTS), TypeScript estrito, React 18 + Vite 6,
Express 4, `node:sqlite` (carregado via `createRequire` para compatibilidade com
Vite/Vitest), Zod, `xlsx` 0.18.5, Vitest 2. Um único `package.json`/repositório.

```
src/
  client/      React + Vite — App.tsx, api.ts, ui.tsx,
               pages/{Importar,Diagnostico,Pedidos,Estoque,Movimentacoes,Cotacoes,Bipagem,Compras,Match,Separacao}.tsx
  server/      Express — config.ts, app.ts, index.ts,
               routes/{import-routes,data-routes,counting-routes,procurement-routes,match-routes,separation-routes}.ts
  shared/      types.ts — tipos compartilhados client/server (sem dependências)
  domain/      text.ts, status.ts, scoring.ts, reference-catalog.ts, procurement.ts (normalização
               de status de cotação) — regras puras e testadas
  db/          database.ts, migrate.ts, migrations/*.sql, repository.ts, queries.ts,
               counting-repository.ts, counting-queries.ts
  import/      xlsx-reader.ts, value.ts, columns.ts, table-detection.ts, mappers.ts, import-service.ts
  counting/    counting-service.ts — sessões (com baseline operacional congelada), scans,
               pendências, resumo, finalização transacional
  system/      system-service.ts — estado global de inicialização (system_state)
  operational/ stock-service.ts (estoque operacional + livro de movimentações),
               procurement-service.ts (solicitações + pedidos de compra),
               receiving-service.ts (recebimento transacional)
  match/       match-engine.ts (algoritmo puro, sem DB), match-fingerprint.ts (SHA-256 staleness),
               match-repository.ts (DB reads/writes), match-service.ts (orquestrador transacional)
  separation/  separation-types.ts, separation-status.ts, separation-repository.ts,
               separation-service.ts — separação operacional (reserva → confirmação → consumo)
scripts/    audit-real.ts — auditoria reproduzível com arquivos reais (npm run audit:real)
tests/      domain, import-mapping, import-service, fatal-issues, migration-guard,
            staged-detection, server-config, audit-real, counting-service, counting-integration,
            counting-baseline, system-initialization, procurement (+ helpers, global-setup)
docs/       modelo-dados.md, importacao-legado.md, regras-negocio.md, REAL_DATA_AUDIT.md
            (gerado), PROJECT_CONTEXT.md (este arquivo)
audit/      concluded-sample.csv, status-conflicts.csv (gerados por audit:real, não versionados)
data/       app.sqlite (operacional, não versionado), backups/, tmp/ (uploads temporários)
```

**Frontend:** rotas `/importar` (somente leitura após inicialização), `/diagnostico`,
`/pedidos`, `/compras` (abas Aprovados/Aguardando/Recebidos/Cancelados), `/bipagem`, `/estoque`,
`/estoque/movimentacoes`, `/cotacoes`, `/match`, `/separacao` — todas consumindo a API via
`fetch`; nenhuma regra de negócio no cliente (o backend recalcula e bloqueia de fato; o cliente
só reflete o estado retornado). A tela `/match` exibe aviso permanente de que o resultado é
recomendação calculada, sem movimentação de estoque. A tela `/separacao` permite criar lotes
de separação a partir de runs de match, confirmar ou cancelar por peça/aparelho/lote.

**Backend (endpoints):**
- `POST /api/importar/preview`, `POST /api/importar/confirmar` (bloqueada após inicialização,
  salvo `ALLOW_LEGACY_REIMPORT=true`), `GET /api/importar/state`.
- `GET /api/diagnostico`, `GET /api/pedidos`, `GET /api/cotacoes`, `GET /api/health`.
- `GET /api/estoque` — legado, snapshot oficial e **estoque operacional** (`base`+`movimentos`
  posteriores+`atual`).
- `GET/POST /api/count-sessions*`, `.../scans`, `.../references/*`, `.../finalize`,
  `GET /api/count-sessions/:id/{state,summary,pending,reference-catalog/keys}`,
  `GET /api/stock-snapshots/{latest,:id}` — bipagem.
- `GET /api/system/state` — estado de inicialização.
- `GET /api/purchase-requests[/:id]` — solicitações aprovadas.
- `POST/GET /api/purchase-orders[/:id]`, `POST /api/purchase-orders/:id/cancel`.
- `POST /api/purchase-orders/:id/receipts/{preview,confirm}`, `GET .../receipts`,
  `GET /api/goods-receipts/:id`.
- `GET /api/stock/current`, `GET /api/stock/movements`.
- `POST /api/match-runs` (executa ou reutiliza), `GET /api/match-runs` (lista),
  `GET /api/match-runs/latest`, `GET /api/match-runs/:id`,
  `GET /api/match-runs/:id/{devices,results,stock-summary,comparison,export-csv}`,
  `GET /api/match-runs/current-state`, `GET /api/decision-rules/active`.
- `POST /api/separation-batches` (criar lote), `GET /api/separation-batches` (listar),
  `GET /api/separation-batches/:id/state`,
  `POST /api/separation-batches/:id/{confirm-all,cancel}`,
  `POST /api/separation-batches/:id/devices/:deviceId/{confirm,cancel}`,
  `POST /api/separation-batches/:id/items/:itemId/{confirm,cancel}`.
- Códigos HTTP: 400 entrada inválida, 404 recurso inexistente, 409 conflito de estado/
  idempotência, 422 regra operacional bloqueando.

**Importador:** detecção de tabelas por **conteúdo de cabeçalho** (não por posição/aba), em
**etapas** (1ª passagem só lê abas com nome candidato a um papel conhecido; só expande para o
restante se algum papel faltar; abas históricas conhecidas como `His Estoque` nunca são lidas
em nenhuma etapa). Mapeamento linha-a-linha com geração de `ImportIssue` tipado por severidade
(`ERROR`/`WARNING`/`CONFLICT`) e código; ocorrências fatais (`NO_VALID_ORDERS`,
`NO_VALID_INVENTORY`, `REFERENCE_KEY_CONFLICT`, etc.) são sobre **registros válidos**, não
sobre linhas encontradas.

**Banco:** migrations versionadas e idempotentes (`schema_migrations`), aplicadas no boot do
servidor com backup prévio do `data/app.sqlite` (o backup faz `PRAGMA wal_checkpoint(TRUNCATE)`
antes de copiar). O runner suporta **guardas de pré-migração** (`PRE_MIGRATION_GUARDS` em
`migrate.ts`) que abortam o lote inteiro se a migration nomeada for insegura para o estado
atual do banco — usado para proteger `002_fix_order_identity.sql` contra perda silenciosa.

**Auditoria:** `scripts/audit-real.ts` (`npm run audit:real`) roda a importação real contra um
banco temporário e gera `docs/REAL_DATA_AUDIT.md` + `audit/*.csv` — reproduzível, sem depender
de validação manual via HTTP.

**Bipagem (`src/counting/counting-service.ts`):** classificação de referência pura em
`src/domain/reference-catalog.ts` (mesma normalização de texto do domínio); resolução manual
(`reference_mappings`) é recalculada *ao vivo* em cada leitura, nunca mutando o
`mapping_status` histórico gravado no scan. Finalização roda em transação, com rollback
completo em falha e idempotência (re-finalizar devolve o snapshot já existente). Proteção de
cobertura mínima via `config.countMinCompletenessRatio` (env `COUNT_MIN_COMPLETENESS_RATIO`).

## 5. Modelo de dados (responsabilidades, sem repetir o SQL — ver docs/modelo-dados.md)

- `import_batches`: cabeçalho de cada importação (arquivos, hashes para idempotência, status,
  contagens encontradas/importadas, `warnings_count`/`errors_count`/`conflicts_count`
  independentes).
- `import_issues`: toda ocorrência da importação (severidade, código, localização, chave da
  entidade); base do `/diagnostico`.
- `source_order_parts`: snapshot de pedidos. `UNIQUE(import_batch_id, id_pedido)` — identidade
  corrigida nesta tarefa (antes era incorretamente `id_pedido + chave_peca`).
- `source_inventory_items`: snapshot de estoque, uma linha por unidade física; `id_peca_estoque`
  só quando a coluna existir na origem (nunca inventado, nunca é o número da linha).
- `source_quotations`, `source_order_analysis`: snapshots de cotação e origem analítica.
- `operational_events`: **preparada, vazia** — ainda sem ações operacionais sobre pedidos.
- `count_sessions`/`count_scans` (migration 004): sessão de contagem (no máx. uma `OPEN`,
  índice único parcial) e cada beep (nunca apagado/deduplicado). Ver §6 e
  [regras-negocio.md](regras-negocio.md).
- `reference_mappings` (migration 004): correções manuais de referência → CHAVEPECA;
  `reference_norm` único só entre ativos; não pertence a nenhum `import_batch`.
- `stock_snapshots`/`stock_snapshot_items` (migration 004): resultado da finalização — o
  snapshot `OFFICIAL` mais recente é o estoque oficial.
- `match_runs`: cabeçalho de cada execução de match (status, hash, regra, estoque snapshot,
  stats de aparelhos/linhas/unidades). `UNIQUE INDEX` impede dois `RUNNING` simultâneos.
- `match_device_results`: resultado por aparelho (kit_status, priority_rank, warning_codes_json).
- `match_results`: resultado por linha/pedido (result_status, allocation_phase, reserved_units,
  ordem_consumo, stock_for_key_initial/before/after, margin, score). `UNIQUE(match_run_id, id_pedido)`.
- `decision_rules`: política de score configurável; lida pelo domínio e pelo motor de match.
  Não há tela para editar — configurada apenas via SQL direto por ora.
- `separation_batches` (migration 009): lote de separação criado a partir de um `match_run`.
  Status: `OPEN` → `PARTIALLY_COMPLETED` | `COMPLETED` | `CANCELLED`. Número sequencial
  `SEP-YYYYMMDD-NNNN` por dia. `idempotency_key UNIQUE` garante idempotência de criação.
- `separation_items` (migration 009): um item por peça separada. Status: `RESERVED` →
  `CONFIRMED` | `CANCELLED`. `UNIQUE INDEX` impede reserva duplicada do mesmo `id_pedido`
  ativo (somente `NOT CANCELLED`); impede também dois itens do mesmo `match_result_id` ativos
  no mesmo batch. Confirmação cria `REPAIR_CONSUMPTION` em `stock_movements` e
  `PART_SEPARATED` em `operational_events`; cancelamento libera reserva sem criar movimento.
- `system_state` (migration 005): linha única global; `initialized`/`initial_import_batch_id`
  marcam se/quando o sistema foi inicializado pela primeira importação confirmada.
- `purchase_requests` (migration 006): solicitações de compra aprovadas, inicializadas a partir
  de `source_quotations` com status normalizado `APROVADO`/`APROVADA`
  (`UNIQUE(source_quotation_id)` — nunca duplica).
- `purchase_orders`/`purchase_order_items` (migration 006): pedidos de compra
  (`PC-AAAAMMDD-NNNN`), com saldo pedido/recebido por item.
- `goods_receipts`/`goods_receipt_items` (migration 006): recebimentos confirmados (parciais
  permitidos; sobre-recebimento exige força + justificativa).
- `stock_movements` (migration 006): livro-razão append-only; hoje só `PURCHASE_RECEIPT` é
  gravado (demais tipos preparados no `CHECK`, sem fluxo). `stock_snapshots.baseline_movement_id_max`
  e `count_sessions.baseline_*` marcam o corte que evita dupla contagem (ver §6).

## 6. Funcionalidades implementadas (verificadas no código)

- Upload e leitura server-side dos dois arquivos `.xlsx` reais (nunca alterados).
- Detecção de tabelas por cabeçalho, robusta à posição/nome da aba e a qual dos dois arquivos
  contém cada tabela.
- Importação transacional com **rollback completo** em falha (testado).
- **Idempotência por hash dos dois arquivos** — reimportar os mesmos arquivos não duplica nada
  e reaproveita o lote existente (testado, inclusive com os arquivos reais).
- Preservação de `operational_events` e de status permanentes através de reimportações
  (testado).
- Identidade corrigida: `ID_PEDIDO` único por linha; IMEI agrupa; duplicidade de `ID_PEDIDO`
  rejeitada com erro; mesmo IMEI com `ID_PEDIDO`s diferentes importa normalmente (testado).
- Diagnóstico de estoque: `INVENTORY_CHAVEPECA_EMPTY`, `INVENTORY_ID_COLUMN_MISSING` (único,
  com total), `MISSING_ID_PECA_ESTOQUE` (por linha), `DUPLICATE_ID_PECA_ESTOQUE` (testado).
- Detecção de conflito **referência → chave** (`REFERENCE_KEY_CONFLICT`), tratado como erro
  estrutural **fatal** (testado).
- Classificação fatal vs. não fatal, com `canConfirm`/`fatalIssuesCount` na prévia e
  recálculo independente (HTTP 422) na confirmação — testado, inclusive sem depender do
  frontend.
- `conflicts_count` persistido e exibido separadamente de `warnings_count`/`errors_count`
  (testado).
- Tela `/pedidos`: agrupada por IMEI, `ID_PEDIDO` exibido em cada linha de peça, OS no
  cabeçalho, aviso visual quando o mesmo IMEI tem OS divergentes.
- Telas `/estoque`, `/cotacoes`, `/diagnostico` somente leitura, com busca/filtros.
- **Fatal por registros válidos, não por linhas encontradas:** `NO_VALID_ORDERS`/
  `NO_VALID_INVENTORY` disparam quando `records.length === 0`, mesmo que existam linhas
  não-vazias todas rejeitadas (cenário que antes escapava como `canConfirm: true`) — testado.
  A prévia expõe `counts.{ordersFound,ordersValid,inventoryFound,inventoryValid,...}` e
  `durationMs` da detecção+mapeamento.
- **Estoque agrupado por (referência, chave)**, nunca só por referência: unidades sem
  `CHAVEPECA` nunca aparecem sob a chave de outra unidade da mesma referência. Cada grupo tem
  `mapeada: boolean`; a tela `/estoque` mostra "SEM CHAVE" nos grupos não mapeados (testado).
- **Guarda de pré-migração** em `src/db/migrate.ts`: antes de aplicar
  `002_fix_order_identity.sql`, verifica duplicidade `(import_batch_id, id_pedido)` em
  `source_order_parts` no schema antigo; aborta com amostra dos IDs se encontrar, sem tocar o
  banco (testado).
- **Detecção em etapas** (`src/import/table-detection.ts` + `import-service.ts`): 1ª passagem lê
  só abas cujo nome é candidato a um papel conhecido; só expande para as demais (uma por vez)
  se algum papel ainda faltar; abas históricas conhecidas (`His Estoque`, `TODOS`, `SH`, `COM
  SALDO`, `DEMONSTRATIVO DE SALDO`, `TABELA DE AVALIAÇÃO`) nunca são lidas, em nenhuma etapa
  (testado, inclusive um caso adversarial onde a aba histórica "esconde" um cabeçalho válido).
- **`npm run audit:real -- --orders <p1> --analysis <p2>`**: roda a importação real (mesmos
  componentes) contra um banco temporário, gera `docs/REAL_DATA_AUDIT.md` e
  `audit/{concluded-sample,status-conflicts}.csv`. Testado com fixtures pequenas
  (`tests/audit-real.test.ts`); a função `runAudit` é exportada de `scripts/audit-real.ts`.
- **`SERVER_HOST`** (padrão `127.0.0.1`): o Express escuta só em localhost por padrão —
  sem autenticação ainda, beta local, somente arquivos confiáveis (testado o default).
- **Bipagem operacional completa** (tela `/bipagem`, migration 004): sessão vinculada ao lote
  ativo, com no máximo uma `OPEN` por vez (índice único parcial; 409 com o id da existente);
  beep registra exatamente uma unidade, nunca deduplicado (10 beeps = 10 linhas + quantidade
  10); classificação de referência (RECOGNIZED/UNKNOWN_REFERENCE/MISSING_KEY/CONFLICT) contra
  catálogo + mapeamentos manuais, nunca resolvida silenciosamente; cancelamento de scan/sessão
  nunca apaga linha, é idempotente; resolução manual de pendência recalculada ao vivo
  (mapeamento tem precedência sobre o catálogo); consolidação na finalização agrupa por
  `reference_norm` (recalcula a chave efetiva uma única vez por referência, somando TODOS os
  beeps ativos daquela referência — corrige a perda de unidades quando havia beeps antes e
  depois de uma resolução manual), com checagem de integridade
  `SUM(items) = total_units = beeps ativos reconhecidos` antes do commit (rollback em
  divergência); finalização transacional com todos os bloqueadores recalculados no backend,
  idempotente ao re-chamar, resposta usa o resumo pré-commit (nunca retorna bloqueador falso);
  sessão `FINALIZED`/`CANCELLED` é imutável (409 em qualquer mutação); `GET
  /count-sessions/:id/state` é a fonte única de recuperação após F5 (sessão+resumo+scans
  recentes+totais por referência+pendências); autocomplete de CHAVEPECA usa o catálogo da
  SESSÃO (não o lote mais recente) e o backend rejeita chave fora do catálogo (400); histórico
  de mapeamento preservado ao trocar chave (desativa o antigo, nunca apaga); responsável real
  (`session.responsible_name`) em toda ação, sem valores fixos; proteção de cobertura mínima
  (`COUNT_MIN_COMPLETENESS_RATIO`) e o novo aviso `STOCK_MOVEMENTS_DURING_COUNT` (recebimento
  durante a contagem) são bypassáveis só com força + responsável + justificativa ≥10 caracteres
  (contagem vazia nunca pode ser forçada); snapshot oficial nunca cria `match_runs`/
  `match_results`.
- **Importação como inicialização única** (migration 005, `src/system/system-service.ts`): a
  primeira importação confirmada roda `initializeSystem` DENTRO da transação de `confirm()` —
  fixa `initial_import_batch_id`, cria `purchase_requests` a partir de cotações aprovadas
  (`APROVADO`/`APROVADA`, normalização centralizada em `src/domain/procurement.ts`) e marca
  `initialized=1`; idempotente. Novas importações são bloqueadas (`409`) salvo
  `ALLOW_LEGACY_REIMPORT=true` (só dev/teste); `/importar` fica somente leitura no frontend.
- **Pedidos de compra e recebimento** (migration 006, `src/operational/{procurement,receiving}-service.ts`):
  `/compras` (abas Aprovados/Aguardando/Recebidos/Cancelados) gera pedidos numerados
  (`PC-AAAAMMDD-NNNN`) a partir de solicitações aprovadas; recebimento parcial permitido,
  sobre-recebimento exige `allowOverReceipt` + responsável + justificativa ≥10 caracteres;
  CHAVEPECA recebida é validada contra o catálogo operacional; cada item recebido cria
  exatamente um `stock_movements` (`UNIQUE(source_type,source_id)` — idempotente, sem
  duplicar); tudo transacional com rollback completo em falha.
- **Estoque operacional** (`src/operational/stock-service.ts::getCurrentOperationalStock`):
  ESTOQUE ATUAL = BASE OFICIAL (último snapshot `OFFICIAL` ou, na ausência, a importação
  inicial) + MOVIMENTAÇÕES POSTERIORES AO CORTE (por id de movimentação, nunca por timestamp —
  evita dupla contagem e empates); quantidade negativa por grupo é erro de integridade. Sessões
  de contagem congelam essa base no início (`count_sessions.baseline_*`); o snapshot da
  finalização absorve as movimentações ocorridas antes dele
  (`stock_snapshots.baseline_movement_id_max`). `/api/estoque` e `/estoque/movimentacoes`
  expõem base/movimentos/atual e o livro-razão filtrável.
- **Separação operacional** (`src/separation/`, migration 009, tela `/separacao`):
  criação de lote a partir de run de match com stale-check (impede separar run desatualizado
  por novas reservas — `maxActiveReservationId` no fingerprint); reserva lógica
  (`reservedQuantity`/`availableQuantity` em `getCurrentOperationalStock`); confirmação de
  peça/aparelho/lote com criação atômica de `REPAIR_CONSUMPTION` + `PART_SEPARATED`;
  cancelamento libera reserva sem criar movimento; status do lote recalculado após cada ação
  (`OPEN`/`PARTIALLY_COMPLETED`/`COMPLETED`/`CANCELLED`); idempotência por `idempotency_key`;
  restrição única contra dupla reserva do mesmo `id_pedido` ativo; `confirmPartialItem` só
  funciona em itens `PARTIAL`; `confirmFullDevice` confirma todos os itens `RESERVED` de um
  aparelho; `cancelBatch` sobre lote `COMPLETED` ou `CANCELLED` é idempotente (no-op).
  Estorno não implementado nesta fase.
- Tudo testado: **250 testes** (ver §8), incluindo a separação completa (57 novos testes).

## 7. Dados reais validados

Gerado por `npm run audit:real` contra os arquivos reais em
`G:\Meu Drive\ECOSSISTEMA PEDIDO DE PEÇAS\` (`PEDIDOS.xlsx`, `ANALISE MI.xlsx`), em banco
temporário (nunca toca `data/app.sqlite`). **Relatório completo, com hashes SHA-256, tamanhos,
datas de modificação e tabelas escolhidas: [docs/REAL_DATA_AUDIT.md](REAL_DATA_AUDIT.md)** —
esse arquivo é sobrescrito a cada execução do comando; não edite manualmente, reexecute.

Última execução registrada (ver REAL_DATA_AUDIT.md para os hashes exatos):

| Métrica                                   | Valor      |
| ------------------------------------------ | ---------: |
| Pedidos encontrados / válidos / importados | 1.387 / 1.387 / 1.387 |
| Aparelhos distintos por IMEI               | ~1.075     |
| Unidades de estoque encontradas/importadas | 793 / 793  |
| Referências distintas de estoque           | 525        |
| Cotações                                   | 618        |
| Linhas analíticas                          | 1.387      |
| `CONCLUIDO` no PEDIDOS (persistido)        | 277        |
| `warnings_count` total                     | 122        |
| `errors_count`                             | 0          |
| `conflicts_count` (`STATUS_CONFLICT`)      | 52         |
| Status final do lote                       | `COMPLETED_WITH_WARNINGS` |
| Erros fatais                               | 0          |
| Idempotência (2ª importação)               | confirmada |

Warnings por código: `INVENTORY_CHAVEPECA_EMPTY`=56, `FORMULA_ERROR`=40, `CHAVEPECA_VAZIA`
(pedidos)=25, `INVENTORY_ID_COLUMN_MISSING`=1 (a aba de bipagem atual não tem coluna de ID
físico).

> **Drift conhecido vs. auditoria externa anterior:** uma auditoria externa relatou para os
> mesmos dois arquivos nominais: estoque físico 754, referências 536, cotações 631, CONCLUIDO
> no PEDIDOS **22** (não 277), `STATUS_CONFLICT` 16 (não 52). `PEDIDOS.xlsx`/`ANALISE MI.xlsx`
> são planilhas **operacionais vivas** editadas diariamente pela equipe — os hashes SHA-256
> registrados em cada execução do `audit:real` são a única forma confiável de saber se duas
> auditorias usaram o mesmo conteúdo. Não há hash da auditoria externa disponível para
> comparar diretamente; a diferença é compatível com edição da planilha entre as duas
> auditorias (mais pedidos concluídos, mais conflitos de status, estoque bipado). Estes
> números nunca são constantes de código — sempre reexecute `audit:real` para uma fotografia
> atual antes de confiar em qualquer total.

Reimportar os mesmos dois arquivos foi confirmado idempotente (mesmo lote reaproveitado,
mesmos totais) e `operational_events` inseridos manualmente permaneceram intactos após a
reimportação.

## 8. Testes

- **250 testes** (Vitest), todos passando, em 17 arquivos: `domain.test.ts` (11),
  `import-mapping.test.ts` (12), `import-service.test.ts` (8), `fatal-issues.test.ts` (8),
  `migration-guard.test.ts` (2), `staged-detection.test.ts` (7), `server-config.test.ts` (1),
  `audit-real.test.ts` (1), `counting-service.test.ts` (38), `counting-integration.test.ts` (1),
  `system-initialization.test.ts` (7), `procurement.test.ts` (17), `counting-baseline.test.ts`
  (6), `match-engine.test.ts` (29), `match-service.test.ts` (20), `match-integration.test.ts`
  (25), `separation.test.ts` (57) — mais `helpers.ts`/`global-setup.ts`.
- `npm run typecheck` — 3 projetos: `tsconfig.server.json` (cobre `src/counting`, `src/match`,
  `src/separation`), `tsconfig.client.json`, `tsconfig.scripts.json` — sem erros.
- `npm run build` (`tsc` + `vite build`) — sem erros.
- Comandos reais usados na validação: `npm install`, `npm test`, `npm run typecheck`,
  `npm run build`, `npm run audit:real -- --orders ... --analysis ...`. A validação com
  arquivos reais (importação) é feita pelo `audit:real`; a bipagem é validada por
  `counting-integration.test.ts` (importa fixtures reais via `preview`/`confirm`, depois roda o
  fluxo completo de contagem) — banco temporário, nunca `data/app.sqlite`.

## 9. Decisões definitivas

- Excel **não é** banco operacional — é só fonte de importação/contingência. O SQLite é a
  fonte de verdade.
- Arquivos `.xlsx` enviados **nunca são alterados** (uploads temporários são cópias).
- Regras de negócio vivem no domínio/backend (`src/domain`, `src/import`, `src/db`); o
  frontend só exibe e nunca decide.
- **`ID_PEDIDO` não identifica o aparelho** — identifica a solicitação de uma peça (única).
  **`IMEI` agrupa o aparelho.** Esta foi a correção desta tarefa; o modelo anterior (identidade
  `id_pedido + chave_peca`) estava errado e foi substituído.
- Número de linha **nunca** é identidade permanente (nem em pedidos, nem em estoque).
- **Não existe** controle de localização física de estoque — não deve ser criado.
- Erro de fórmula em campo **opcional** → `null` + warning (linha importada); em campo
  **obrigatório** → erro (linha rejeitada, sem inventar valor).
- Estados permanentes (`CONCLUIDO`/`CONCLUÍDO`, `SEPARADO`, `CANCELADO`) nunca são apagados por
  recálculo/reimportação futura.
- Conflitos estruturais (ex.: referência↔chave) **nunca** são resolvidos silenciosamente
  (nunca `MAX`, nunca "primeira linha"); são reportados e, quando estruturais, bloqueiam a
  confirmação.
- O backend **recalcula** as condições de bloqueio na confirmação — nunca confia apenas no
  que o frontend decidiu mostrar.
- **Fatal é sobre registros válidos, não sobre linhas encontradas.** `rowsFound > 0` com
  `records.length === 0` (todas as linhas rejeitadas) é tão fatal quanto uma tabela vazia.
- Migrations já aplicadas **nunca são editadas silenciosamente** para corrigir um problema —
  cada migration pode ganhar uma **guarda de pré-aplicação** no runner (`migrate.ts`) que
  aborta o lote inteiro se o estado atual do banco tornaria a migration insegura (ex.:
  `INSERT OR IGNORE` descartando duplicidades antigas sem avisar).
- Abas claramente históricas/volumosas de um Excel (ex.: `His Estoque`) **nunca são lidas**,
  nem mesmo para procurar cabeçalho — a heurística de nome é só para REDUZIR a varredura
  inicial; a detecção por conteúdo de cabeçalho continua sendo a autoridade final.
- O servidor não escuta em `0.0.0.0` por padrão enquanto não houver autenticação — `127.0.0.1`
  é o host padrão; mudar isso é uma decisão explícita de quem operar o ambiente.
- **Beep nunca é deduplicado** — cada requisição de scan é uma unidade física real; 10 beeps
  da mesma referência são 10 linhas, nunca consolidadas na gravação.
- **Scan e sessão nunca são apagados** (`DELETE`) — cancelamento só preenche
  `cancelled_at/by/reason`; é sempre idempotente.
- **O `mapping_status` gravado no scan é histórico (o que foi detectado no momento do beep) e
  nunca é reescrito.** A resolução manual (`reference_mappings`) é recalculada *ao vivo* em
  toda leitura (pendências, resumo, finalização) — manual tem precedência sobre o catálogo.
- **Estoque oficial = último `stock_snapshot` `OFFICIAL`**, não `source_inventory_items`
  (que nunca é apagado/alterado pela bipagem — fica como base de comparação "legado").
- **Bloqueadores absolutos de finalização nunca são bypassáveis com força** (sessão vazia,
  pendência ativa, sessão não `OPEN`, sem lote vinculado); só a proteção de cobertura mínima
  (`COUNT_MIN_COMPLETENESS_RATIO`) pode ser forçada, e só com responsável + justificativa
  ≥10 caracteres — uma contagem vazia nunca pode ser forçada.
- Finalização é **transacional e idempotente**: falha faz rollback completo (sessão continua
  `OPEN`, snapshot oficial anterior intacto); re-finalizar uma sessão já `FINALIZED` devolve o
  snapshot existente, sem criar outro.
- **A importação Excel é executada apenas para inicializar o sistema.** Depois disso, o
  sistema é a fonte operacional oficial: pedidos de compra, recebimentos, contagens e
  correções de referência/CHAVEPECA acontecem dentro do sistema, nunca via nova importação.
  `source_*` continuam existindo como fotografia imutável da carga inicial — nunca mais como
  fonte operacional mutável. Reimportar exige `ALLOW_LEGACY_REIMPORT=true` (só dev/teste).
- **Estoque atual nunca soma a mesma movimentação duas vezes.** O corte é sempre por id de
  movimentação (nunca por timestamp) e cada base (snapshot ou importação inicial) tem seu
  próprio corte; uma nova contagem oficial substitui a base anterior e absorve todas as
  movimentações anteriores à sua finalização.
- **Recebimento nunca cria estoque duplicado.** Cada item recebido gera exatamente um
  `stock_movements`, com restrição única por origem — confirmar a mesma requisição de novo é
  idempotente, nunca soma duas vezes.

## 10. Pendências

**Bloqueadores:** nenhum conhecido. Separação operacional validada (250 testes + typecheck + build).

**Últimas mudanças relevantes (mais recentes primeiro, máx. 5):**
1. **Separação operacional** (migration 009, `src/separation/`, API `/api/separation-batches/*`, tela `/separacao`): reserva lógica de estoque no match, confirmação com `REPAIR_CONSUMPTION`+`PART_SEPARATED`, cancelamento sem movimento, stale-check via `maxActiveReservationId` no fingerprint, `availableQuantity`/`reservedQuantity` em `getCurrentOperationalStock`, tela `/estoque` atualizada com colunas Reservado/Disponível, tela `/match` com checkbox para PARTIAL. 57 novos testes de integração. Estorno fora do escopo.
2. **Inicialização da base operacional**: Banco inicializado (`system_state.initialized = 1`) usando lote #1, criando 175 solicitações de compra aprovadas. Backups em `data/backups/`.
3. **Motor de match** (migration 007, `src/match/`, API `/api/match-runs/*`, tela `/match`): algoritmo puro em 2 passagens, fingerprint SHA-256. Nunca cria `stock_movements` nem `operational_events`. 74 testes.
4. **Estoque operacional + pedidos de compra + recebimento** (migration 006): base oficial + movimentações posteriores, recebimento transacional idempotente.
5. **Bipagem operacional completa** (migration 004): sessão, scans, finalização transacional, snapshot oficial.

**Melhorias futuras (fora do escopo das tarefas já concluídas):**
- `confirm()` (importação) re-lê os arquivos copiados no diretório do lote; se o servidor
  reiniciar entre a prévia e a confirmação, a confirmação falha com `410`.
- A regra de margem/score/idade ainda não é recalculada sobre os dados reais — só os valores
  legados das planilhas são preservados; o motor de decisão (`src/domain/scoring.ts`) existe e
  é testado isoladamente, mas nada na importação o invoca ainda.
- Tela/endpoint para editar a `decision_rules` ativa.
- Validar `QTDE DE PEÇAS` contra a contagem real de linhas do IMEI (hoje é só um valor legado
  preservado, sem checagem cruzada).
- A leitura de Excel ainda reabre o arquivo várias vezes por importação; reaproveitar um único
  buffer/parse por arquivo reduziria ainda mais o tempo de prévia em arquivos grandes.
- Bipagem: a busca de CHAVEPECA do catálogo (`/api/reference-catalog/keys`) não é testada com
  volume real (~525 referências); paginação/relevância podem precisar de ajuste no uso real.

## 11. Próxima fase

A separação operacional (reserva + confirmação com consumo de estoque) está implementada.
Fase seguinte possível: **estorno de separação** — desfazer uma confirmação já realizada,
criando um `stock_movements` de crédito e revertendo o status de `CONFIRMED` para um estado
estornado. Não implementar sem solicitação explícita.

## 12. Comandos

```bash
npm install        # instalar dependências
npm test           # rodar a suíte Vitest
npm run typecheck  # tsc --noEmit (server + client + scripts)
npm run build      # compilar server (tsc) + client (vite build)
npm run dev         # ambiente de desenvolvimento (Vite :5173 + API :127.0.0.1:3001, proxy /api)
npm start           # produção: serve a API e o client compilado em 127.0.0.1:3001 (requer build antes)
npm run audit:real -- --orders "<PEDIDOS.xlsx>" --analysis "<ANALISE MI.xlsx>"  # auditoria com dados reais
```

---

## Regras de manutenção deste documento

- Atualize este arquivo **depois de cada tarefa relevante** (não a cada commit pequeno).
- Mantenha **estado atual**, não um diário — descreva "como o sistema é agora", não a
  sequência cronológica de mudanças.
- Na seção "Pendências"/mudanças recentes, mantenha **no máximo as últimas cinco** mudanças
  relevantes; remova o que ficou superado em vez de acumular histórico.
- Não copie logs extensos, prompts do usuário, nem arquivos de código inteiros aqui — descreva
  responsabilidade e comportamento, não implementação linha a linha.
- Marque explicitamente o que é **regra futura/não implementada** vs. o que está **verificado
  no código** — nunca apresente uma regra como implementada só porque está documentada em
  `docs/regras-negocio.md`.
- Mantenha o documento abaixo de ~12.000 tokens; se crescer demais, corte detalhe histórico
  primeiro, nunca a seção de decisões definitivas.
