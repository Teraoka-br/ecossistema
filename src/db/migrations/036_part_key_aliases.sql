-- Migration 036 — Aliases de compatibilidade de chave de peça para o motor de match
-- Permite que uma chave solicitada no pedido (ex: "BATERIA IPHONE 12") seja resolvida
-- para a chave correspondente no estoque (ex: "BATERIA IPHONE 12/12 PRO") sem alterar
-- o histórico original da solicitação.

CREATE TABLE part_key_aliases (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_chave_peca      TEXT    NOT NULL,
  requested_chave_peca_norm TEXT    NOT NULL,
  stock_chave_peca          TEXT    NOT NULL,
  stock_chave_peca_norm     TEXT    NOT NULL,
  reason                    TEXT,
  active                    INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_part_key_aliases_unique
  ON part_key_aliases(requested_chave_peca_norm, stock_chave_peca_norm)
  WHERE active = 1;

CREATE INDEX idx_part_key_aliases_requested ON part_key_aliases(requested_chave_peca_norm);

-- Registra chave do alias usada quando a alocação foi via alias (NULL = alocação direta)
ALTER TABLE repair_match_results ADD COLUMN alias_stock_chave_norm TEXT;
