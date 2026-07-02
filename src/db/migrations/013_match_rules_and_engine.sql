-- Migration 013 — regras versionadas de match, motor automático e expansão de estados.
--
-- 1. Expande CHECK de workflow_status em repair_cases (rebuild da tabela no SQLite).
-- 2. Cria match_rule_sets — regras de scoring versionadas e auditáveis.
-- 3. Cria repair_match_runs / repair_match_results — execuções do motor sobre repair_cases.
-- 4. Cria match_engine_state — estado global do motor (IDLE/RUNNING/STALE/FAILED).
-- 5. Cria match_recompute_requests — fila de orquestração persistente e idempotente.
-- 6. Insere a regra padrão ativa (v1).

-- =========================================================================
-- 1. Rebuild repair_cases com CHECK de workflow_status expandido
--    (SQLite não suporta ALTER COLUMN — precisamos recriar a tabela)
-- =========================================================================
PRAGMA foreign_keys = OFF;

ALTER TABLE repair_cases RENAME TO _repair_cases_013_bak;

CREATE TABLE repair_cases (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  imei                     TEXT,
  imei_norm                TEXT,
  os                       TEXT,
  os_norm                  TEXT,
  brand                    TEXT,
  model                    TEXT,
  capacity                 TEXT,
  color                    TEXT,
  entry_date               TEXT,
  repair_date              TEXT,
  repair_date_source       TEXT,
  age_days                 INTEGER,
  cost                     REAL,
  estimated_sale           REAL,
  margin                   REAL,
  notes                    TEXT,
  analysis_status          TEXT    NOT NULL DEFAULT 'DRAFT'
                             CHECK (analysis_status IN ('DRAFT','COMPLETED')),
  workflow_status          TEXT    NOT NULL DEFAULT 'EM_ANALISE'
                             CHECK (workflow_status IN (
                               'EM_ANALISE','PEDIR_PECA','AGUARDANDO_RECEBIMENTO',
                               'MATCH_PARCIAL','MATCH','EM_SEPARACAO','APTO_REPARO',
                               'DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO',
                               'TRIAGEM_FINAL','RETORNO_TECNICO',
                               'CONCLUIDO','VENDA_ESTADO','CANCELADO','VERIFICAR'
                             )),
  assigned_technician_id   INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,
  directed_technician_id   INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,
  directed_at              TEXT,
  directed_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  manual_priority_active   INTEGER NOT NULL DEFAULT 0 CHECK (manual_priority_active IN (0,1)),
  legacy_import_batch_id   INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  legacy_device_key        TEXT,
  legacy_case_key          TEXT,
  created_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at                TEXT
);

INSERT INTO repair_cases (
  id, imei, imei_norm, os, os_norm, brand, model, capacity, color, entry_date,
  repair_date, repair_date_source,
  age_days, cost, estimated_sale, margin, notes,
  analysis_status, workflow_status, assigned_technician_id,
  manual_priority_active, legacy_import_batch_id, legacy_device_key, legacy_case_key,
  created_by_user_id, updated_by_user_id, created_at, updated_at, closed_at
)
SELECT
  id, imei, imei_norm, os, os_norm, brand, model, NULL, NULL, entry_date,
  repair_date, repair_date_source,
  age_days, cost, estimated_sale, margin, notes,
  analysis_status, workflow_status, assigned_technician_id,
  manual_priority_active, legacy_import_batch_id, legacy_device_key, legacy_case_key,
  created_by_user_id, updated_by_user_id, created_at, updated_at, closed_at
FROM _repair_cases_013_bak;

DROP TABLE _repair_cases_013_bak;

