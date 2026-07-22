-- 056: Adiciona status AWAITING_TEST à tabela issue_reports.
-- Recuperada: esta migration foi aplicada no banco beta mas o arquivo
-- estava ausente no repositório. O CHECK constraint já inclui o valor
-- na tabela existente, então esta migration é idempotente via IF NOT EXISTS
-- e guards no runner.

-- A migration original adicionou AWAITING_TEST ao CHECK de status.
-- Como o CHECK já está aplicado no banco, esta é apenas a documentação
-- do que foi feito. Em bancos novos, a migration 055 já cria a tabela
-- sem este status, então recriamos o CHECK aqui.

-- SQLite não suporta ALTER TABLE para modificar CHECK constraints diretamente.
-- A tabela já foi recriada com o novo CHECK no banco beta.
-- Para bancos novos onde 055 foi aplicada sem AWAITING_TEST, esta migration
-- recria a tabela com o CHECK correto.

PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

CREATE TABLE IF NOT EXISTS issue_reports_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  title                 TEXT    NOT NULL,
  description           TEXT,
  module                TEXT    NOT NULL DEFAULT 'OUTRO',
  severity              TEXT    NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                TEXT    NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_ANALYSIS','AWAITING_TEST','RESOLVED','DISMISSED')),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name       TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at           TEXT,
  resolved_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes      TEXT,
  metadata_json         TEXT,
  fix_commit            TEXT,
  validated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_at          TEXT
);

INSERT OR IGNORE INTO issue_reports_new
  SELECT * FROM issue_reports;

DROP TABLE IF EXISTS issue_reports;
ALTER TABLE issue_reports_new RENAME TO issue_reports;

PRAGMA foreign_keys = ON;
PRAGMA legacy_alter_table = OFF;
