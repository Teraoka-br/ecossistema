-- Migration 015 — sincronizações operacionais: SH Oficina, His Estoque, PEACS, BKP Sistêmico.
--
-- Todas as importações são idempotentes por hash.
-- Nenhuma cria repair_cases automaticamente — apenas enriquece casos existentes.
-- Linhas sem vínculo ficam armazenadas para revisão manual.

-- =========================================================================
-- sh_imports — cabeçalho de importações do SH Oficina
-- =========================================================================
CREATE TABLE sh_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_linked         INTEGER NOT NULL DEFAULT 0,
  rows_unlinked       INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT,
  notes               TEXT
);
CREATE UNIQUE INDEX idx_sh_imports_hash ON sh_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_sh_imports_status  ON sh_imports(status);
CREATE INDEX idx_sh_imports_created ON sh_imports(created_at);

-- =========================================================================
-- sh_import_rows — uma linha por registro do SH
-- =========================================================================
CREATE TABLE sh_import_rows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sh_import_id        INTEGER NOT NULL REFERENCES sh_imports(id) ON DELETE CASCADE,
  imei                TEXT,
  imei_norm           TEXT,
  os                  TEXT,
  os_norm             TEXT,
  brand               TEXT,
  model               TEXT,
  capacity            TEXT,
  color               TEXT,
  defect              TEXT,
  os_status           TEXT,
  repair_date         TEXT,
  raw_data_json       TEXT,
  -- Vínculo com repair_case (null = não vinculado)
  repair_case_id      INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  link_method         TEXT,  -- IMEI_OS_DATE | IMEI_DATE | SINGLE_OPEN | MANUAL | AMBIGUOUS
  link_issue          TEXT,  -- motivo da ambiguidade ou falha de vínculo
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sh_rows_import     ON sh_import_rows(sh_import_id);
CREATE INDEX idx_sh_rows_imei_norm  ON sh_import_rows(imei_norm);
CREATE INDEX idx_sh_rows_case       ON sh_import_rows(repair_case_id);

-- =========================================================================
-- sh_field_changes — alterações aplicadas a repair_cases pelo SH
-- =========================================================================
CREATE TABLE sh_field_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sh_import_id    INTEGER NOT NULL REFERENCES sh_imports(id) ON DELETE CASCADE,
  sh_row_id       INTEGER NOT NULL REFERENCES sh_import_rows(id) ON DELETE CASCADE,
  repair_case_id  INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
  field_name      TEXT    NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sh_changes_case    ON sh_field_changes(repair_case_id);
CREATE INDEX idx_sh_changes_import  ON sh_field_changes(sh_import_id);

-- =========================================================================
-- his_imports — cabeçalho de importações do His Estoque
-- =========================================================================
CREATE TABLE his_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_linked         INTEGER NOT NULL DEFAULT 0,
  rows_unlinked       INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_his_imports_hash ON his_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_his_imports_status ON his_imports(status);

-- =========================================================================
-- his_import_rows — uma linha por aparelho no His
-- =========================================================================
CREATE TABLE his_import_rows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  his_import_id       INTEGER NOT NULL REFERENCES his_imports(id) ON DELETE CASCADE,
  imei                TEXT,
  imei_norm           TEXT,
  os                  TEXT,
  os_norm             TEXT,
  audited_cost        REAL,
  entry_date          TEXT,
  report_date         TEXT,
  raw_data_json       TEXT,
  repair_case_id      INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  link_method         TEXT,
  link_issue          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_his_rows_import    ON his_import_rows(his_import_id);
CREATE INDEX idx_his_rows_imei_norm ON his_import_rows(imei_norm);
CREATE INDEX idx_his_rows_case      ON his_import_rows(repair_case_id);

-- =========================================================================
-- peacs_imports — cabeçalho de importações do PEACS
-- =========================================================================
CREATE TABLE peacs_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  entries_matched     INTEGER NOT NULL DEFAULT 0,
  entries_unmatched   INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_peacs_imports_hash ON peacs_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');

-- =========================================================================
-- peacs_catalog — catálogo de preços estimados de venda
-- Chave: brand_norm + model_norm + capacity_norm (cor não participa)
-- =========================================================================
CREATE TABLE peacs_catalog (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  peacs_import_id     INTEGER NOT NULL REFERENCES peacs_imports(id) ON DELETE RESTRICT,
  brand               TEXT    NOT NULL,
  brand_norm          TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  model_norm          TEXT    NOT NULL,
  capacity            TEXT,
  capacity_norm       TEXT,
  estimated_sale      REAL    NOT NULL,
  raw_data_json       TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_peacs_catalog_key ON peacs_catalog(brand_norm, model_norm, capacity_norm)
  WHERE active = 1;
CREATE INDEX idx_peacs_catalog_import ON peacs_catalog(peacs_import_id);

-- =========================================================================
-- peacs_manual_links — vínculos manuais quando a correspondência é ambígua
-- =========================================================================
CREATE TABLE peacs_manual_links (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_case_id      INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
  peacs_catalog_id    INTEGER NOT NULL REFERENCES peacs_catalog(id) ON DELETE RESTRICT,
  linked_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repair_case_id)
);

