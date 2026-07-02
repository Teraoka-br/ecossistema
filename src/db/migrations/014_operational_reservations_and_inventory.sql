-- Migration 014 — reservas operacionais por part_request.
--
-- operational_reservations: reserva física associada a um part_request.
-- Uma reserva ATIVA por part_request (índice único parcial).
-- Estoque disponível = físico − reservado (via operational_reservations ACTIVE).
-- Consumo (REPAIR_CONSUMPTION) move status para CONSUMED e diminui o físico.
--
-- Também adiciona tipos de movimentação ao CHECK de stock_movements
-- e colunas de rastreabilidade de reserva.

-- =========================================================================
-- operational_reservations
-- =========================================================================
CREATE TABLE operational_reservations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  part_request_id       INTEGER NOT NULL REFERENCES part_requests(id) ON DELETE RESTRICT,
  repair_case_id        INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE RESTRICT,
  chave_peca            TEXT    NOT NULL,
  chave_peca_norm       TEXT    NOT NULL,
  reference             TEXT,
  reference_norm        TEXT,
  quantity              INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status                TEXT    NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
  -- Motivo de cancelamento (para RELEASED)
  cancel_reason         TEXT,
  cancel_reason_code    TEXT,
  -- Auditoria
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  released_at           TEXT,
  released_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  consumed_at           TEXT,
  consumed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Vínculo com o movimento de consumo (quando CONSUMED)
  stock_movement_id     INTEGER REFERENCES stock_movements(id) ON DELETE RESTRICT
);

-- Um part_request só pode ter uma reserva ATIVA por vez
CREATE UNIQUE INDEX idx_opr_part_active
  ON operational_reservations(part_request_id)
  WHERE status = 'ACTIVE';

CREATE INDEX idx_opr_case       ON operational_reservations(repair_case_id);
CREATE INDEX idx_opr_status     ON operational_reservations(status);
CREATE INDEX idx_opr_chave_norm ON operational_reservations(chave_peca_norm);
CREATE INDEX idx_opr_ref_norm   ON operational_reservations(reference_norm);
CREATE INDEX idx_opr_created    ON operational_reservations(created_at);

-- =========================================================================
-- Adicionar tipos de movimentação que estavam faltando no CHECK.
-- SQLite não suporta ALTER COLUMN, portanto recriamos stock_movements.
-- A tabela tem poucas linhas operacionais (PURCHASE_RECEIPT + REPAIR_CONSUMPTION).
-- =========================================================================
PRAGMA foreign_keys = OFF;

ALTER TABLE stock_movements RENAME TO _stock_movements_014_bak;

CREATE TABLE stock_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_type TEXT    NOT NULL
                  CHECK (movement_type IN (
                    'PURCHASE_RECEIPT',
                    'REPAIR_CONSUMPTION',
                    'RESERVATION',
                    'RESERVATION_RELEASE',
                    'COUNT_ADJUSTMENT_POSITIVE',
                    'COUNT_ADJUSTMENT_NEGATIVE',
                    'COUNT_BLOCK_NEGATIVE',
                    'COUNT_BLOCK_RELEASE',
                    'MANUAL_ADJUSTMENT',
                    'RETURN',
                    'DISCARD',
                    'TRANSFER',
                    'INITIAL_BALANCE'
                  )),
  chave_peca    TEXT,
  chave_peca_norm TEXT,
  reference     TEXT,
  reference_norm TEXT,
  quantity      INTEGER NOT NULL,
  -- Rastreabilidade: qual entidade gerou o movimento
  source_type   TEXT,
  source_id     INTEGER,
  source_item_id INTEGER,
  -- Reserva associada (quando relevante)
  reservation_id INTEGER REFERENCES operational_reservations(id) ON DELETE SET NULL,
  -- Justificativa (obrigatória para MANUAL_ADJUSTMENT)
  justification TEXT,
  created_by    TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_id)
);

INSERT INTO stock_movements (
  id, movement_type, chave_peca, chave_peca_norm, reference, reference_norm,
  quantity, source_type, source_id,
  justification, created_by, created_at
)
SELECT
  id, movement_type, chave_peca, chave_peca_norm,
  referencia, referencia_norm,
  quantity, source_type, source_id,
  notes, created_by, created_at
FROM _stock_movements_014_bak;

DROP TABLE _stock_movements_014_bak;

CREATE INDEX idx_sm_type     ON stock_movements(movement_type);
CREATE INDEX idx_sm_chave    ON stock_movements(chave_peca_norm);
CREATE INDEX idx_sm_ref      ON stock_movements(reference_norm);
CREATE INDEX idx_sm_source   ON stock_movements(source_type, source_id);
CREATE INDEX idx_sm_created  ON stock_movements(created_at);

PRAGMA foreign_keys = ON;

-- =========================================================================
-- count_divergences — divergências de contagem aguardando aprovação ADMIN
-- =========================================================================
CREATE TABLE count_divergences (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  count_session_id      INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE RESTRICT,
  chave_peca            TEXT,
  chave_peca_norm       TEXT,
  reference             TEXT,
  reference_norm        TEXT,
  expected_qty          INTEGER NOT NULL,
  counted_qty           INTEGER NOT NULL,
  difference            INTEGER NOT NULL,
  -- POSITIVE: counted > expected (aprovação automática)
  -- NEGATIVE: counted < expected (aguarda aprovação ADMIN)
  divergence_type       TEXT    NOT NULL CHECK (divergence_type IN ('POSITIVE','NEGATIVE')),
  -- Quantidade temporariamente bloqueada (divergência negativa)
  blocked_qty           INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
  decision_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_at           TEXT,
  decision_notes        TEXT,
  -- Movimentos criados ao aprovar
  adjustment_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  block_movement_id      INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  release_movement_id    INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cd_session  ON count_divergences(count_session_id);
CREATE INDEX idx_cd_status   ON count_divergences(status);
CREATE INDEX idx_cd_type     ON count_divergences(divergence_type, status);