-- Recriar índices da 011 + índice único parcial da 012
CREATE INDEX IF NOT EXISTS idx_rc_imei_norm    ON repair_cases(imei_norm);
CREATE INDEX IF NOT EXISTS idx_rc_os_norm      ON repair_cases(os_norm);
CREATE INDEX IF NOT EXISTS idx_rc_workflow     ON repair_cases(workflow_status);
CREATE INDEX IF NOT EXISTS idx_rc_analysis     ON repair_cases(analysis_status);
CREATE INDEX IF NOT EXISTS idx_rc_legacy_key   ON repair_cases(legacy_device_key);
CREATE INDEX IF NOT EXISTS idx_rc_created      ON repair_cases(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_cases_legacy_case
  ON repair_cases (legacy_import_batch_id, legacy_case_key)
  WHERE legacy_import_batch_id IS NOT NULL AND legacy_case_key IS NOT NULL;

PRAGMA foreign_keys = ON;

-- =========================================================================
-- 2. match_rule_sets — regras de scoring versionadas
-- =========================================================================
CREATE TABLE match_rule_sets (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  version                     INTEGER NOT NULL UNIQUE,
  -- Fórmula: margin_points = floor(margin / margin_amount_per_point)
  margin_amount_per_point     REAL    NOT NULL DEFAULT 150.0,
  -- Fórmula: age_points = min(floor(age_days / age_days_per_point), age_max_points)
  age_days_per_point          INTEGER NOT NULL DEFAULT 30,
  age_max_points              INTEGER NOT NULL DEFAULT 15,
  allow_negative_margin_score INTEGER NOT NULL DEFAULT 1 CHECK (allow_negative_margin_score IN (0,1)),
  -- score = margin_points * margin_weight + age_points * age_weight
  margin_weight               REAL    NOT NULL DEFAULT 1.0,
  age_weight                  REAL    NOT NULL DEFAULT 1.0,
  active                      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  reason                      TEXT,
  created_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  activated_by_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  activated_at                TEXT
);

-- Somente uma regra ativa ao mesmo tempo
CREATE UNIQUE INDEX idx_match_rule_sets_active ON match_rule_sets(active) WHERE active = 1;

-- =========================================================================
-- 3. repair_match_runs — execuções do motor sobre repair_cases
-- =========================================================================
CREATE TABLE repair_match_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_set_id           INTEGER REFERENCES match_rule_sets(id) ON DELETE SET NULL,
  rule_set_version      INTEGER,
  status                TEXT    NOT NULL DEFAULT 'RUNNING'
                          CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  trigger_reason        TEXT,
  trigger_entity_type   TEXT,
  trigger_entity_id     INTEGER,
  triggered_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at           TEXT,
  error_message         TEXT,
  cases_evaluated       INTEGER NOT NULL DEFAULT 0,
  full_kits_found       INTEGER NOT NULL DEFAULT 0,
  partial_kits_found    INTEGER NOT NULL DEFAULT 0,
  cases_changed         INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_rmr_one_running ON repair_match_runs(status) WHERE status = 'RUNNING';
CREATE INDEX idx_rmr_status ON repair_match_runs(status);
CREATE INDEX idx_rmr_created ON repair_match_runs(created_at);

-- =========================================================================
-- 4. repair_match_results — resultado por part_request por execução
-- =========================================================================
CREATE TABLE repair_match_results (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES repair_match_runs(id) ON DELETE CASCADE,
  repair_case_id        INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
  part_request_id       INTEGER NOT NULL REFERENCES part_requests(id) ON DELETE CASCADE,
  chave_peca            TEXT,
  chave_peca_norm       TEXT,
  result_status         TEXT    NOT NULL,
  allocated_reference   TEXT,
  allocated_ref_norm    TEXT,
  available_before      INTEGER NOT NULL DEFAULT 0,
  allocated_units       INTEGER NOT NULL DEFAULT 0,
  available_after       INTEGER NOT NULL DEFAULT 0,
  margin_points         INTEGER NOT NULL DEFAULT 0,
  age_points            INTEGER NOT NULL DEFAULT 0,
  score                 INTEGER NOT NULL DEFAULT 0,
  priority_rank         INTEGER,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, part_request_id)
);

CREATE INDEX idx_rmr_results_run       ON repair_match_results(run_id);
CREATE INDEX idx_rmr_results_case      ON repair_match_results(repair_case_id);
CREATE INDEX idx_rmr_results_part      ON repair_match_results(part_request_id);
CREATE INDEX idx_rmr_results_status    ON repair_match_results(run_id, result_status);

-- =========================================================================
-- 5. match_engine_state — estado global do motor (linha única id=1)
-- =========================================================================
CREATE TABLE match_engine_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_id  INTEGER REFERENCES repair_match_runs(id) ON DELETE SET NULL,
  status       TEXT    NOT NULL DEFAULT 'IDLE'
                 CHECK (status IN ('IDLE','RUNNING','STALE','FAILED')),
  stale_since  TEXT,
  last_error   TEXT,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO match_engine_state (id, status) VALUES (1, 'IDLE');

-- =========================================================================
-- 6. match_recompute_requests — fila persistente de reprocessamento
-- =========================================================================
CREATE TABLE match_recompute_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reason          TEXT    NOT NULL,
  entity_type     TEXT,
  entity_id       INTEGER,
  requested_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT,
  run_id          INTEGER REFERENCES repair_match_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_mrr_pending ON match_recompute_requests(processed_at)
  WHERE processed_at IS NULL;

-- =========================================================================
-- 7. Inserir regra padrão ativa (versão 1)
-- =========================================================================
INSERT INTO match_rule_sets (
  version, margin_amount_per_point, age_days_per_point, age_max_points,
  allow_negative_margin_score, margin_weight, age_weight,
  active, reason, activated_at
) VALUES (
  1, 150.0, 30, 15, 1, 1.0, 1.0,
  1, 'Regra padrão inicial — Macrofase 2', datetime('now')
);
