-- Migration 035 — catálogo de chaves de peça criadas manualmente
-- Chaves aqui são reconhecidas pelo autocomplete de bipagem e pela validação
-- de resolução de pendências, mesmo não existindo no legado importado.

CREATE TABLE custom_part_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chave_peca      TEXT    NOT NULL UNIQUE,
  chave_peca_norm TEXT    NOT NULL UNIQUE,
  descricao       TEXT,
  created_by      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_custom_part_keys_norm ON custom_part_keys(chave_peca_norm);
