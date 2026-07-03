-- Migration 016 — Expande CHECKs de workflow para suportar fluxo completo de reparo.
--
-- repair_cases.workflow_status: adiciona DIRECIONADO_TECNICO, EM_REPARO,
--   REPARO_EXECUTADO, TRIAGEM_FINAL, RETORNO_TECNICO.
-- part_requests.status: adiciona CONSUMIDA.
--
-- Estratégia de reconstrução (SQLite não tem ALTER TABLE MODIFY COLUMN):
--   PRAGMA foreign_keys = OFF + PRAGMA legacy_alter_table = ON (fora de BEGIN,
--   via runner) — evita que RENAME TO atualize referências de FK nas tabelas filhas.
--   As FKs das filhas continuam apontando para repair_cases / part_requests
--   com os mesmos nomes, sem necessidade de reconstruí-las.

PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

-- =========================================================================
-- 1. Reconstruir repair_cases com CHECK expandido
-- =========================================================================
ALTER TABLE repair_cases RENAME TO _repair_cases_016_bak;

CREATE TABLE repair_cases (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  imei                     TEXT,
  imei_norm                TEXT,
  os                       TEXT,
  os_norm                  TEXT,
  brand                    TEXT,
  model                    TEXT,
  entry_date               TEXT,
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
  manual_priority_active   INTEGER NOT NULL DEFAULT 0 CHECK (manual_priority_active IN (0,1)),
  legacy_import_batch_id   INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  legacy_device_key        TEXT,
  created_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at                TEXT,
  repair_date              TEXT,
  repair_date_source       TEXT,
  legacy_case_key          TEXT,
  capacity                 TEXT,
  color                    TEXT,
  directed_technician_id   INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,
  directed_at              TEXT,
  directed_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO repair_cases SELECT
  id, imei, imei_norm, os, os_norm, brand, model, entry_date, age_days,
  cost, estimated_sale, margin, notes, analysis_status, workflow_status,
  assigned_technician_id, manual_priority_active, legacy_import_batch_id,
  legacy_device_key, created_by_user_id, updated_by_user_id, created_at,
  updated_at, closed_at, repair_date, repair_date_source, legacy_case_key,
  capacity, color, directed_technician_id, directed_at, directed_by_user_id
FROM _repair_cases_016_bak;

DROP TABLE _repair_cases_016_bak;

CREATE INDEX idx_rc_imei_norm  ON repair_cases(imei_norm);
CREATE INDEX idx_rc_os_norm    ON repair_cases(os_norm);
CREATE INDEX idx_rc_workflow   ON repair_cases(workflow_status);
CREATE INDEX idx_rc_analysis   ON repair_cases(analysis_status);
CREATE INDEX idx_rc_legacy_key ON repair_cases(legacy_device_key);
CREATE INDEX idx_rc_created    ON repair_cases(created_at);
CREATE UNIQUE INDEX idx_repair_cases_legacy_case
  ON repair_cases(legacy_import_batch_id, legacy_case_key)
  WHERE legacy_import_batch_id IS NOT NULL AND legacy_case_key IS NOT NULL;

-- =========================================================================
-- 2. Reconstruir part_requests com CHECK expandido (adiciona CONSUMIDA)
-- =========================================================================
ALTER TABLE part_requests RENAME TO _part_requests_016_bak;

CREATE TABLE part_requests (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_case_id              INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE RESTRICT,
  description                 TEXT,
  chave_peca                  TEXT,
  chave_peca_norm             TEXT,
  status                      TEXT    NOT NULL DEFAULT 'PEDIR_PECA'
                                CHECK (status IN (
                                  'PEDIR_PECA','AGUARDANDO_RECEBIMENTO','INDICADA',
                                  'RESERVADA','SEPARADA','CONSUMIDA','CANCELADA','VERIFICAR'
                                )),
  purchase_status             TEXT,
  allocated_reference         TEXT,
  allocated_reference_norm    TEXT,
  analysis_complete_at_creation INTEGER NOT NULL DEFAULT 0 CHECK (analysis_complete_at_creation IN (0,1)),
  manual_override             INTEGER NOT NULL DEFAULT 0 CHECK (manual_override IN (0,1)),
  manual_override_reason      TEXT,
  source_order_part_id        INTEGER UNIQUE REFERENCES source_order_parts(id) ON DELETE SET NULL,
  legacy_id_pedido            TEXT,
  legacy_status               TEXT,
  legacy_kit_status           TEXT,
  created_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at                TEXT
);

INSERT INTO part_requests SELECT
  id, repair_case_id, description, chave_peca, chave_peca_norm, status,
  purchase_status, allocated_reference, allocated_reference_norm,
  analysis_complete_at_creation, manual_override, manual_override_reason,
  source_order_part_id, legacy_id_pedido, legacy_status, legacy_kit_status,
  created_by_user_id, updated_by_user_id, created_at, updated_at, cancelled_at
FROM _part_requests_016_bak;

DROP TABLE _part_requests_016_bak;

CREATE INDEX idx_pr_case          ON part_requests(repair_case_id);
CREATE INDEX idx_pr_status        ON part_requests(status);
CREATE INDEX idx_pr_chave_norm    ON part_requests(chave_peca_norm);
CREATE INDEX idx_pr_source_part   ON part_requests(source_order_part_id);
CREATE INDEX idx_pr_legacy_pedido ON part_requests(legacy_id_pedido);

PRAGMA foreign_keys = ON;
PRAGMA legacy_alter_table = OFF;
