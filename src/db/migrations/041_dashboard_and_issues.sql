-- Migration 041 — Home operacional: snapshots diários + central de problemas
--
-- 1. dashboard_daily_snapshots: agregados por dia para histórico e gráficos.
--    Idempotente: UPSERT por snapshot_date.
-- 2. issue_reports: registro de bugs/problemas operacionais reportados pelos usuários.

CREATE TABLE IF NOT EXISTS dashboard_daily_snapshots (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date             TEXT    NOT NULL,          -- 'YYYY-MM-DD' no fuso America/Sao_Paulo
  timezone                  TEXT    NOT NULL DEFAULT 'America/Sao_Paulo',

  -- Casos de reparo
  total_cases               INTEGER NOT NULL DEFAULT 0,
  total_unique_imeis        INTEGER NOT NULL DEFAULT 0,

  -- Status de match (part_requests)
  match_count               INTEGER NOT NULL DEFAULT 0,
  match_partial_count       INTEGER NOT NULL DEFAULT 0,
  apto_reparo_count         INTEGER NOT NULL DEFAULT 0,
  verificar_count           INTEGER NOT NULL DEFAULT 0,
  em_analise_count          INTEGER NOT NULL DEFAULT 0,
  aguardando_peca_count     INTEGER NOT NULL DEFAULT 0,
  com_tecnico_count         INTEGER NOT NULL DEFAULT 0,
  finalizados_count         INTEGER NOT NULL DEFAULT 0,

  -- Estoque
  stock_total_units         INTEGER NOT NULL DEFAULT 0,
  stock_total_references    INTEGER NOT NULL DEFAULT 0,
  stock_available_units     INTEGER NOT NULL DEFAULT 0,
  stock_reserved_units      INTEGER NOT NULL DEFAULT 0,

  -- Contagens
  counting_sessions_count   INTEGER NOT NULL DEFAULT 0,

  -- Metadata extra (JSON livre para campos adicionais)
  metadata_json             TEXT,

  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_dashboard_snapshots_date
  ON dashboard_daily_snapshots (snapshot_date);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issue_reports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  title                 TEXT    NOT NULL,
  description           TEXT,
  module                TEXT    NOT NULL DEFAULT 'OUTRO'
                          CHECK (module IN ('DASHBOARD','FILA_REPAROS','ANALISE','ESTOQUE',
                                            'REFERENCIAS','PEDIDOS','CONTAGEM','MATCH_RULES',
                                            'USUARIOS','OUTRO')),
  severity              TEXT    NOT NULL DEFAULT 'MEDIUM'
                          CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                TEXT    NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN','IN_ANALYSIS','RESOLVED','DISMISSED')),
  created_by_user_id    INTEGER REFERENCES users(id),
  created_by_name       TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at           TEXT,
  resolved_by_user_id   INTEGER REFERENCES users(id),
  resolution_notes      TEXT,
  metadata_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_issue_reports_status   ON issue_reports (status);
CREATE INDEX IF NOT EXISTS idx_issue_reports_severity ON issue_reports (severity);
CREATE INDEX IF NOT EXISTS idx_issue_reports_created  ON issue_reports (created_by_user_id);
