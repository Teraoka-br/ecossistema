-- Justificativas para dias sem contagem
CREATE TABLE IF NOT EXISTS counting_day_justifications (
  date          TEXT PRIMARY KEY,  -- YYYY-MM-DD
  justification TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
