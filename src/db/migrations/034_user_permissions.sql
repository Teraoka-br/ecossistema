-- Migration 034 — permissões granulares por usuário
-- Permite conceder capacidades específicas a usuários sem elevar seu role.
-- Permissões conhecidas:
--   OVERRIDE_REPAIR_STATUS — alterar fase do aparelho manualmente com justificativa

CREATE TABLE user_permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT    NOT NULL,
  granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, permission)
);

CREATE INDEX idx_user_permissions_user ON user_permissions(user_id);
