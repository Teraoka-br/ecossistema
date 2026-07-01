# Modelo de dados

Banco **SQLite** (`data/app.sqlite`) acessado via `node:sqlite`. Migrations versionadas em
`src/db/migrations` (aplicadas no boot e por `npm run migrate`). Antes de aplicar migrations,
o runner faz backup de `data/app.sqlite` em `data/backups/`.

## Princípios

- **Snapshot por importação**: cada importação confirmada cria um `import_batch` e grava as
  fontes (`source_*`) vinculadas a ele. O "lote ativo" é o último concluído.
- **Identidade por chave de negócio, nunca pelo número da linha.**
  - Linha de pedido: `ID_PEDIDO` é a identidade única da solicitação de uma peça (uma
    linha = um `ID_PEDIDO`, sempre). O **IMEI** identifica o aparelho/kit; várias linhas
    com o mesmo IMEI são várias peças do mesmo aparelho, não duplicidade.
  - Estoque: o foco é a **contagem por referência**; cada linha é uma unidade física.
- **Dados operacionais nunca são apagados por reimportação** (`operational_events`,
  `count_sessions`, `count_scans`, `reference_mappings`, `stock_snapshots`, `match_*` ficam
  fora do snapshot de importação).
- **Bipagem: cada beep é um fato imutável.** `count_scans` nunca tem linha apagada nem o
  `mapping_status` original reescrito; cancelamento só marca `cancelled_at/by/reason`.
  Resolução manual de referência (`reference_mappings`) é recalculada *ao vivo* a cada
  consulta (pendências, resumo, finalização) — nunca por mutação retroativa dos scans.
- **Estoque oficial = último `stock_snapshots` com status `OFFICIAL`**, não
  `source_inventory_items`. Antes da 1ª contagem finalizada, a visão é o legado importado.
- **A importação Excel só inicializa o sistema** (`system_state`). A primeira importação
  confirmada fixa o lote inicial e cria as `purchase_requests` aprovadas; depois disso, novas
  importações são bloqueadas — `source_*` seguem só como fotografia imutável da carga inicial.
- **Estoque operacional = base oficial + movimentações posteriores ao corte** (por id de
  `stock_movements`, nunca por timestamp — evita dupla contagem). Ver
  `getCurrentOperationalStock()` em `src/operational/stock-service.ts`.

## Tabelas