-- =========================================================================
-- bkp_imports — cabeçalho de importações do BKP Sistêmico
-- =========================================================================
CREATE TABLE bkp_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  sheets_processed    TEXT,  -- JSON array de nomes de abas processadas
  rows_found          INTEGER NOT NULL DEFAULT 0,
  events_linked       INTEGER NOT NULL DEFAULT 0,
  events_unlinked     INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_bkp_imports_hash ON bkp_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');

-- =========================================================================
-- systemic_repair_events — eventos da aba REPAROS TECNICOS do BKP
-- =========================================================================
CREATE TABLE systemic_repair_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bkp_import_id       INTEGER NOT NULL REFERENCES bkp_imports(id) ON DELETE CASCADE,
  imei                TEXT,
  imei_norm           TEXT,
  os                  TEXT,
  os_norm             TEXT,
  technician_name     TEXT,
  repair_date         TEXT,
  repair_type         TEXT,
  part_used           TEXT,
  reference_used      TEXT,
  executed            INTEGER,  -- 1 = reparo executado
  assistance_code     TEXT,
  raw_data_json       TEXT,
  -- Vínculo
  repair_case_id      INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  link_method         TEXT,
  link_issue          TEXT,
  idempotency_key     TEXT    UNIQUE,  -- hash da linha para idempotência
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sre_import    ON systemic_repair_events(bkp_import_id);
CREATE INDEX idx_sre_imei_norm ON systemic_repair_events(imei_norm);
CREATE INDEX idx_sre_case      ON systemic_repair_events(repair_case_id);

-- =========================================================================
-- systemic_part_writeoffs — eventos da aba BAIXA_DE_PEÇA do BKP
-- =========================================================================
CREATE TABLE systemic_part_writeoffs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bkp_import_id       INTEGER NOT NULL REFERENCES bkp_imports(id) ON DELETE CASCADE,
  imei                TEXT,
  imei_norm           TEXT,
  reference           TEXT,
  reference_norm      TEXT,
  writeoff_status     TEXT,  -- BAIXA OK | DAR BAIXA | SEM SALDO | REF INVÁLIDA
  raw_data_json       TEXT,
  repair_case_id      INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  reservation_id      INTEGER REFERENCES operational_reservations(id) ON DELETE SET NULL,
  idempotency_key     TEXT    UNIQUE,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_spw_import    ON systemic_part_writeoffs(bkp_import_id);
CREATE INDEX idx_spw_imei_norm ON systemic_part_writeoffs(imei_norm);
CREATE INDEX idx_spw_case      ON systemic_part_writeoffs(repair_case_id);

-- =========================================================================
-- device_location_snapshots — localização física do aparelho por importação
-- =========================================================================
CREATE TABLE device_location_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bkp_import_id       INTEGER NOT NULL REFERENCES bkp_imports(id) ON DELETE CASCADE,
  imei                TEXT,
  imei_norm           TEXT,
  os                  TEXT,
  os_norm             TEXT,
  location            TEXT,  -- depósito/setor conforme valor real do arquivo
  snapshot_date       TEXT,
  raw_data_json       TEXT,
  repair_case_id      INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  idempotency_key     TEXT    UNIQUE,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_dls_import    ON device_location_snapshots(bkp_import_id);
CREATE INDEX idx_dls_imei_norm ON device_location_snapshots(imei_norm);
CREATE INDEX idx_dls_case      ON device_location_snapshots(repair_case_id);
CREATE INDEX idx_dls_date      ON device_location_snapshots(snapshot_date);

-- =========================================================================
-- systemic_import_issues — problemas de qualquer importação sistêmica
-- =========================================================================
CREATE TABLE systemic_import_issues (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type         TEXT    NOT NULL CHECK (import_type IN ('SH','HIS','PEACS','BKP')),
  import_id           INTEGER NOT NULL,
  row_number          INTEGER,
  severity            TEXT    NOT NULL CHECK (severity IN ('ERROR','WARNING','INFO')),
  code                TEXT    NOT NULL,
  message             TEXT    NOT NULL,
  raw_value           TEXT,
  repair_case_id      INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sii_import  ON systemic_import_issues(import_type, import_id);
CREATE INDEX idx_sii_case    ON systemic_import_issues(repair_case_id);
CREATE INDEX idx_sii_code    ON systemic_import_issues(code);
