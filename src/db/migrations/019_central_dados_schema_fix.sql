-- Migration 019 — Central de Dados: esquema corrigido para todos os 7 cards.
--
-- Revisa e expande o esquema original (nunca aplicado ao banco operacional):
--   import_staged_files      — staging persistente com ciclo de vida completo
--   analise_mi_imports/rows  — Card 3: ANALISE MI como fonte ativa (não legado)
--   pedidos_imports/rows     — Card 4: PEDIDOS 3 abas (reconciliação + BIPAGEM + PEACS)
--   pedidos_bipagem_rows     — snapshot de unidades físicas da aba BIPAGEM
--   sh_catalog_imports/rows  — Card 7: catálogo SH (CODIGO-based, não ordens de serviço)
--   central_import_issues    — log genérico sem CHECK fixo de fonte
-- Estende tabelas de 015/018:
--   his_import_rows          — age_days
--   rel_seriais_rows         — colunas reais do CSV datasys
--   triagem_saida_rows       — concat_key, repair_effective, motivo, datas, tecnico

-- =========================================================================
-- import_staged_files — staging persistente (substitui Map em memória)
-- Ciclo: UPLOADED → PREVIEW_READY → CONFIRMED | FAILED | CANCELLED | EXPIRED
-- =========================================================================
CREATE TABLE import_staged_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,
  filename        TEXT    NOT NULL,
  file_hash       TEXT    NOT NULL,
  staged_path     TEXT    NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'UPLOADED'
                    CHECK (status IN ('UPLOADED','PREVIEW_READY','CONFIRMED','FAILED','CANCELLED','EXPIRED')),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT    NOT NULL DEFAULT (datetime('now','+4 hours')),
  preview_json    TEXT,   -- resultado da prévia (JSON serializado)
  error           TEXT,   -- mensagem de erro quando status=FAILED
  confirmed_at    TEXT,   -- preenchido quando status=CONFIRMED
  import_id_created INTEGER -- id do registro de importação criado na confirmação
);
CREATE INDEX idx_staged_source   ON import_staged_files(source);
CREATE INDEX idx_staged_hash     ON import_staged_files(file_hash, source);
CREATE INDEX idx_staged_status   ON import_staged_files(status);
CREATE INDEX idx_staged_expires  ON import_staged_files(expires_at);

-- =========================================================================
-- his_import_rows: adicionar age_days (Dias em Estoque) e source_line
-- =========================================================================
ALTER TABLE his_import_rows ADD COLUMN age_days    INTEGER;
ALTER TABLE his_import_rows ADD COLUMN source_line INTEGER;  -- linha da planilha de origem

-- =========================================================================
-- rel_seriais_rows: colunas reais do CSV datasys
-- (cols antigas imei/technician_name/age_days/cost permanecem por compatibilidade)
-- =========================================================================
ALTER TABLE rel_seriais_rows ADD COLUMN serial         TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN produto        TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN descricao      TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN codigo_comercial TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN fabricante     TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN disponivel     TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN deposito_atual TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN filial_atual   TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN filial_entrada TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN rfid           TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN ean            TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN dias_estoque   INTEGER;

-- =========================================================================
-- triagem_saida_rows: colunas completas do TRIAGEM SAIDA.xlsx
-- =========================================================================
ALTER TABLE triagem_saida_rows ADD COLUMN concat_key      TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN apsn            TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN data_reparo     TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN data_triagem    TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN repair_effective TEXT;   -- SIM | NÃO
ALTER TABLE triagem_saida_rows ADD COLUMN motivo          TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN assistencia     TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN triador         TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN manutencao      TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN tipo_reparo     TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN estoque_destino TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN tecnico         TEXT;

CREATE INDEX idx_triagem_saida_concat ON triagem_saida_rows(concat_key);

-- =========================================================================
-- analise_mi_imports — cabeçalho de importações do ANALISE MI
-- =========================================================================
CREATE TABLE analise_mi_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_analise_mi_hash ON analise_mi_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_analise_mi_created ON analise_mi_imports(created_at);

-- =========================================================================
-- analise_mi_rows — uma linha por solicitação persistida do ANALISE MI
-- =========================================================================
CREATE TABLE analise_mi_rows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  analise_mi_import_id  INTEGER NOT NULL REFERENCES analise_mi_imports(id) ON DELETE CASCADE,
  id_pedido             TEXT,
  imei                  TEXT,
  imei_norm             TEXT,
  os                    TEXT,
  brand                 TEXT,
  model                 TEXT,
  color                 TEXT,
  peca_solicitada       TEXT,
  cor_na_peca           TEXT,
  concat_peca           TEXT,
  data_pedido           TEXT,
  status_src            TEXT,
  deposito_src          TEXT,
  descricao             TEXT,
  ref_peca              TEXT,
  solicitante           TEXT,
  raw_data_json         TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ami_rows_import ON analise_mi_rows(analise_mi_import_id);
