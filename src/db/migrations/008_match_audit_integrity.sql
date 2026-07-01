-- Migration 008 — integridade e auditoria do motor de match
--
-- Adicionado:
--   match_stock_results  — fotografia completa de estoque mapeável por execução (inclui itens sem demanda)
--   stock_state_hash     — hash SHA-256 do estado efetivo do estoque em match_runs
--
-- Constraints numéricas em decision_rules são validadas em aplicação (match-service.ts)
-- pois ALTER TABLE + ADD CONSTRAINT não existe no SQLite.

-- ---------------------------------------------------------------------------
-- match_stock_results — uma linha por (run, chave_peca_norm, reference_norm)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_stock_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  match_run_id      INTEGER NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  chave_peca        TEXT,
  chave_peca_norm   TEXT    NOT NULL,
  reference         TEXT    NOT NULL,
  reference_norm    TEXT    NOT NULL,
  initial_quantity  INTEGER NOT NULL DEFAULT 0,
  allocated_full    INTEGER NOT NULL DEFAULT 0,
  allocated_partial INTEGER NOT NULL DEFAULT 0,
  remaining_quantity INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),

  UNIQUE (match_run_id, chave_peca_norm, reference_norm)
);

CREATE INDEX IF NOT EXISTS idx_match_stock_results_run   ON match_stock_results(match_run_id);
CREATE INDEX IF NOT EXISTS idx_match_stock_results_chave ON match_stock_results(match_run_id, chave_peca_norm);

-- ---------------------------------------------------------------------------
-- stock_state_hash em match_runs — SHA-256 das quantidades efetivas do estoque
-- ---------------------------------------------------------------------------
ALTER TABLE match_runs ADD COLUMN stock_state_hash TEXT;
