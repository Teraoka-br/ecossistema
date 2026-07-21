-- 057: snapshots imutáveis de decisão de aprovação de cotação
-- Auditoria completa: o que estava disponível, o que foi projetado, o que foi decidido.

CREATE TABLE purchase_decision_snapshots (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  cotacao_id                  INTEGER NOT NULL REFERENCES cotacoes(id),
  snapshot_at                 TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by                  TEXT,

  -- Resultados dos dois cenários canônicos
  baseline_full_matches       INTEGER NOT NULL,
  projected_full_matches      INTEGER NOT NULL,
  incremental_full_matches    INTEGER NOT NULL,
  baseline_partial_matches    INTEGER NOT NULL,
  projected_partial_matches   INTEGER NOT NULL,
  partial_to_full_conversions INTEGER NOT NULL,

  -- Financeiro (nulo se não houver casos com dados financeiros)
  order_cost                  REAL    NOT NULL,
  projected_revenue           REAL,
  incremental_revenue         REAL,
  projected_margin            REAL,
  incremental_margin          REAL,
  margin_to_cost_ratio        REAL,
  cost_per_incremental_match  REAL,

  -- Contexto da seleção
  selected_item_count         INTEGER NOT NULL,
  selected_unit_count         INTEGER NOT NULL,

  -- Snapshot JSON completo para auditoria (lineProjections, projectedCases, etc.)
  snapshot_json               TEXT    NOT NULL
);
