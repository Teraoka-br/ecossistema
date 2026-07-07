-- Migration 024: Sincronização incremental das fontes Central de Dados
-- Tabelas _current para His, Rel. Seriais, SH OS, Demonstrativo
-- row_hash + last_seen_at em peacs_catalog
-- Contadores rows_inserted/updated/unchanged/deactivated nas tabelas de import

-- ---------------------------------------------------------------------------
-- his_current: uma linha por IMEI (consolidado)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS his_current (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  his_import_id INTEGER NOT NULL REFERENCES his_imports(id),
  imei_norm     TEXT    NOT NULL UNIQUE,
  imei_raw      TEXT,
  audited_cost  REAL,
  age_days      INTEGER,
  report_date   TEXT,
  source_line   INTEGER,
  row_hash      TEXT    NOT NULL DEFAULT '',
  last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_his_current_imei ON his_current(imei_norm);

-- ---------------------------------------------------------------------------
-- rel_seriais_current: uma linha por IMEI (consolidado; SIM preferencial)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rel_seriais_current (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_seriais_import_id INTEGER NOT NULL REFERENCES rel_seriais_imports(id),
  imei_norm             TEXT    NOT NULL UNIQUE,
  serial                TEXT,
  descricao             TEXT,
  codigo_comercial      TEXT,
  fabricante            TEXT,
  disponivel            TEXT,
  deposito_atual        TEXT,
  filial_atual          TEXT,
  row_hash              TEXT    NOT NULL DEFAULT '',
  last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rel_seriais_current_imei ON rel_seriais_current(imei_norm);

-- ---------------------------------------------------------------------------
-- sh_os_current: uma linha por OS (key = os_norm ou 'I:'||imei_norm)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sh_os_current (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sh_os_import_id INTEGER NOT NULL REFERENCES sh_os_imports(id),
  lookup_key      TEXT    NOT NULL UNIQUE,
  os_norm         TEXT,
  imei_norm       TEXT,
  os_raw          TEXT,
  imei_raw        TEXT,
  marca           TEXT,
  modelo          TEXT,
  cor             TEXT,
  defeito         TEXT,
  obs_servico     TEXT,
  row_hash        TEXT    NOT NULL DEFAULT '',
  last_seen_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sh_os_current_os_norm   ON sh_os_current(os_norm)   WHERE os_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sh_os_current_imei_norm ON sh_os_current(imei_norm) WHERE imei_norm IS NOT NULL;

-- ---------------------------------------------------------------------------
-- demonstrativo_current: uma linha por referencia_norm
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demonstrativo_current (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  demonstrativo_import_id INTEGER NOT NULL REFERENCES demonstrativo_imports(id),
  referencia_norm         TEXT    NOT NULL UNIQUE,
  referencia              TEXT,
  descricao               TEXT,
  codigo_comercial        TEXT,
  fabricante              TEXT,
  grupo                   TEXT,
  subgrupo                TEXT,
  familia                 TEXT,
  saldo                   REAL,
  row_hash                TEXT    NOT NULL DEFAULT '',
  last_seen_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_demonstrativo_current_ref ON demonstrativo_current(referencia_norm);

-- ---------------------------------------------------------------------------
-- peacs_catalog: adicionar row_hash e last_seen_at
-- ---------------------------------------------------------------------------
ALTER TABLE peacs_catalog ADD COLUMN row_hash     TEXT;
ALTER TABLE peacs_catalog ADD COLUMN last_seen_at TEXT;

-- ---------------------------------------------------------------------------
-- peacs_imports: adicionar colunas ausentes (tabela criada em 015, sem esses campos)
-- ---------------------------------------------------------------------------
ALTER TABLE peacs_imports ADD COLUMN rows_valid   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE peacs_imports ADD COLUMN updated_date TEXT;

-- ---------------------------------------------------------------------------
-- Contadores de sync nos imports
-- ---------------------------------------------------------------------------
ALTER TABLE his_imports           ADD COLUMN rows_inserted    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE his_imports           ADD COLUMN rows_updated     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE his_imports           ADD COLUMN rows_unchanged   INTEGER NOT NULL DEFAULT 0;

ALTER TABLE rel_seriais_imports   ADD COLUMN rows_inserted    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rel_seriais_imports   ADD COLUMN rows_updated     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rel_seriais_imports   ADD COLUMN rows_unchanged   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rel_seriais_imports   ADD COLUMN report_scope     TEXT    NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE sh_os_imports         ADD COLUMN rows_inserted    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sh_os_imports         ADD COLUMN rows_updated     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sh_os_imports         ADD COLUMN rows_unchanged   INTEGER NOT NULL DEFAULT 0;

ALTER TABLE peacs_imports         ADD COLUMN rows_inserted    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE peacs_imports         ADD COLUMN rows_updated     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE peacs_imports         ADD COLUMN rows_unchanged   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE peacs_imports         ADD COLUMN rows_deactivated INTEGER NOT NULL DEFAULT 0;

ALTER TABLE demonstrativo_imports ADD COLUMN rows_inserted    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demonstrativo_imports ADD COLUMN rows_updated     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demonstrativo_imports ADD COLUMN rows_unchanged   INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Data migration: popular _current a partir dos últimos imports COMPLETED
-- ---------------------------------------------------------------------------

-- his_current: última importação confirmada, deduplicado por imei_norm
INSERT OR IGNORE INTO his_current
  (his_import_id, imei_norm, imei_raw, audited_cost, age_days, report_date, source_line, row_hash, created_at)
SELECT
  r.his_import_id,
  r.imei_norm,
  r.imei,
  r.audited_cost,
  r.age_days,
  r.report_date,
  r.source_line,
  '',
  datetime('now')
FROM his_import_rows r
WHERE r.his_import_id = (
  SELECT id FROM his_imports WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1
)
AND r.id = (
  SELECT r2.id FROM his_import_rows r2
  WHERE r2.his_import_id = r.his_import_id AND r2.imei_norm = r.imei_norm
  ORDER BY r2.source_line DESC LIMIT 1
);

-- rel_seriais_current: deduplicado por imei_norm, SIM preferencial
INSERT OR IGNORE INTO rel_seriais_current
  (rel_seriais_import_id, imei_norm, serial, descricao, codigo_comercial,
   fabricante, disponivel, deposito_atual, filial_atual, row_hash, created_at)
SELECT
  r.rel_seriais_import_id,
  r.imei_norm,
  r.serial,
  r.descricao,
  r.codigo_comercial,
  r.fabricante,
  r.disponivel,
  r.deposito_atual,
  r.filial_atual,
  '',
  datetime('now')
FROM rel_seriais_rows r
WHERE r.rel_seriais_import_id = (
  SELECT id FROM rel_seriais_imports WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1
)
AND r.id = (
  SELECT r2.id FROM rel_seriais_rows r2
  WHERE r2.rel_seriais_import_id = r.rel_seriais_import_id
    AND r2.imei_norm = r.imei_norm
  ORDER BY (CASE WHEN upper(r2.disponivel) = 'SIM' THEN 0 ELSE 1 END), r2.id DESC
  LIMIT 1
);

-- sh_os_current: uma linha por lookup_key
INSERT OR IGNORE INTO sh_os_current
  (sh_os_import_id, lookup_key, os_norm, imei_norm, os_raw, imei_raw,
   marca, modelo, cor, defeito, obs_servico, row_hash, created_at)
SELECT
  r.sh_os_import_id,
  COALESCE(r.os_norm, 'I:' || r.imei_norm),
  r.os_norm,
  r.imei_norm,
  r.os_raw,
  r.imei_raw,
  r.marca,
  r.modelo,
  r.cor,
  r.defeito,
  r.obs_servico,
  '',
  datetime('now')
FROM sh_os_rows r
WHERE r.sh_os_import_id = (
  SELECT id FROM sh_os_imports WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1
)
AND (r.os_norm IS NOT NULL OR r.imei_norm IS NOT NULL);

-- demonstrativo_current: uma linha por referencia_norm
INSERT OR IGNORE INTO demonstrativo_current
  (demonstrativo_import_id, referencia_norm, referencia, descricao,
   codigo_comercial, fabricante, grupo, subgrupo, familia, saldo, row_hash, created_at)
SELECT
  r.demonstrativo_import_id,
  r.referencia_norm,
  r.referencia,
  r.descricao,
  r.codigo_comercial,
  r.fabricante,
  r.grupo,
  r.subgrupo,
  r.familia,
  r.saldo,
  '',
  datetime('now')
FROM demonstrativo_rows r
WHERE r.demonstrativo_import_id = (
  SELECT id FROM demonstrativo_imports WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1
);
