-- Migration 011 — domínio operacional de reparos e intake do Datasys.
--
-- repair_cases: um caso por aparelho (não por peça).
-- part_requests: uma linha por peça necessária.
-- repair_case_priorities: histórico de prioridade manual.
-- datasys_imports / datasys_records / datasys_import_issues: intake recorrente.
--
-- source_* permanecem intocadas como fotografia da importação inicial.

-- =========================================================================
-- repair_cases — um caso de reparo por aparelho
-- =========================================================================
CREATE TABLE repair_cases (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identidade física
  imei                     TEXT,
  imei_norm                TEXT,
  os                       TEXT,
  os_norm                  TEXT,

  -- Dados do aparelho
  brand                    TEXT,
  model                    TEXT,
  entry_date               TEXT,
  age_days                 INTEGER,
  cost                     REAL,
  estimated_sale           REAL,
  margin                   REAL,
  notes                    TEXT,

  -- Status de análise
  analysis_status          TEXT    NOT NULL DEFAULT 'DRAFT'
                             CHECK (analysis_status IN ('DRAFT','COMPLETED')),

  -- Status operacional
  workflow_status          TEXT    NOT NULL DEFAULT 'EM_ANALISE'
                             CHECK (workflow_status IN (
                               'EM_ANALISE','PEDIR_PECA','AGUARDANDO_RECEBIMENTO',
                               'MATCH_PARCIAL','MATCH','EM_SEPARACAO','APTO_REPARO',
                               'CONCLUIDO','VENDA_ESTADO','CANCELADO','VERIFICAR'
                             )),

  -- Técnico responsável
  assigned_technician_id   INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,

  -- Prioridade manual ativa (denormalização para consulta rápida)
  manual_priority_active   INTEGER NOT NULL DEFAULT 0 CHECK (manual_priority_active IN (0,1)),

  -- Vínculo com a importação legada
  legacy_import_batch_id   INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  legacy_device_key        TEXT,   -- chave técnica usada no agrupamento (imei_norm ou fallback)

  -- Auditoria
  created_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at                TEXT
);

CREATE INDEX idx_rc_imei_norm    ON repair_cases(imei_norm);
CREATE INDEX idx_rc_os_norm      ON repair_cases(os_norm);
CREATE INDEX idx_rc_workflow     ON repair_cases(workflow_status);
CREATE INDEX idx_rc_analysis     ON repair_cases(analysis_status);
CREATE INDEX idx_rc_legacy_key   ON repair_cases(legacy_device_key);
CREATE INDEX idx_rc_created      ON repair_cases(created_at);

-- =========================================================================
-- part_requests — uma linha por peça necessária
-- =========================================================================
CREATE TABLE part_requests (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_case_id              INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE RESTRICT,

  -- Peça
  description                 TEXT,
  chave_peca                  TEXT,
  chave_peca_norm             TEXT,

  -- Status da peça
  status                      TEXT    NOT NULL DEFAULT 'PEDIR_PECA'
                                CHECK (status IN (
                                  'PEDIR_PECA','AGUARDANDO_RECEBIMENTO','INDICADA',
                                  'RESERVADA','SEPARADA','CANCELADA','VERIFICAR'
                                )),
  purchase_status             TEXT,

  -- Alocação
  allocated_reference         TEXT,
  allocated_reference_norm    TEXT,

  -- Flags de análise
  analysis_complete_at_creation INTEGER NOT NULL DEFAULT 0 CHECK (analysis_complete_at_creation IN (0,1)),
  manual_override             INTEGER NOT NULL DEFAULT 0 CHECK (manual_override IN (0,1)),
  manual_override_reason      TEXT,

  -- Vínculo com legado (único quando preenchido — impede duplicar migração)
  source_order_part_id        INTEGER UNIQUE REFERENCES source_order_parts(id) ON DELETE SET NULL,
  legacy_id_pedido            TEXT,
  legacy_status               TEXT,
  legacy_kit_status           TEXT,

  -- Auditoria
  created_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at                TEXT
);

CREATE INDEX idx_pr_case          ON part_requests(repair_case_id);
CREATE INDEX idx_pr_status        ON part_requests(status);
CREATE INDEX idx_pr_chave_norm    ON part_requests(chave_peca_norm);
CREATE INDEX idx_pr_source_part   ON part_requests(source_order_part_id);
CREATE INDEX idx_pr_legacy_pedido ON part_requests(legacy_id_pedido);

-- =========================================================================
-- repair_case_priorities — histórico de prioridade manual
-- =========================================================================
CREATE TABLE repair_case_priorities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_case_id      INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE RESTRICT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  reason              TEXT    NOT NULL,  -- mínimo 10 caracteres (validado na aplicação)
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  removed_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  removed_at          TEXT,
  removal_reason      TEXT
);

-- Somente uma prioridade ativa por caso (índice único parcial)
CREATE UNIQUE INDEX idx_rcp_active
  ON repair_case_priorities(repair_case_id)
  WHERE active = 1;

CREATE INDEX idx_rcp_case   ON repair_case_priorities(repair_case_id);
CREATE INDEX idx_rcp_active_all ON repair_case_priorities(active);

-- =========================================================================
-- datasys_imports — cabeçalho de cada importação Datasys
-- =========================================================================
CREATE TABLE datasys_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_imported       INTEGER NOT NULL DEFAULT 0,
  warnings_count      INTEGER NOT NULL DEFAULT 0,
  errors_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);

CREATE INDEX idx_di_hash     ON datasys_imports(file_hash);
CREATE INDEX idx_di_status   ON datasys_imports(status);
CREATE INDEX idx_di_started  ON datasys_imports(started_at);

-- =========================================================================
-- datasys_records — uma fotografia por aparelho por importação
-- =========================================================================
CREATE TABLE datasys_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  datasys_import_id   INTEGER NOT NULL REFERENCES datasys_imports(id) ON DELETE CASCADE,
  imei                TEXT,
  imei_norm           TEXT,
  os                  TEXT,
  os_norm             TEXT,
  brand               TEXT,
  model               TEXT,
  entry_date          TEXT,
  age_days            INTEGER,
  cost                REAL,
  raw_data_json       TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dr_import    ON datasys_records(datasys_import_id);
CREATE INDEX idx_dr_imei_norm ON datasys_records(imei_norm);
CREATE INDEX idx_dr_os_norm   ON datasys_records(os_norm);

-- =========================================================================
-- datasys_import_issues — problemas por linha da importação Datasys
-- =========================================================================
CREATE TABLE datasys_import_issues (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  datasys_import_id   INTEGER NOT NULL REFERENCES datasys_imports(id) ON DELETE CASCADE,
  row_number          INTEGER,
  severity            TEXT    NOT NULL CHECK (severity IN ('ERROR','WARNING')),
  code                TEXT    NOT NULL,
  message             TEXT    NOT NULL,
  raw_value           TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dii_import ON datasys_import_issues(datasys_import_id);
