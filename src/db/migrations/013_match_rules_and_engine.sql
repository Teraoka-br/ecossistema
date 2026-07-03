-- Migration 013 — regras versionadas de match, motor automático e expansão de estados.
--
-- 1. Adiciona colunas a repair_cases via ALTER TABLE ADD COLUMN (seguro em transação).
-- 2. Expande o CHECK de workflow_status via uma migration helper separada (ver abaixo).
-- 3. Cria match_rule_sets — regras de scoring versionadas e auditáveis.
-- 4. Cria repair_match_runs / repair_match_results — execuções do motor sobre repair_cases.
-- 5. Cria match_engine_state — estado global do motor (IDLE/RUNNING/STALE/FAILED).
-- 6. Cria match_recompute_requests — fila de orquestração persistente e idempotente.
-- 7. Insere a regra padrão ativa (v1).
--
-- NOTA: O CHECK constraint de workflow_status não pode ser expandido via ADD COLUMN
-- no SQLite. Os novos status (DIRECIONADO_TECNICO, EM_REPARO, REPARO_EXECUTADO,
-- TRIAGEM_FINAL, RETORNO_TECNICO) requerem a recriação da tabela, que é feita em
-- 013b (ver 013b_repair_cases_check_expand.sql). Os ADD COLUMN abaixo garantem que
-- as colunas existam independentemente do rebuild.

-- =========================================================================
-- 1. Novas colunas de repair_cases (seguras via ADD COLUMN)
-- =========================================================================
ALTER TABLE repair_cases ADD COLUMN capacity              TEXT;
ALTER TABLE repair_cases ADD COLUMN color                 TEXT;
ALTER TABLE repair_cases ADD COLUMN directed_technician_id INTEGER REFERENCES staff_members(id) ON DELETE SET NULL;
ALTER TABLE repair_cases ADD COLUMN directed_at           TEXT;
ALTER TABLE repair_cases ADD COLUMN directed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- =========================================================================
-- 2. match_rule_sets — regras de scoring versionadas
-- =========================================================================
CREATE TABLE match_rule_sets (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  version                     INTEGER NOT NULL UNIQUE,
  margin_amount_per_point     REAL    NOT NULL DEFAULT 150.0,
  age_days_per_point          INTEGER NOT NULL DEFAULT 30,
  age_max_points              INTEGER NOT NULL DEFAULT 15,
  allow_negative_margin_score INTEGER NOT NULL DEFAULT 1 CHECK (allow_negative_margin_score IN (0,1)),
  margin_weight               REAL    NOT NULL DEFAULT 1.0,
  age_weight                  REAL    NOT NULL DEFAULT 1.0,
  active                      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  reason                      TEXT,
  created_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  activated_by_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  activated_at                TEXT
);

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
