-- Migration 007 — motor de match: recria match_runs e match_results com
-- esquema completo, cria match_device_results.
--
-- match_runs e match_results foram criadas VAZIAS na migration 001 (motor de
-- match preparado, não implementado). Recriamos agora com o esquema real,
-- sem perda de dados (nunca tiveram linhas operacionais).
--
-- MATCH É RECOMENDAÇÃO CALCULADA. Não reserva nem consome estoque.
-- A confirmação física (REPAIR_CONSUMPTION) é fase posterior.

-- Remover match_results primeiro (referencia match_runs via FK).
DROP TABLE IF EXISTS match_results;
DROP TABLE IF EXISTS match_runs;

-- =========================================================================
-- match_runs — uma execução do motor de match
-- =========================================================================
CREATE TABLE match_runs (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id             INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  decision_rule_id            INTEGER REFERENCES decision_rules(id) ON DELETE SET NULL,
  algorithm_version           TEXT    NOT NULL DEFAULT '1',
  status                      TEXT    NOT NULL DEFAULT 'RUNNING'
                                CHECK (status IN ('RUNNING','COMPLETED','COMPLETED_WITH_WARNINGS','FAILED')),
  input_hash                  TEXT,
  created_by                  TEXT    NOT NULL DEFAULT '(sistema)',
  started_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at                 TEXT,
  notes                       TEXT,
  error_message               TEXT,

  -- Base de estoque usada (fotografia para reprodutibilidade)
  stock_base_type             TEXT,
  stock_snapshot_id           INTEGER,
  stock_cutoff_movement_id    INTEGER NOT NULL DEFAULT 0,
  stock_max_movement_id       INTEGER NOT NULL DEFAULT 0,
  stock_total_units           INTEGER NOT NULL DEFAULT 0,
  stock_usable_units          INTEGER NOT NULL DEFAULT 0,
  stock_unmapped_units        INTEGER NOT NULL DEFAULT 0,

  -- Fotografia da regra utilizada (para reprodutibilidade histórica)
  rule_age_days_per_point     INTEGER,
  rule_age_max_points         INTEGER,
  rule_margin_per_point       REAL,
  rule_margin_allows_negative INTEGER,

  -- Estatísticas de aparelhos
  devices_total               INTEGER NOT NULL DEFAULT 0,
  devices_considered          INTEGER NOT NULL DEFAULT 0,
  devices_full_match          INTEGER NOT NULL DEFAULT 0,
  devices_partial             INTEGER NOT NULL DEFAULT 0,
  devices_incomplete          INTEGER NOT NULL DEFAULT 0,
  devices_verify              INTEGER NOT NULL DEFAULT 0,
  devices_preserved           INTEGER NOT NULL DEFAULT 0,

  -- Estatísticas de linhas
  lines_total                 INTEGER NOT NULL DEFAULT 0,
  lines_match                 INTEGER NOT NULL DEFAULT 0,
  lines_partial               INTEGER NOT NULL DEFAULT 0,
  lines_request_piece         INTEGER NOT NULL DEFAULT 0,
  lines_no_balance            INTEGER NOT NULL DEFAULT 0,
  lines_verify                INTEGER NOT NULL DEFAULT 0,
  lines_preserved             INTEGER NOT NULL DEFAULT 0,

  -- Totais de estoque
  allocated_units             INTEGER NOT NULL DEFAULT 0,
  remaining_usable_units      INTEGER NOT NULL DEFAULT 0,
  warnings_count              INTEGER NOT NULL DEFAULT 0,

  created_at                  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- No máximo uma execução RUNNING no sistema inteiro.
CREATE UNIQUE INDEX idx_match_runs_one_running ON match_runs(status) WHERE status = 'RUNNING';
CREATE INDEX idx_match_runs_status ON match_runs(status);
CREATE INDEX idx_match_runs_hash ON match_runs(input_hash);
CREATE INDEX idx_match_runs_batch ON match_runs(import_batch_id);

-- =========================================================================
-- match_device_results — uma linha por aparelho (IMEI) por execução
-- =========================================================================
CREATE TABLE match_device_results (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  match_run_id       INTEGER NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  device_key         TEXT    NOT NULL,  -- IMEI normalizado ou "__NO_IMEI__"
  imei               TEXT,
  os_values_json     TEXT    NOT NULL DEFAULT '[]',
  os_conflict        INTEGER NOT NULL DEFAULT 0,

  total_parts        INTEGER NOT NULL DEFAULT 0,
  open_parts         INTEGER NOT NULL DEFAULT 0,
  permanent_parts    INTEGER NOT NULL DEFAULT 0,

  score              INTEGER NOT NULL DEFAULT 0,
  margin             REAL,
  age_score          INTEGER NOT NULL DEFAULT 0,
  margin_score       INTEGER NOT NULL DEFAULT 0,
  priority_rank      INTEGER,
  stable_id          TEXT,

  kit_status         TEXT,
  kit_priority       INTEGER,
  allocation_phase   TEXT,
  warning_codes_json TEXT    NOT NULL DEFAULT '[]',
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),

  UNIQUE (match_run_id, device_key)
);

CREATE INDEX idx_match_device_results_run ON match_device_results(match_run_id);
CREATE INDEX idx_match_device_results_kit ON match_device_results(match_run_id, kit_status);

-- =========================================================================
-- match_results — uma linha por ID_PEDIDO por execução
-- =========================================================================
CREATE TABLE match_results (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  match_run_id             INTEGER NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  source_order_part_id     INTEGER NOT NULL REFERENCES source_order_parts(id) ON DELETE CASCADE,
  device_result_id         INTEGER REFERENCES match_device_results(id) ON DELETE SET NULL,
  id_pedido                TEXT    NOT NULL,
  imei                     TEXT,
  os                       TEXT,
  chave_peca               TEXT,
  chave_peca_norm          TEXT,

  allocated_reference      TEXT,
  allocated_reference_norm TEXT,

  effective_status_before  TEXT,
  result_status            TEXT,
  result_status_label      TEXT,
  kit_status               TEXT,
  kit_priority             INTEGER,

  allocation_phase         TEXT,
  reserved_units           INTEGER NOT NULL DEFAULT 0,
  ordem_consumo            INTEGER,

  stock_for_key_initial    INTEGER NOT NULL DEFAULT 0,
  stock_for_key_before     INTEGER NOT NULL DEFAULT 0,
  stock_for_key_after      INTEGER NOT NULL DEFAULT 0,

  margin                   REAL,
  nota_idade               INTEGER NOT NULL DEFAULT 0,
  nota_margem              INTEGER NOT NULL DEFAULT 0,
  score                    INTEGER NOT NULL DEFAULT 0,
  device_priority_rank     INTEGER,

  reason_code              TEXT,
  warning_codes_json       TEXT    NOT NULL DEFAULT '[]',
  created_at               TEXT    NOT NULL DEFAULT (datetime('now')),

  UNIQUE (match_run_id, id_pedido)
);

CREATE INDEX idx_match_results_run ON match_results(match_run_id);
CREATE INDEX idx_match_results_pedido ON match_results(match_run_id, id_pedido);
CREATE INDEX idx_match_results_imei ON match_results(match_run_id, imei);
CREATE INDEX idx_match_results_status ON match_results(match_run_id, result_status);
CREATE INDEX idx_match_results_device ON match_results(device_result_id);
CREATE INDEX idx_match_results_chave ON match_results(match_run_id, chave_peca_norm);
