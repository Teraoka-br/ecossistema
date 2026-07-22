# Contexto do projeto — Sistema de Peças (Outlet do Celular)

> Atualizado em: 2026-07-21, após revisão dos problemas abertos na Central de Problemas.
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
  (base oficial + movimentações posteriores), **motor único de match** (`src/match/`,
  função pura `calculateMatch` + migration 038 — o motor legado id_pedido/migration 007 e a
  separação antiga/migration 009 foram aposentados),
  **autenticação/sessões** (migration 010, `src/auth/`, `src/audit/`, `src/staff/`),
  **domínio de reparo** (`repair_cases`/`part_requests`/`repair_case_priorities`, migration 011,
  `src/repair/`, API `/api/repair-cases/*`), **intake do Datasys**
  (`src/datasys/`, API `/api/datasys/*`, tela `/admin/datasys`) e
  **novo shell visual** (dark mode industrial, sidebar com grupos Operação/Suprimentos/Administração).
  O match é recomendação calculada — apenas a separação cria `stock_movements` (`REPAIR_CONSUMPTION`) e
  `operational_events` (`PART_SEPARATED`). Estorno e motor de match de repair_cases não implementados.

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
- **Margem** = venda estimada − custo, calculada pelo motor com precisão decimal completa.
  Score **sem arredondamento** (o `floor`/INT estilo Excel foi aposentado junto com
  `src/domain/scoring.ts` e `decision_rules`): parâmetros vivem em `match_rule_sets`
  (nome, versão, margem/pt, dias/pt, teto de idade, pesos, margem negativa), editáveis na
  tela `/admin/regras-match`, exatamente UMA regra ativa (índice único parcial).
- **`QTDE DE PEÇAS`**: é o total de linhas necessárias para o aparelho (repete em todas as
  linhas do mesmo aparelho na planilha) — semântica apenas documentada/preservada como valor
  legado; não há validação cruzada automática contra a contagem real de linhas do IMEI nesta
  fase.
- **Ordem de prioridade dos aparelhos** (motor único): prioridade manual → maior score →
  maior margem → maior idade → menor id do caso (desempate determinístico). Quantidade de
  peças NÃO é critério de prioridade — só determina se o kit fecha naquele momento.
- **Bipagem e finalização** (implementadas — ver seção dedicada em
  [docs/regras-negocio.md](regras-negocio.md)): classificação de referência (RECOGNIZED/
  UNKNOWN_REFERENCE/MISSING_KEY/CONFLICT), bloqueadores absolutos vs. proteção de cobertura
  mínima (`COUNT_MIN_COMPLETENESS_RATIO`, padrão 0.80, bypassável só com força + justificativa
  ≥10 caracteres), finalização transacional com rollback completo e idempotência.
- **Motor de match ÚNICO** (consolidado em 2026-07-16): a decisão vive EXCLUSIVAMENTE na
  função pura `calculateMatch` (`src/match/calculate-match.ts`) — sem banco, sem HTTP,
  determinística, **sem arredondamento** (score decimal exato: margem/`marginPerPoint`×peso +
  min(idade/`diasPorPonto`, teto)×peso). Elegibilidade com motivos de VERIFICAR (IMEI/modelo/
  custo/venda/idade/depósito/peça/referência); depósito elegível só `AGUARDANDO PECA` e
  `MANUTENCAO INTERNA` (normalizado), fonte automática exclusiva = Rel. Seriais Com Saldo.
  Ordenação: prioridade manual → maior score → maior margem → maior idade → menor id.
  1ª passagem kits completos (atômico), 2ª passagem parciais com sobras virtuais.
  Motor real (`engine-orchestrator.ts` = loader `engine-loader.ts` + persistência
  transacional) e simulador (`simulate-service.ts`) usam a MESMA função — testado.
  **Nunca** cria reservas/movimentações/pedidos — apenas sinaliza; a reserva real é a
  separação manual. Resultado por caso persistido em `repair_match_case_results`
  (motivos JSON, pontos decimais, rank, regra/versão). Motor legado id_pedido
  (`match_runs`/`match_results`/`decision_rules`) foi aposentado — tabelas mantidas como
  histórico, código removido.

