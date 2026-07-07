-- Migration 025: his_staged_rows
-- Armazena resultado do streaming do His Estoque durante o preview,
-- evitando processar o arquivo duas vezes (preview + confirmação).
-- Linhas são apagadas após confirmação, cancelamento ou expiração do staging.

CREATE TABLE IF NOT EXISTS his_staged_rows (
  staging_id   INTEGER NOT NULL REFERENCES import_staged_files(id) ON DELETE CASCADE,
  imei_norm    TEXT    NOT NULL,
  imei_raw     TEXT,
  audited_cost REAL,
  age_days     INTEGER,
  report_date  TEXT,
  source_line  INTEGER,
  row_hash     TEXT    NOT NULL,
  PRIMARY KEY  (staging_id, imei_norm)
);

CREATE INDEX IF NOT EXISTS idx_his_staged_staging ON his_staged_rows(staging_id);
