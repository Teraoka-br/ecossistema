-- Migration 006 — solicitações de compra, pedidos de compra, recebimento e
-- livro-razão de movimentações de estoque (stock_movements). Também congela a
-- base de cada sessão de contagem e marca, em cada snapshot, qual o maior id de
-- movimentação já absorvido (corte determinístico do estoque operacional).
--
-- ESTOQUE OPERACIONAL = BASE OFICIAL + MOVIMENTAÇÕES POSTERIORES À BASE.
--   - base = último stock_snapshot OFFICIAL; na ausência dele, o estoque inicial
--     importado (source_inventory_items do lote inicial).
--   - "posteriores à base" usa o id da movimentação (ordenação global exata),
--     não timestamps — evita empates de mesmo segundo e dupla contagem.

-- =========================================================================
-- purchase_requests — solicitações de compra APROVADAS.
-- Inicializadas a partir de source_quotations aprovadas (status APROVADO/APROVADA).
-- Uma solicitação por cotação de origem (UNIQUE source_quotation_id) — sem duplicar.
-- =========================================================================
CREATE TABLE purchase_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_quotation_id INTEGER UNIQUE REFERENCES source_quotations(id) ON DELETE SET NULL,
  import_batch_id     INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  id_pedido           TEXT,
  chave_peca          TEXT,
  chave_peca_norm     TEXT,
  referencia          TEXT,
  referencia_norm     TEXT,
  quantidade          REAL,
  valor_unitario      REAL,
  valor_total         REAL,
  origin_status       TEXT,           -- status normalizado de origem (ex.: APROVADO)
  status              TEXT NOT NULL DEFAULT 'APPROVED'
                        CHECK (status IN ('APPROVED','ORDERED','CANCELLED')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_purchase_requests_status ON purchase_requests(status);
CREATE INDEX idx_purchase_requests_chave ON purchase_requests(chave_peca_norm);

-- =========================================================================
-- purchase_orders — pedidos de compra (PC-AAAAMMDD-NNNN).
-- =========================================================================
CREATE TABLE purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number  TEXT NOT NULL UNIQUE,
  supplier      TEXT,
  status        TEXT NOT NULL DEFAULT 'AWAITING_RECEIPT'
                  CHECK (status IN ('AWAITING_RECEIPT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT,
  received_at   TEXT,
  cancelled_at  TEXT,
  cancelled_by  TEXT,
  cancel_reason TEXT
);

CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);

-- =========================================================================
-- purchase_order_items — itens de um pedido de compra.
-- =========================================================================
CREATE TABLE purchase_order_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id   INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  purchase_request_id INTEGER REFERENCES purchase_requests(id) ON DELETE SET NULL,
  referencia          TEXT NOT NULL,
  referencia_norm     TEXT NOT NULL,
  chave_peca          TEXT,
  chave_peca_norm     TEXT,
  quantity_ordered    INTEGER NOT NULL CHECK (quantity_ordered > 0),
  quantity_received   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_po_items_order ON purchase_order_items(purchase_order_id);

-- =========================================================================
-- goods_receipts — recebimentos (parciais permitidos) contra um pedido.
-- =========================================================================
CREATE TABLE goods_receipts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_by       TEXT NOT NULL,
  allow_over_receipt INTEGER NOT NULL DEFAULT 0,
  justification     TEXT,             -- obrigatória (>=10 chars) quando há recebimento acima do pedido
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_goods_receipts_order ON goods_receipts(purchase_order_id);

-- =========================================================================
-- goods_receipt_items — itens recebidos em cada recebimento.
-- =========================================================================
CREATE TABLE goods_receipt_items (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  goods_receipt_id       INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  purchase_order_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  referencia             TEXT NOT NULL,
  referencia_norm        TEXT NOT NULL,
  chave_peca             TEXT,
  chave_peca_norm        TEXT,
  quantity_received      INTEGER NOT NULL CHECK (quantity_received > 0),
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gr_items_receipt ON goods_receipt_items(goods_receipt_id);

-- =========================================================================
-- stock_movements — livro-razão de movimentações de estoque.
-- Tipos preparados; nesta fase só PURCHASE_RECEIPT é gravado.
-- quantity > 0 = entrada; < 0 = saída (saídas chegam em fases futuras).
-- Idempotência: um movimento por (source_type, source_id).
-- =========================================================================
CREATE TABLE stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_type   TEXT NOT NULL
                    CHECK (movement_type IN
                      ('PURCHASE_RECEIPT','REPAIR_CONSUMPTION','RETURN','MANUAL_ADJUSTMENT','DISCARD','TRANSFER')),
  referencia      TEXT NOT NULL,
  referencia_norm TEXT NOT NULL,
  chave_peca      TEXT,
  chave_peca_norm TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity <> 0),
  source_type     TEXT,             -- ex.: GOODS_RECEIPT_ITEM
  source_id       INTEGER,
  effective_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT,
  notes           TEXT,
  reversed_at     TEXT,
  reversed_by     TEXT
);

CREATE INDEX idx_stock_movements_ref ON stock_movements(referencia_norm, chave_peca_norm);
CREATE INDEX idx_stock_movements_type ON stock_movements(movement_type);
-- Um movimento por origem (evita movimentações duplicadas no recebimento).
CREATE UNIQUE INDEX idx_stock_movements_source
  ON stock_movements(source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

-- =========================================================================
-- Corte determinístico do snapshot: maior id de movimentação já absorvido pela
-- contagem física no momento da finalização. Estoque operacional considera só
-- movimentações com id > este valor. Snapshots antigos ficam com 0 (todas as
-- movimentações posteriores entram — comportamento idêntico ao anterior, já
-- que não havia movimentações).
-- =========================================================================
ALTER TABLE stock_snapshots ADD COLUMN baseline_movement_id_max INTEGER NOT NULL DEFAULT 0;

-- =========================================================================
-- Base congelada da sessão de contagem (Etapa 6): tipo, snapshot de origem,
-- corte (id de movimentação no início) e total de unidades da base.
-- =========================================================================
ALTER TABLE count_sessions ADD COLUMN baseline_type TEXT;            -- INITIAL_IMPORT | OFFICIAL_SNAPSHOT
ALTER TABLE count_sessions ADD COLUMN baseline_snapshot_id INTEGER;  -- snapshot de origem (se houver)
ALTER TABLE count_sessions ADD COLUMN baseline_cutoff_movement_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE count_sessions ADD COLUMN baseline_total_units INTEGER NOT NULL DEFAULT 0;