## 4. Arquitetura atual

**Stack:** Node.js 22.5+ (ambiente atual: Node 24 LTS), TypeScript estrito, React 18 + Vite 6,
Express 4, `node:sqlite` (carregado via `createRequire` para compatibilidade com
Vite/Vitest), Zod, `xlsx` 0.18.5, Vitest 2. Um único `package.json`/repositório.

```
src/
  client/      React + Vite — App.tsx, auth.tsx,
               pages/{Importar,Diagnostico,Pedidos,Estoque,Movimentacoes,Cotacoes,Bipagem,
                      Compras,Match,Separacao,Analise,Login,Setup,
                      AdminUsuarios,AdminTecnicos,AdminDatasys}.tsx
  server/      Express — config.ts, app.ts, index.ts,
               middleware/auth-middleware.ts,
               routes/{import,data,counting,procurement,match,separation,
                       auth,staff,repair,datasys}-routes.ts
  shared/      types.ts — tipos compartilhados client/server (sem dependências)
  domain/      text.ts, status.ts, scoring.ts, reference-catalog.ts, procurement.ts
  db/          database.ts, migrate.ts, migrations/*.sql, repository.ts, queries.ts,
               counting-repository.ts, counting-queries.ts
  import/      xlsx-reader.ts, value.ts, columns.ts, table-detection.ts, mappers.ts, import-service.ts
  counting/    counting-service.ts
  system/      system-service.ts
  operational/ stock-service.ts, procurement-service.ts, receiving-service.ts
  match/       calculate-match.ts (função pura ÚNICA), engine-loader.ts,
               engine-orchestrator.ts (persistência), simulate-service.ts (dry-run),
               match-rule-service.ts (CRUD/ativação), next-action-service.ts,
               priority-backfill-service.ts
  auth/        auth-service.ts — PIN hashing (scryptSync), sessões, usuários, roles
  audit/       audit-service.ts — logAudit (silencioso), getAuditLog
  staff/       staff-service.ts — técnicos (TECHNICIAN, activate/deactivate)
  repair/      repair-service.ts — repair_cases, part_requests, prioridades manuais
  datasys/     datasys-service.ts — preview/confirm de RELATORIO.xlsx, search por IMEI/OS
scripts/    audit-real.ts, migrate-repair-domain.ts (migração idempotente legado→repair_cases)
tests/      domain, import-mapping, import-service, fatal-issues, migration-guard,
            staged-detection, server-config, audit-real, counting-service, counting-integration,
            counting-baseline, system-initialization, procurement, match-engine, match-service,
            match-integration, separation, auth, staff, repair-domain, datasys (+ helpers, global-setup)
docs/       modelo-dados.md, importacao-legado.md, regras-negocio.md, REAL_DATA_AUDIT.md
            (gerado), PROJECT_CONTEXT.md (este arquivo)
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
- `GET/POST /api/match-rules`, `PATCH /api/match-rules/:id`,
  `POST /api/match-rules/:id/activate` (transacional + recálculo),
  `POST /api/match-rules/simulate` (dry-run, mesma função do motor),
  `GET /api/engine/state`, `POST /api/engine/run`.
- `GET/POST/DELETE /api/part-key-aliases` (compatibilidade manual; muta → recálculo).
- `PATCH /api/fila-reparos/:id/{deposito,score,info}` — correções de VERIFICAR com
  auditoria (valor anterior + usuário) e retorno automático ao motor.
- (aposentados em 2026-07-16: `/api/match-runs/*`, `/api/decision-rules/active`,
  `/api/separation-batches/*` — motor legado id_pedido e separação antiga.)
- `GET /api/repair-cases/chave-peca-search?q=&limit=` — autocomplete CHAVEPECA (union de `part_requests` + `source_order_parts`, com `stockAvailable` do último snapshot OFFICIAL).
- `GET /api/repair-cases/search?imei=&os=&repairDate=` — busca por caso (IMEI/OS/data).
- `POST /api/repair-cases/save-analysis` — criar/atualizar caso + peças em transação única.
- `DELETE /api/datasys/import/:id` — cancelar preview datasys.
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
- **Auth, staff, repair domain, Datasys e macrofase 1 completa** (migrations 010–012): autenticação PIN scryptSync, sessões cookie HttpOnly, roles ADMIN/OPERATOR, proteção do último admin, rate-limit de login (10/15 min); técnicos CRUD; log de auditoria silencioso; `repair_cases`/`part_requests`/prioridades; identidade temporal (`repair_date`, `repair_date_source`, `legacy_case_key`, migration 012, índice único parcial); intake Datasys seguro (staged_file_path server-side, validação path traversal, cancelamento via `cancelled_at`, sem filePath do cliente); `GET /api/repair-cases/chave-peca-search?q=` (autocomplete CHAVEPECA com estoque); `GET /api/repair-cases/search`, `POST /api/repair-cases/save-analysis` (transacional); sidebar sem item duplicado `/match`; script `migrate:repair-domain` idempotente aplicado ao DB operacional (1108 casos criados, 1387 peças, identidade IMEI+OS+data, nunca RESERVADA). `SERVER_HOST` padrão `0.0.0.0`.
- Tudo testado: **373 testes** (ver §8), incluindo separação (57), auth (15+5 rate-limit), repair-domain (42+5 chavepeca), datasys (12+8 staged), migration-domain (28).

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

- **373 testes** (Vitest), todos passando, em 25 arquivos: `domain.test.ts` (11),
  `import-mapping.test.ts` (12), `import-service.test.ts` (8), `fatal-issues.test.ts` (8),
  `migration-guard.test.ts` (2), `staged-detection.test.ts` (7), `server-config.test.ts` (1),
  `audit-real.test.ts` (1), `counting-service.test.ts` (38), `counting-integration.test.ts` (1),
  `system-initialization.test.ts` (7), `procurement.test.ts` (17), `counting-baseline.test.ts`
  (6), `match-engine.test.ts` (29), `match-service.test.ts` (20), `match-integration.test.ts`
  (25), `separation.test.ts` (57), `auth.test.ts` (10), `staff.test.ts` (6),
  `repair-domain.test.ts` (42 incl. searchChavePeca+saveAnalysis+searchRepairCases),
  `repair-domain-migration.test.ts` (28: mapLegacyPartStatus+deriveWorkflow+groupRows+schema),
  `datasys.test.ts` (12), `datasys-staged.test.ts` (8),
  `auth-ratelimit.test.ts` (9: last-admin+rate-limit)
  — mais `helpers.ts`/`global-setup.ts`.
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
- Com a autenticação implantada, `SERVER_HOST` passa a ter padrão `0.0.0.0` (rede local). O
  cookie usa `secure: false` porque o beta corre em HTTP local — mudar para `true` exige HTTPS.
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

**Bloqueadores:** nenhum conhecido. 660 testes + typecheck + build limpos (working tree ainda
não commitado — ver item 1 abaixo).

**Últimas mudanças relevantes (mais recentes primeiro, máx. 5):**
1. **Revisão automatizada da Central de Problemas (issues #11–#15)** (2026-07-22, tarefa
   agendada `revisar-erros`): (a) confirmado que o deploy pendente do item anterior **já
   aconteceu** — `data/app-beta.sqlite` está em `057_purchase_decision_snapshots.sql`, o log
   do PM2 mostra boot em produção às 2026-07-21 17:53:51Z (poucos segundos após o build de
   `cotacao-service.js`), ou seja os fixes de #11/#12/#13 já estavam ao vivo antes desta
   revisão — a nota "pendente restart" abaixo ficou desatualizada, corrigida aqui. (b) issue
   #15 ("motor de projeção não funciona, fica vazio"): investigado e reproduzido com dados
   reais do beta — `projectCotacaoImpact` (`src/match/cotacao-projection-service.ts`) funciona
   corretamente (ex.: 7→60 MATCH completos testando as 5 peças mais necessárias). Causa raiz
   provável: a rota foi commitada às 13:14 de 21/07 mas só publicada (build+restart) às
   14:53 — o usuário relatou o problema às 13:58, quando o servidor ainda rodava a versão sem
   essa rota (falha silenciosa no frontend, sem mensagem de erro). Sem código novo; marcada
   `AWAITING_TEST`. (c) issue #14 ("mostrar último registro da OS do IMEI no card"):
   implementado `getLatestOsByImeis` (`src/datasys/datasys-service.ts`) — fallback que busca o
   último OS conhecido no Datasys pelo IMEI quando `repair_cases.os` está vazio (~500/1325
   casos ativos, sobretudo aparelhos de lote sem OS individual no import legado); usado em
   `GET /api/fila-reparos` e `.../minha-fila`, exibido em `FilaReparos.tsx`/`TecnicoFila.tsx`
   como "Último OS (Datasys)" sem nunca sobrescrever `os`. Nota: `datasys_records` está vazio
   no beta hoje (nenhuma importação Datasys confirmada ainda) — o fallback só vai aparecer
   depois da primeira importação confirmada. Testado (2 testes novos); **buildado mas ainda
   NÃO publicado** (precisa de novo `npm run build` + restart do PM2 `sistema-pecas-beta`) —
   marcada `IN_ANALYSIS`, não `AWAITING_TEST`. (d) Status atualizados diretamente via
   `updateIssue` (mesma função usada pela rota `PATCH /api/issue-reports`): #11/#12/#13/#15 →
   `AWAITING_TEST` (correção ao vivo, aguardando validação de uso real); #14 →
   `IN_ANALYSIS` (correção pronta, aguardando publicação). **Pendente:** todo o trabalho de
   código desta revisão e da revisão anterior (2026-07-21) segue **não commitado** no git —
   revisão automatizada não commita por padrão; revisar e commitar quando conveniente.
   Restart do PM2 para publicar o fix de #14 também não foi feito automaticamente (serviço
   compartilhado, possivelmente em uso).
2. **Revisão dos 3 problemas abertos na Central de Problemas** (2026-07-21, migration 056):
   (a) `GET /api/dashboards/technician/:id/cases` selecionava a coluna inexistente
   `os_number` em `repair_cases` (a coluna real é `os`) — o endpoint quebrava com 500 e o
   modal "Aparelhos — {técnico}" ficava só com o cabeçalho, vazio; query movida para
   `getTechnicianCaseDetails` em `src/dashboard/dashboard-overview-service.ts` com o alias
   corrigido (`os AS os_number`), testada. (b) **Bug pré-existente descoberto durante a
   revisão, não reportado ainda**: `issue_reports.status` manteve o `CHECK` original da
   migration 041 (`OPEN/IN_ANALYSIS/RESOLVED/DISMISSED`) mesmo depois da 055 introduzir o
   status `AWAITING_TEST` — qualquer tentativa de marcar um problema como "correção
   aplicada, aguardando validação" falhava com `CHECK constraint failed`. Migration 056
   reconstrói `issue_reports` (mesma estratégia de 016/030) com o CHECK expandido; testado.
   (c) Export/import de cotação (`/compras`, aba Necessidades) trocado de CSV
   separado-por-vírgula (abria errado no Excel em locale pt-BR, exigindo conversão manual
   antes de reenviar ao fornecedor) para `.xlsx` real via `xlsx` — `GET
   /api/necessidades/export.xlsx` gera o template, `POST /api/cotacoes/parse` (multer +
   `parseCotacaoXlsx`) lê o arquivo preenchido; `cotacao-service.ts` ganhou
   `buildNecessidadesXlsx`/`parseCotacaoXlsx`. (d) Coluna "Aparelhos" em Necessidades
   passou a mostrar separadamente `fullMatchCount` (aparelhos que fecham MATCH completo
   comprando só aquela peça) do total bloqueado (`casesBlocked`, mostrado como contexto
   secundário X/Y) — antes só mostrava o total bloqueado, incluindo casos que ainda
   precisam de outras peças pendentes. (Confirmado na revisão de 2026-07-22 acima: a
   migration 056 foi aplicada e o PM2 foi de fato reiniciado ainda em 2026-07-21 — a nota de
   pendência original ficou desatualizada.)
3. **Correção de regressões deixadas pela sessão de UI/VENDA_ESTADO do dia 2026-07-20** (sem migration nova): os commits da manhã (`78f5e00`, `84269d4`, `2eed25e`) quebraram 16 testes que não tinham sido revalidados. (a) `engine-orchestrator.ts`: a rotina que preenche 10 vagas de `VENDA_ESTADO` com os piores pontuadores podia varrer casos que **acabaram de virar `MATCH`/`MATCH_PARCIAL` no mesmo run** — corrigido excluindo `result_status IN ('MATCH','MATCH_PARCIAL')` da consulta de candidatos. (b) `repair-service.ts::createRepairCase`: migration 050 (índice único parcial `idx_repair_cases_active_imei`) não tinha guarda de aplicação — violação virava erro cru do SQLite; adicionado check prévio que lança `RepairError("DUPLICATE_ACTIVE_IMEI", ...)` amigável (já tratado por `handleRepairError` nas rotas). (c) Testes desatualizados ajustados: `tests/repair-domain.test.ts` assumia múltiplos casos ativos por IMEI (regra antiga, pré-050) — reescritos para refletir "1 caso ativo por IMEI, reabertura permitida após encerramento"; `tests/match-engine-integration.test.ts` e `tests/receipt-motor.test.ts` ganharam `seedFillerCases()` (10 casos já em `VENDA_ESTADO`) para não deixar o caso sob teste ser o único elegível e virar vaga de liquidação em bancos pequenos. Trabalho de UI (`repaginação`, dashboards, migration 053 `venda_estado_count`) já estava presente e correto — não precisou de mudança, só ficou destravado pelos testes.
4. **Home operacional / Central Operacional** (2026-07-17, migration 041): página `/admin/dashboards` refatorada em componentes (`src/client/components/dashboard/`); novos serviços `src/dashboard/` (snapshot, overview, alertas, contagens) e `src/issue/` (central de problemas). Migration 041 cria `dashboard_daily_snapshots` (UPSERT idempotente por `snapshot_date`, fuso SP) e `issue_reports` (módulo/severidade/status). Endpoints: `GET /api/dashboards/home` (cards + comparação + panorama + técnicos + contagens + alertas + problemas; snapshot do dia atualizado a cada acesso), `GET /api/dashboards/timeline` (série histórica por métrica), `POST /api/dashboards/snapshots/recalculate` (ADMIN), `GET/POST/PATCH /api/issue-reports`. Gráfico SVG nativo (sem dependência extra), 9 cards clicáveis com delta vs snapshot anterior, 8 alertas operacionais, modal de criação de problema. Nenhum módulo operacional alterado.
5. **Consolidação do motor único de match** (2026-07-16, migration 038): função pura
   `calculateMatch` é a ÚNICA implementação (motor real, simulador, testes) — sem
   arredondamento (score decimal exato), elegibilidade com motivos de VERIFICAR
   persistidos em `repair_match_case_results`, gate de depósito (só AGUARDANDO PECA/
   MANUTENCAO INTERNA; fonte automática = Rel. Seriais Com Saldo), ordenação
   score→margem→idade→id (prioridade manual antes), kits atômicos + parciais com sobras.
   Regras: `match_rule_sets` ganhou `name`; ativação transacional; 0 ou >1 ativas aborta o
   motor sem tocar cards. Aposentados: motor legado id_pedido (match-engine/service/
   repository/fingerprint/match-routes, tela `/match`), separação antiga (0 itens),
   `domain/scoring.ts`, `decision_rules` (tabela mantida, código desconectado). Novos:
   `PATCH /fila-reparos/:id/score` (corrigir custo/venda/idade, auditado + recálculo),
   depósito manual auditado com valor anterior, UI de compatibilidades em
   `/estoque/referencias` (part_key_aliases), drawer com motivos/score decomposto/regra.
   Validação na cópia do beta: `docs/MATCH_BETA_VALIDATION.md`
   (713 avaliados → MATCH 11, PARCIAL 24, VERIFICAR 106; idempotente; simulação=motor).
   Backup pré-mudança: `data/backups/app-beta-pre-match-consolidation-2026-07-16T12-20-17.sqlite`.
