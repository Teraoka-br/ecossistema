-- 061: Override manual de custo por chave de peça.
-- Enquanto ativo, o override tem precedência na resolução de custo.
-- Restauração não apaga a linha: desativa com auditoria (restored_*).

CREATE TABLE part_cost_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chave_peca_norm TEXT NOT NULL,
  unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
  previous_resolved_cost REAL,
  justification TEXT NOT NULL,
  valid_until TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1,
  restored_by TEXT,
  restored_at TEXT,
  restore_reason TEXT
);

CREATE INDEX idx_part_cost_overrides_chave ON part_cost_overrides(chave_peca_norm);
CREATE UNIQUE INDEX idx_part_cost_overrides_active
  ON part_cost_overrides(chave_peca_norm) WHERE active = 1;
