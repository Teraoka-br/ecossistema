-- 032: tabelas de cotação de compra
-- Fluxo: necessidades (PEDIR_PECA) → export CSV → fornecedor preenche preços
-- → upload → aprovação → purchase_order

CREATE TABLE cotacoes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'PENDING_APPROVAL'
              CHECK (status IN ('PENDING_APPROVAL','APPROVED','CANCELLED')),
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT,
  approved_at TEXT,
  approved_by TEXT,
  purchase_order_id INTEGER REFERENCES purchase_orders(id)
);

CREATE TABLE cotacao_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cotacao_id        INTEGER NOT NULL REFERENCES cotacoes(id),
  chave_peca        TEXT    NOT NULL,
  qtde              INTEGER NOT NULL,
  valor_unitario    REAL    NOT NULL,
  aprovado          INTEGER NOT NULL DEFAULT 1 CHECK (aprovado IN (0,1)),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
