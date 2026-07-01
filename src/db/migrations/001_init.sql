-- Migration 001 — esquema inicial.
-- Modelo de dados do Sistema de Peças (fase 1: importação + leitura).

-- =========================================================================
-- Lotes de importação (cada importação confirmada vira um snapshot das fontes)
-- =========================================================================
CREATE TABLE import_batches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_file_name   TEXT    NOT NULL,
  orders_file_name     TEXT    NOT NULL,
  analysis_file_hash   TEXT    NOT NULL,
  orders_file_hash     TEXT    NOT NULL,
  status               TEXT    NOT NULL
                         CHECK (status IN ('PREVIEW','COMPLETED','COMPLETED_WITH_WARNINGS','FAILED')),
  started_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at          TEXT,
  orders_found         INTEGER NOT NULL DEFAULT 0,
  orders_imported      INTEGER NOT NULL DEFAULT 0,
  inventory_found      INTEGER NOT NULL DEFAULT 0,
  inventory_imported   INTEGER NOT NULL DEFAULT 0,
  quotations_found     INTEGER NOT NULL DEFAULT 0,
  quotations_imported  INTEGER NOT NULL DEFAULT 0,
  analysis_found       INTEGER NOT NULL DEFAULT 0,
  analysis_imported    INTEGER NOT NULL DEFAULT 0,
  warnings_count       INTEGER NOT NULL DEFAULT 0,
  errors_count         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_import_batches_status ON import_batches(status);
CREATE INDEX idx_import_batches_hashes ON import_batches(orders_file_hash, analysis_file_hash);

-- =========================================================================
-- Problemas/avisos detectados na importação (preview e confirmação)
-- =========================================================================
CREATE TABLE import_issues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id  INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  file_name        TEXT,
  sheet_name       TEXT,
  row_number       INTEGER,
  entity_type      TEXT,
  entity_key       TEXT,
  severity         TEXT NOT NULL CHECK (severity IN ('ERROR','WARNING','CONFLICT')),
  code             TEXT NOT NULL,
  message          TEXT NOT NULL,
  raw_value        TEXT
);

CREATE INDEX idx_import_issues_batch ON import_issues(import_batch_id);
CREATE INDEX idx_import_issues_severity ON import_issues(import_batch_id, severity);

-- =========================================================================
-- Fonte: pedidos (uma linha por peça solicitada para um aparelho)
-- Identidade de linha = (id_pedido, chave_peca) dentro do snapshot.
-- id_pedido identifica o APARELHO e repete entre as peças do mesmo aparelho.
-- =========================================================================
CREATE TABLE source_order_parts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id             INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  id_pedido                   TEXT    NOT NULL,
  imei                        TEXT,
  os                          TEXT,
  concat_peca                 TEXT,
  chave_peca                  TEXT,           -- valor original (exibição)
  chave_peca_norm             TEXT,           -- normalizada (casamento/dedup)
  referencia                  TEXT,
  status_atual_legado         TEXT,           -- token canônico
  status_atual_label          TEXT,           -- rótulo amigável
  status_kit_legado           TEXT,
  prioridade_kit_legado       INTEGER,
  quantidade_pecas_aparelho   INTEGER,
  idade                       INTEGER,
  custo                       REAL,
  venda                       REAL,
  margem_legada               REAL,
  nota_idade_legada           INTEGER,
  nota_margem_legada          INTEGER,
  score_legado                INTEGER,
  ordem_consumo_legada        INTEGER,
  quantidade_estoque_legada   INTEGER,
  pecas_sem_estoque_legada    INTEGER,
  raw_json                    TEXT    NOT NULL,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (import_batch_id, id_pedido, chave_peca_norm)
);

CREATE INDEX idx_order_parts_batch ON source_order_parts(import_batch_id);
CREATE INDEX idx_order_parts_imei ON source_order_parts(import_batch_id, imei);
CREATE INDEX idx_order_parts_pedido ON source_order_parts(import_batch_id, id_pedido);
CREATE INDEX idx_order_parts_chave ON source_order_parts(import_batch_id, chave_peca_norm);
CREATE INDEX idx_order_parts_status ON source_order_parts(import_batch_id, status_atual_legado);