CREATE INDEX idx_ami_rows_idped  ON analise_mi_rows(id_pedido);
CREATE INDEX idx_ami_rows_imei   ON analise_mi_rows(imei_norm);

-- =========================================================================
-- pedidos_imports — cabeçalho para importações do PEDIDOS.xlsx (3 abas)
-- =========================================================================
CREATE TABLE pedidos_imports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  filename              TEXT    NOT NULL,
  file_hash             TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  pedidos_rows_found    INTEGER NOT NULL DEFAULT 0,
  bipagem_rows_found    INTEGER NOT NULL DEFAULT 0,
  bipagem_refs_unique   INTEGER NOT NULL DEFAULT 0,
  peacs_rows_found      INTEGER NOT NULL DEFAULT 0,
  issues_count          INTEGER NOT NULL DEFAULT 0,
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at           TEXT
);
CREATE UNIQUE INDEX idx_pedidos_imports_hash ON pedidos_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_pedidos_imports_created ON pedidos_imports(created_at);

-- =========================================================================
-- pedidos_reconciliation_rows — aba PEDIDOS (reconciliação de status)
-- =========================================================================
CREATE TABLE pedidos_reconciliation_rows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  pedidos_import_id   INTEGER NOT NULL REFERENCES pedidos_imports(id) ON DELETE CASCADE,
  id_pedido           TEXT,
  imei                TEXT,
  imei_norm           TEXT,
  os                  TEXT,
  status_src          TEXT,
  chave_peca          TEXT,
  ref_peca            TEXT,
  raw_data_json       TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ped_recon_import ON pedidos_reconciliation_rows(pedidos_import_id);
CREATE INDEX idx_ped_recon_idped  ON pedidos_reconciliation_rows(id_pedido);

-- =========================================================================
-- pedidos_bipagem_rows — snapshot da aba BIPAGEM DE PEÇAS
-- =========================================================================
CREATE TABLE pedidos_bipagem_rows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  pedidos_import_id   INTEGER NOT NULL REFERENCES pedidos_imports(id) ON DELETE CASCADE,
  referencia          TEXT,
  referencia_corr     TEXT,   -- ARRUMAR quando preenchido, senão igual a referencia
  descricao           TEXT,
  fornecedor          TEXT,
  chave_peca          TEXT,
  chave_peca_norm     TEXT,
  status_src          TEXT,
  id_peca_estoque     TEXT,
  raw_data_json       TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bipagem_import    ON pedidos_bipagem_rows(pedidos_import_id);
CREATE INDEX idx_bipagem_chave     ON pedidos_bipagem_rows(chave_peca_norm);

-- =========================================================================
-- sh_catalog_imports — cabeçalho de importações do catálogo SH (peças)
-- =========================================================================
CREATE TABLE sh_catalog_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_sh_cat_hash ON sh_catalog_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_sh_cat_created ON sh_catalog_imports(created_at);

-- =========================================================================
-- sh_catalog_rows — um item por linha do catálogo SH
-- =========================================================================
CREATE TABLE sh_catalog_rows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  sh_catalog_import_id  INTEGER NOT NULL REFERENCES sh_catalog_imports(id) ON DELETE CASCADE,
  codigo                TEXT,
  numero                TEXT,
  nome                  TEXT,
  nomecurto             TEXT,
  grupo                 TEXT,
  subgrupo              TEXT,
  fabricante            TEXT,
  estoque_disp          REAL,
  custo                 REAL,
  venda                 REAL,
  fornecedor            TEXT,
  local                 TEXT,
  gaveta                TEXT,
  arquivado             TEXT,
  gtin                  TEXT,
  usa_serial            TEXT,
  raw_data_json         TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sh_cat_rows_import ON sh_catalog_rows(sh_catalog_import_id);
CREATE INDEX idx_sh_cat_rows_codigo ON sh_catalog_rows(codigo);

-- =========================================================================
-- central_import_issues — log de issues de qualquer fonte da Central de Dados
-- =========================================================================
CREATE TABLE central_import_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  import_id   INTEGER NOT NULL,
  row_number  INTEGER,
  severity    TEXT    NOT NULL CHECK (severity IN ('ERROR','WARNING','INFO')),
  code        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  raw_value   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cii_import  ON central_import_issues(source, import_id);
CREATE INDEX idx_cii_code    ON central_import_issues(code);