### `import_batches`
Cabeçalho de cada importação. Campos: arquivos e **hashes** (idempotência), `status`
(`PREVIEW`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED`), datas e contagens
(encontrados/importados por entidade), `warnings_count`, `errors_count`, `conflicts_count`
(independente — conflitos entre fontes não são erros).

### `import_issues`
Ocorrências da importação: `severity` (`ERROR`/`WARNING`/`CONFLICT`), `code`, `message`,
arquivo/aba/linha, `entity_type`, `entity_key`, `raw_value`. Alimenta o Diagnóstico. Um
subconjunto dos códigos é **estrutural fatal** (bloqueia a confirmação, HTTP 422) — ver
[regras-negocio.md](regras-negocio.md).

### `source_order_parts` (uma linha por peça solicitada)
Pedidos vindos de `PEDIDOS.xlsx`. `id_pedido` é a identidade da linha — **única por
snapshot** (`UNIQUE(import_batch_id, id_pedido)`); um `id_pedido` repetido é rejeitado como
erro (`DUPLICATE_ID_PEDIDO`). O agrupamento por aparelho é feito pelo `imei` na camada de
consulta (`groupByDevice`), não pela identidade da linha. Guarda os valores **legados** das
planilhas (`status_atual_legado`, `score_legado`, `ordem_consumo_legada`,
`quantidade_estoque_legada`, etc.), além de `chave_peca` (original) e `chave_peca_norm`
(normalizada — usada apenas para casamento/match futuro, não para identidade). `raw_json`
preserva a linha inteira.

### `source_inventory_items` (uma linha por unidade física)
Estoque vindo da aba `BIPAGEM DE PEÇAS`. `id_peca_estoque` é preenchido **apenas se** existir
coluna de ID na origem (não existe nos arquivos atuais). `referencia_norm`/`chave_peca_norm`
suportam a contagem agrupada. `snapshot_row` é só auditoria do snapshot — não é identidade.

### `source_quotations`
Cotações da aba `PEÇAS A PEDIR` (`id_pedido`, `chave_peca`, `quantidade`, `valor_unitario`,
`valor_total`, `data_cotacao`, `status`).

### `source_order_analysis`
Origem analítica de `ANALISE MI.xlsx` (marca, modelo, cor, peça solicitada, solicitante,
depósito, ref...). Enriquece o pedido sem sobrescrever a fonte operacional.

### `operational_events` *(preparada)*
Histórico de ações (conclusão, separação, alocação...). A importação **não** cria eventos
falsos para status herdados.

### `count_sessions` (implementada — migration 004)
Uma sessão de contagem física. Vinculada ao `import_batch_id` ativo no momento da criação
(esse lote é o catálogo de referências da sessão). No máximo **uma sessão `OPEN`** no sistema
inteiro — garantido por índice único parcial (`WHERE status = 'OPEN'`), não só por lógica de
aplicação. `status`: `OPEN` → `FINALIZED` ou `CANCELLED` (transições finais, sem volta).
Campos de auditoria de finalização/cancelamento (`finalized_by`, `cancelled_at/by/reason`).

### `count_scans` (implementada — migration 004)
Uma linha por beep — **nunca deduplicada, nunca apagada**. `mapping_status`
(`RECOGNIZED`/`UNKNOWN_REFERENCE`/`MISSING_KEY`/`CONFLICT`) é o que foi detectado **no momento
do beep**, contra o catálogo do lote da sessão; fica congelado mesmo que um mapeamento manual
resolva a referência depois (a resolução é recalculada ao vivo nas consultas, não reescrita
aqui). Cancelamento só preenche `cancelled_at/by/reason` (idempotente).

### `reference_mappings` (implementada — migration 004)
Correções manuais de referência → `CHAVEPECA`, feitas pelo operador durante a contagem.
`reference_norm` é único apenas entre mapeamentos **ativos** (índice único parcial); ativar um
novo mapeamento para a mesma referência substitui (UPDATE) o ativo anterior, em vez de violar
a unicidade. Não pertencem a nenhum `import_batch` — não são apagados por reimportação.

### `stock_snapshots`, `stock_snapshot_items` (implementadas — migration 004)
Resultado da finalização de uma sessão: um `stock_snapshot` por sessão finalizada (único por
`count_session_id`), status sempre `OFFICIAL`; `stock_snapshot_items` é o consolidado por
`(referencia_norm, chave_peca_norm)` apenas dos scans **ativos e efetivamente reconhecidos**
no momento da finalização. **Estoque oficial = o `stock_snapshot` `OFFICIAL` mais recente entre
todas as sessões.**

### `match_runs`, `match_results` *(preparadas, vazias — próxima fase)*
Resultado do motor de match/distribuição da próxima fase.

### `system_state` (implementada — migration 005)
Linha única global. `initialized`/`initial_import_batch_id`/`initialized_at`/`initialized_by`
marcam se e quando o sistema foi inicializado pela primeira importação confirmada. Depois de
`initialized=1`, novas importações são bloqueadas (salvo `ALLOW_LEGACY_REIMPORT=true`, só
dev/teste).

### `purchase_requests` (implementada — migration 006)
Solicitações de compra aprovadas. Inicializadas a partir de `source_quotations` com status
normalizado `APROVADO`/`APROVADA` (`UNIQUE(source_quotation_id)` — nunca duplica); depois da
inicialização, também recebem solicitações criadas via fluxo operacional. `status`:
`APPROVED` → `ORDERED` → `CANCELLED`.

### `purchase_orders`, `purchase_order_items` (implementadas — migration 006)
Pedido de compra (`order_number` no formato `PC-AAAAMMDD-NNNN`, gerado transacionalmente) e
seus itens, com `quantity_ordered`/`quantity_received` por item. `status` do pedido:
`AWAITING_RECEIPT` → `PARTIALLY_RECEIVED` → `RECEIVED`, ou `CANCELLED` em qualquer ponto antes
de `RECEIVED`. Pedidos nunca são excluídos.

### `goods_receipts`, `goods_receipt_items` (implementadas — migration 006)
Recebimentos confirmados contra um pedido (parciais permitidos). `allow_over_receipt`/
`justification` registram quando o recebimento excedeu o saldo pedido (exige responsável +
justificativa ≥10 caracteres).

### `stock_movements` (implementada — migration 006)
Livro-razão append-only de movimentações de estoque. `movement_type` aceita
`PURCHASE_RECEIPT` (única gravada nesta fase) e os tipos preparados
`REPAIR_CONSUMPTION`/`RETURN`/`MANUAL_ADJUSTMENT`/`DISCARD`/`TRANSFER` (sem fluxo ainda).
`UNIQUE(source_type, source_id)` garante que confirmar o mesmo recebimento de novo nunca
duplica a movimentação. `stock_snapshots.baseline_movement_id_max` e os campos
`count_sessions.baseline_*` (tipo, snapshot de origem, corte, total) usam o `id` desta tabela
como corte determinístico do estoque operacional — nunca timestamps.

### `decision_rules`
Regras de decisão **configuráveis** (margem/idade → score). Já vem com a política padrão ativa
(30 dias/ponto, teto 15; R$150/ponto; margem negativa pune). Veja
[regras-negocio.md](regras-negocio.md).

### `schema_migrations`
Controle interno das migrations aplicadas.
