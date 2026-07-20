-- 051: Sistema de notificações persistentes por role e usuário
-- Uma notificação tem target_role (role inteira) OU target_user_id (usuário específico).
-- Leituras são rastreadas na tabela notification_reads.

CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_role     TEXT    CHECK(target_role IN ('ADMIN','OPERATOR','TECHNICIAN')),
  target_user_id  INTEGER REFERENCES users(id),
  type            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  body            TEXT,
  route           TEXT,
  entity_type     TEXT,
  entity_id       INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_role ON notifications(target_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notification_id, user_id)
);
