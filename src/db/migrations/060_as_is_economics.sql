-- 060: Política configurável de Venda no Estado + classificação econômica.
-- A classificação é SEPARADA do workflow: somente aprovação humana move um
-- caso para workflow_status = VENDA_ESTADO.

ALTER TABLE match_rule_sets ADD COLUMN as_is_max_repair_cost_ratio REAL NOT NULL DEFAULT 0.5;
ALTER TABLE match_rule_sets ADD COLUMN as_is_max_active_candidates INTEGER NOT NULL DEFAULT 10;
ALTER TABLE match_rule_sets ADD COLUMN as_is_require_approval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE match_rule_sets ADD COLUMN as_is_incomplete_cost_behavior TEXT NOT NULL DEFAULT 'MARK_INCOMPLETE'
  CHECK (as_is_incomplete_cost_behavior IN ('MARK_INCOMPLETE', 'IGNORE'));

CREATE TABLE case_economic_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_case_id INTEGER NOT NULL UNIQUE REFERENCES repair_cases(id),
  classification TEXT NOT NULL CHECK (classification IN (
    'NOT_EVALUATED', 'INCOMPLETE_COST', 'ECONOMICALLY_VIABLE',
    'ECONOMIC_RISK', 'ACTIVE_AS_IS_CANDIDATE', 'AS_IS_REJECTED', 'AS_IS_APPROVED'
  )),
  repair_cost_ratio REAL,
  repair_margin REAL,
  parts_cost REAL,
  parts_cost_coverage REAL,
  fingerprint TEXT,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT
);

CREATE INDEX idx_case_econ_classification ON case_economic_evaluations(classification);
