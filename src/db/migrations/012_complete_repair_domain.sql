-- 012_complete_repair_domain.sql
-- Adiciona identidade temporal (repair_date) e chave de caso legado a repair_cases.
-- Adiciona staged_file_path a datasys_imports para controle server-side de uploads.

ALTER TABLE repair_cases ADD COLUMN repair_date TEXT;
ALTER TABLE repair_cases ADD COLUMN repair_date_source TEXT;
ALTER TABLE repair_cases ADD COLUMN legacy_case_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_cases_legacy_case
  ON repair_cases (legacy_import_batch_id, legacy_case_key)
  WHERE legacy_import_batch_id IS NOT NULL AND legacy_case_key IS NOT NULL;

ALTER TABLE datasys_imports ADD COLUMN staged_file_path TEXT;
ALTER TABLE datasys_imports ADD COLUMN cancelled_at TEXT;
