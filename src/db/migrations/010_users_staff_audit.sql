-- Migration 010 — usuários, sessões, técnicos e audit log.
--
-- PIN armazenado como hash (scrypt); token de sessão armazenado como hash
-- (sha256). Nenhum dado sensível em texto puro.
-- Papéis: ADMIN | OPERATOR (sem restrição de funcionalidade nesta fase).

-- =========================================================================
-- users
-- =========================================================================
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT    NOT NULL,
  pin_hash     TEXT    NOT NULL,  -- scrypt(pin, salt) codificado como string
  role         TEXT    NOT NULL DEFAULT 'OPERATOR'
                 CHECK (role IN ('ADMIN','OPERATOR')),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- =========================================================================
-- user_sessions
-- =========================================================================
CREATE TABLE user_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,  -- sha256(raw_token) em hex
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);

CREATE INDEX idx_user_sessions_user   ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_token  ON user_sessions(token_hash);
CREATE INDEX idx_user_sessions_expiry ON user_sessions(expires_at) WHERE revoked_at IS NULL;

-- =========================================================================
-- staff_members — técnicos e outros colaboradores (sem login)
-- =========================================================================
CREATE TABLE staff_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'TECHNICIAN'
               CHECK (type IN ('TECHNICIAN')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- =========================================================================
-- audit_log — ações auditáveis do sistema
-- =========================================================================
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  metadata_json TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_user      ON audit_log(user_id);
CREATE INDEX idx_audit_action    ON audit_log(action);
CREATE INDEX idx_audit_entity    ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created   ON audit_log(created_at);
