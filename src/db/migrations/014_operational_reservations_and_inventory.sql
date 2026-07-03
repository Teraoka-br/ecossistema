-- Migration 014 — reservas operacionais por part_request e novas colunas de stock_movements.
--
-- NOTA: o CHECK constraint de stock_movements não é expandido aqui (SQLite não
-- suporta ALTER TABLE MODIFY COLUMN). Os novos tipos de movimento (INITIAL_BALANCE,
-- RESERVATION, RESERVATION_RELEASE, etc.) são validados no nível da aplicação.
-- As novas colunas são adicionadas via ALTER TABLE ADD COLUMN — seguro em transação.

-- =========================================================================
-- 1. Novas colunas de stock_movements (seguras via ADD COLUMN)
-- =========================================================================
ALTER TABLE stock_movements ADD COLUMN reservation_id      INTEGER;
ALTER TABLE stock_movements ADD COLUMN created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN justification        TEXT;

-- =========================================================================
-- 2. operational_reservations — reserva lógica por part_request
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
  cancel_reason         TEXT,
  cancel_reason_code    TEXT,
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  released_at           TEXT,
  released_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  consumed_at           TEXT,
  consumed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
-- 3. count_divergences — divergências de contagem aguardando aprovação ADMIN
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
  divergence_type       TEXT    NOT NULL CHECK (divergence_type IN ('POSITIVE','NEGATIVE')),
  blocked_qty           INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
  decision_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_at           TEXT,
  decision_notes        TEXT,
  adjustment_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  block_movement_id      INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  release_movement_id    INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cd_session  ON count_divergences(count_session_id);
CREATE INDEX idx_cd_status   ON count_divergences(status);
CREATE INDEX idx_cd_type     ON count_divergences(divergence_type, status);
