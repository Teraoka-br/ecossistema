-- 059: Campos de custo de peças no motor de match (shadow mode).
-- Permite calcular margem de reparo (com custo de peças) em paralelo
-- à margem legada, sem alterar o ranking real até ativação explícita.

ALTER TABLE match_rule_sets ADD COLUMN include_parts_cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_rule_sets ADD COLUMN shadow_mode INTEGER NOT NULL DEFAULT 1;
ALTER TABLE match_rule_sets ADD COLUMN min_parts_cost_coverage REAL NOT NULL DEFAULT 0;
ALTER TABLE match_rule_sets ADD COLUMN missing_cost_behavior TEXT NOT NULL DEFAULT 'USE_LEGACY_MARGIN'
  CHECK (missing_cost_behavior IN ('USE_LEGACY_MARGIN', 'SEND_TO_VERIFY', 'EXCLUDE'));

ALTER TABLE repair_match_case_results ADD COLUMN parts_cost REAL;
ALTER TABLE repair_match_case_results ADD COLUMN parts_cost_coverage REAL;
ALTER TABLE repair_match_case_results ADD COLUMN parts_cost_confidence TEXT;
ALTER TABLE repair_match_case_results ADD COLUMN repair_margin REAL;
ALTER TABLE repair_match_case_results ADD COLUMN repair_score REAL;
ALTER TABLE repair_match_case_results ADD COLUMN is_shadow INTEGER NOT NULL DEFAULT 0;
