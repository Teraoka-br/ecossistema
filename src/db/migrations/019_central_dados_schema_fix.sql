-- Migration 019 — Central de Dados: esquema corrigido para todos os 7 cards.
--
-- Adds:
--   import_staged_files          — staging persistente (substitui Map em memória)
--   analise_mi_imports/rows      — Card 3: ANALISE MI ativa (não legado)
--   pedidos_imports/rows         — Card 4: PEDIDOS aba + BIPAGEM snapshot
--   central_import_issues        — log de problemas (todas as fontes, sem CHECK fixo)
-- Extends:
--   repair_cases                 — depot, filial
--   his_import_rows              — age_days
--   rel_seriais_rows             — colunas reais do CSV (Serial, Produto, etc.)
--   triagem_saida_rows           — repair_effective, motivo, apsn, datas

-- =========================================================================
-- import_staged_files — staging de arquivos pendentes (resistente a reinício)
-- =========================================================================
CREATE TABLE import_staged_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  import_id   INTEGER NOT NULL,
  staged_path TEXT    NOT NULL,
  file_hash   TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, import_id)
);
CREATE INDEX idx_staged_source ON import_staged_files(source);

-- =========================================================================
-- repair_cases: adicionar depot e filial para Card 2
-- =========================================================================
ALTER TABLE repair_cases ADD COLUMN depot  TEXT;
ALTER TABLE repair_cases ADD COLUMN filial TEXT;

-- =========================================================================
-- his_import_rows: adicionar age_days (Dias em Estoque)
-- =========================================================================
ALTER TABLE his_import_rows ADD COLUMN age_days INTEGER;

-- =========================================================================
-- rel_seriais_rows: colunas reais do CSV datasys
-- (old cols imei/technician_name/age_days/cost ficam como deprecated)
-- =========================================================================
ALTER TABLE rel_seriais_rows ADD COLUMN serial        TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN produto       TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN descricao     TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN deposito_atual TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN filial_atual  TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN disponivel    TEXT;
ALTER TABLE rel_seriais_rows ADD COLUMN dias_estoque  INTEGER;

-- =========================================================================
-- triagem_saida_rows: colunas do TRIAGEM SAIDA.xlsx
-- =========================================================================
ALTER TABLE triagem_saida_rows ADD COLUMN concat_key     TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN apsn           TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN data_reparo    TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN data_triagem   TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN repair_effective TEXT;  -- SIM | NÃO
ALTER TABLE triagem_saida_rows ADD COLUMN motivo         TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN assistencia    TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN triador        TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN manutencao     TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN tipo_reparo    TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN estoque_destino TEXT;
ALTER TABLE triagem_saida_rows ADD COLUMN tecnico        TEXT;

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
  rows_created        INTEGER NOT NULL DEFAULT 0,
  rows_updated        INTEGER NOT NULL DEFAULT 0,
  rows_skipped        INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_analise_mi_hash ON analise_mi_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_analise_mi_created ON analise_mi_imports(created_at);

-- =========================================================================
-- analise_mi_rows — uma linha por solicitação do ANALISE MI
-- =========================================================================
CREATE TABLE analise_mi_rows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  analise_mi_import_id  INTEGER NOT NULL REFERENCES analise_mi_imports(id) ON DELETE CASCADE,
  id_pedido             TEXT,
  imei                  TEXT,
  imei_norm             TEXT,
  os                    TEXT,
  os_norm               TEXT,
  brand                 TEXT,
  model                 TEXT,
  color                 TEXT,
  peca_solicitada       TEXT,
  concat_peca           TEXT,
  status_src            TEXT,
  deposito_src          TEXT,
  ref_peca              TEXT,
  solicitante           TEXT,
  raw_data_json         TEXT,
  part_request_id       INTEGER REFERENCES part_requests(id) ON DELETE SET NULL,
  action                TEXT,  -- CREATED | UPDATED | SKIPPED | ERROR
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_analise_mi_rows_import ON analise_mi_rows(analise_mi_import_id);
CREATE INDEX idx_analise_mi_rows_idped  ON analise_mi_rows(id_pedido);
CREATE INDEX idx_analise_mi_rows_pr     ON analise_mi_rows(part_request_id);

-- =========================================================================
-- pedidos_imports — cabeçalho de importações do PEDIDOS.xlsx (3 abas)
-- =========================================================================
CREATE TABLE pedidos_imports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  filename              TEXT    NOT NULL,
  file_hash             TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  -- Aba PEDIDOS
  pedidos_rows_found    INTEGER NOT NULL DEFAULT 0,
  pedidos_updated       INTEGER NOT NULL DEFAULT 0,
  -- Aba BIPAGEM DE PEÇAS (snapshot)
  bipagem_rows_found    INTEGER NOT NULL DEFAULT 0,
  bipagem_applied       INTEGER NOT NULL DEFAULT 0,
  -- Aba PEACS (catálogo)
  peacs_rows_found      INTEGER NOT NULL DEFAULT 0,
  peacs_entries_updated INTEGER NOT NULL DEFAULT 0,
  issues_count          INTEGER NOT NULL DEFAULT 0,
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at           TEXT
);
CREATE UNIQUE INDEX idx_pedidos_imports_hash ON pedidos_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_pedidos_imports_created ON pedidos_imports(created_at);

-- =========================================================================
-- pedidos_reconciliation_rows — resultado da aba PEDIDOS (status sync)
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
  part_request_id     INTEGER REFERENCES part_requests(id) ON DELETE SET NULL,
  action              TEXT,  -- UPDATED | SKIPPED | NOT_FOUND
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ped_recon_import ON pedidos_reconciliation_rows(pedidos_import_id);
CREATE INDEX idx_ped_recon_idped  ON pedidos_reconciliation_rows(id_pedido);

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
  rows_inserted       INTEGER NOT NULL DEFAULT 0,
  rows_updated        INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_sh_cat_hash ON sh_catalog_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_sh_cat_created ON sh_catalog_imports(created_at);

-- =========================================================================
-- sh_catalog_rows — uma linha por item do catálogo SH
-- =========================================================================
CREATE TABLE sh_catalog_rows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  sh_catalog_import_id  INTEGER NOT NULL REFERENCES sh_catalog_imports(id) ON DELETE CASCADE,
  codigo                TEXT,       -- CODIGO: identificador único do item
  numero                TEXT,
  nome                  TEXT,
  nomecurto             TEXT,
  grupo                 TEXT,
  subgrupo              TEXT,
  fabricante            TEXT,
  estoque_disp          REAL,       -- saldo comparativo SH (não operacional)
  custo                 REAL,
  venda                 REAL,
  fornecedor            TEXT,
  local                 TEXT,
  gaveta                TEXT,
  arquivado             TEXT,
  gtin                  TEXT,
  usa_serial            TEXT,
  raw_data_json         TEXT,
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sh_cat_rows_import ON sh_catalog_rows(sh_catalog_import_id);
CREATE INDEX idx_sh_cat_rows_codigo ON sh_catalog_rows(codigo);

-- =========================================================================
-- central_import_issues — log genérico de problemas (todas as fontes)
-- =========================================================================
CREATE TABLE central_import_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,  -- SH|HIS|REL_SERIAIS|BKP|TRIAGEM_SAIDA|ANALISE_MI|PEDIDOS
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
