-- Migration 009 — separação operacional de alocações do match.
--
-- FLUXO: match (recomendação) → reserva lógica → lote de separação
--        → confirmação física → REPAIR_CONSUMPTION → PART_SEPARATED → SEPARADO
--
-- Reserva não altera estoque físico. Estoque disponível = físico − reservado.
-- Confirmação reduz físico, libera reserva, cria movement + operational_event.
-- Cancelamento libera reserva; não cria movement nem event.

-- =========================================================================
-- separation_batches — lote de separação (agrupa itens a separar fisicamente)
-- =========================================================================
CREATE TABLE separation_batches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_number      TEXT    NOT NULL UNIQUE,           -- SEP-AAAAMMDD-NNNN
  match_run_id      INTEGER NOT NULL REFERENCES match_runs(id) ON DELETE RESTRICT,
  status            TEXT    NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','PARTIALLY_COMPLETED','COMPLETED','CANCELLED')),
  idempotency_key   TEXT    NOT NULL UNIQUE,
  created_by        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  notes             TEXT,
  completed_at      TEXT,
  completed_by      TEXT,
  cancelled_at      TEXT,
  cancelled_by      TEXT,
  cancel_reason     TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sep_batches_status     ON separation_batches(status);
CREATE INDEX idx_sep_batches_match_run  ON separation_batches(match_run_id);
CREATE INDEX idx_sep_batches_created_at ON separation_batches(created_at);

-- =========================================================================
-- separation_items — uma linha por solicitação (id_pedido) reservada
-- =========================================================================
CREATE TABLE separation_items (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  separation_batch_id         INTEGER NOT NULL REFERENCES separation_batches(id) ON DELETE RESTRICT,
  match_run_id                INTEGER NOT NULL REFERENCES match_runs(id) ON DELETE RESTRICT,
  match_result_id             INTEGER NOT NULL REFERENCES match_results(id) ON DELETE RESTRICT,
  match_device_result_id      INTEGER REFERENCES match_device_results(id) ON DELETE SET NULL,
  source_order_part_id        INTEGER NOT NULL REFERENCES source_order_parts(id) ON DELETE RESTRICT,

  -- Identidades do domínio (desnormalizadas para rastreabilidade)
  id_pedido                   TEXT    NOT NULL,
  imei                        TEXT,
  os                          TEXT,

  -- Peça
  description                 TEXT,
  chave_peca                  TEXT,
  chave_peca_norm             TEXT,
  reference                   TEXT,
  reference_norm              TEXT,
  quantity                    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),

  -- Contexto do match
  match_result_status         TEXT,   -- MATCH | MATCH PARCIAL
  match_allocation_phase      TEXT,   -- FULL | PARTIAL
  match_consumption_order     INTEGER,

  -- Status do item de separação
  status                      TEXT    NOT NULL DEFAULT 'RESERVED'
                                CHECK (status IN ('RESERVED','CONFIRMED','CANCELLED')),
  reserved_at                 TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Confirmação física
  confirmed_at                TEXT,
  confirmed_by                TEXT,
  confirmation_notes          TEXT,
  confirmation_idempotency_key TEXT,

  -- Cancelamento
  cancelled_at                TEXT,
  cancelled_by                TEXT,
  cancel_reason               TEXT,

  -- Vínculos com movimento e evento (preenchidos só na confirmação)
  stock_movement_id           INTEGER REFERENCES stock_movements(id) ON DELETE RESTRICT,
  operational_event_id        INTEGER REFERENCES operational_events(id) ON DELETE RESTRICT,

  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),

  -- match_result_id e match_run_id devem ser consistentes
  CHECK (match_run_id IS NOT NULL),
  CHECK (id_pedido IS NOT NULL AND id_pedido != ''),
  CHECK (quantity = 1)   -- nesta fase cada item = 1 unidade
);

-- Impede que o mesmo match_result participe de mais de uma separação ativa/confirmada.
CREATE UNIQUE INDEX idx_sep_items_result_active
  ON separation_items(match_result_id)
  WHERE status IN ('RESERVED', 'CONFIRMED');

-- Impede que o mesmo ID_PEDIDO participe de mais de uma separação ativa/confirmada.
CREATE UNIQUE INDEX idx_sep_items_pedido_active
  ON separation_items(id_pedido)
  WHERE status IN ('RESERVED', 'CONFIRMED');

CREATE INDEX idx_sep_items_batch       ON separation_items(separation_batch_id);
CREATE INDEX idx_sep_items_match_run   ON separation_items(match_run_id);
CREATE INDEX idx_sep_items_result      ON separation_items(match_result_id);
CREATE INDEX idx_sep_items_device      ON separation_items(match_device_result_id);
CREATE INDEX idx_sep_items_pedido      ON separation_items(id_pedido);
CREATE INDEX idx_sep_items_imei        ON separation_items(imei);
CREATE INDEX idx_sep_items_status      ON separation_items(status);
CREATE INDEX idx_sep_items_ref         ON separation_items(reference_norm, chave_peca_norm);

-- =========================================================================
-- operational_events — adicionar colunas de rastreabilidade de separação.
-- Armazenadas como JSON em metadata_json (coluna nova) para não quebrar
-- constraints existentes. IDs chave gravados também como colunas diretas.
-- =========================================================================
ALTER TABLE operational_events ADD COLUMN separation_batch_id  INTEGER REFERENCES separation_batches(id) ON DELETE SET NULL;
ALTER TABLE operational_events ADD COLUMN separation_item_id   INTEGER REFERENCES separation_items(id)   ON DELETE SET NULL;
ALTER TABLE operational_events ADD COLUMN match_run_id         INTEGER REFERENCES match_runs(id)          ON DELETE SET NULL;
ALTER TABLE operational_events ADD COLUMN match_result_id      INTEGER REFERENCES match_results(id)       ON DELETE SET NULL;
ALTER TABLE operational_events ADD COLUMN stock_movement_id    INTEGER REFERENCES stock_movements(id)     ON DELETE SET NULL;

-- =========================================================================
-- stock_movements — adicionar coluna source_item_id para separação.
-- Já existe source_type + source_id; source_item_id guarda a FK interna
-- específica (separation_items.id) para constraint de unicidade adicional.
-- =========================================================================
ALTER TABLE stock_movements ADD COLUMN source_item_id INTEGER;
