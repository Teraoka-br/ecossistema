-- Histórico de edições de referências de peças (CHAVEPECAs)
CREATE TABLE IF NOT EXISTS part_key_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chave_peca_norm TEXT NOT NULL,         -- chave normalizada no momento da edição (identificador permanente do histórico)
  field_changed TEXT NOT NULL,           -- 'chave_peca' | 'descricao'
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT,
  edited_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_part_key_edits_norm ON part_key_edits(chave_peca_norm);