-- =========================================================================
-- Fonte: estoque físico (uma linha por unidade física)
-- Sem ID de unidade nos arquivos atuais: o foco é a CONTAGEM por referência.
-- A identidade permanente NUNCA é o número da linha.
-- =========================================================================
CREATE TABLE source_inventory_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id   INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  id_peca_estoque   TEXT,            -- preenchido só quando a coluna existir
  referencia        TEXT,
  referencia_norm   TEXT,
  descricao         TEXT,
  chave_peca        TEXT,
  chave_peca_norm   TEXT,
  fornecedor        TEXT,
  status_fisico     TEXT,
  snapshot_row      INTEGER,         -- posição na fonte (apenas auditoria do snapshot)
  raw_json          TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_inventory_batch ON source_inventory_items(import_batch_id);
CREATE INDEX idx_inventory_ref ON source_inventory_items(import_batch_id, referencia_norm);
CREATE INDEX idx_inventory_chave ON source_inventory_items(import_batch_id, chave_peca_norm);

-- =========================================================================
-- Fonte: cotações existentes (PEÇAS A PEDIR)
-- =========================================================================
CREATE TABLE source_quotations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id   INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  id_pedido         TEXT,
  chave_peca        TEXT,
  chave_peca_norm   TEXT,
  quantidade        REAL,
  valor_unitario    REAL,
  valor_total       REAL,
  data_cotacao      TEXT,
  status            TEXT,
  raw_json          TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_quotations_batch ON source_quotations(import_batch_id);
CREATE INDEX idx_quotations_pedido ON source_quotations(import_batch_id, id_pedido);

-- =========================================================================
-- Fonte: origem analítica (ANALISE MI: marca/modelo/cor/solicitante/peça)
-- =========================================================================
CREATE TABLE source_order_analysis (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id   INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  id_pedido         TEXT,
  imei              TEXT,
  os                TEXT,
  marca             TEXT,
  modelo            TEXT,
  cor               TEXT,
  peca_solicitada   TEXT,
  cor_na_peca       TEXT,
  data_pedido       TEXT,
  status            TEXT,
  concat_peca       TEXT,
  chave_peca_norm   TEXT,
  deposito          TEXT,
  descricao         TEXT,
  ref               TEXT,
  solicitante       TEXT,
  raw_json          TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_analysis_batch ON source_order_analysis(import_batch_id);
CREATE INDEX idx_analysis_pedido ON source_order_analysis(import_batch_id, id_pedido);

-- =========================================================================
-- Eventos operacionais (preparado; a importação NÃO cria eventos falsos).
-- Nunca é apagado por reimportação.
-- =========================================================================
CREATE TABLE operational_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  previous_status  TEXT,
  new_status       TEXT,
  responsible_name TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_entity ON operational_events(entity_type, entity_id);

-- =========================================================================
-- Bipagem futura (modelo preparado agora; sem UI nesta fase)
-- =========================================================================
CREATE TABLE count_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  responsible_name TEXT,
  status           TEXT NOT NULL DEFAULT 'OPEN',
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT
);

CREATE TABLE count_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  reference    TEXT NOT NULL,
  chave_peca   TEXT,
  source       TEXT,
  scanned_at   TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);

CREATE INDEX idx_count_scans_session ON count_scans(session_id);

-- =========================================================================
-- Motor de match (tabelas vazias para a próxima fase)
-- =========================================================================
CREATE TABLE match_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  decision_rule_id INTEGER,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  notes           TEXT
);

CREATE TABLE match_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  match_run_id   INTEGER NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  id_pedido      TEXT,
  chave_peca     TEXT,
  result_status  TEXT,
  reserved_units INTEGER NOT NULL DEFAULT 0,
  ordem_consumo  INTEGER,
  notes          TEXT
);

CREATE INDEX idx_match_results_run ON match_results(match_run_id);

-- =========================================================================
-- Regras de decisão configuráveis (margem/idade → score)
-- =========================================================================
CREATE TABLE decision_rules (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  active                 INTEGER NOT NULL DEFAULT 0,
  age_days_per_point     INTEGER NOT NULL DEFAULT 30,
  age_max_points         INTEGER NOT NULL DEFAULT 15,
  margin_per_point       REAL    NOT NULL DEFAULT 150,
  margin_allows_negative INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Política padrão vigente (a operação pode criar/ativar outras).
INSERT INTO decision_rules
  (name, active, age_days_per_point, age_max_points, margin_per_point, margin_allows_negative)
VALUES
  ('Política padrão (30d/ponto, teto 15; R$150/ponto; margem negativa pune)',
   1, 30, 15, 150, 1);
