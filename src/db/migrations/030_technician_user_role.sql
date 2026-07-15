-- Migration 028 — Adiciona role TECHNICIAN a users + vincula staff_members a contas de usuário.
--
-- Estratégia (mesma de 016): SQLite não tem ALTER TABLE MODIFY COLUMN.
-- Recria users com CHECK expandido usando PRAGMA foreign_keys = OFF +
-- PRAGMA legacy_alter_table = ON (fora de BEGIN, via runner).
-- FKs em user_sessions e audit_log continuam funcionando porque os IDs são preservados.

PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

-- =========================================================================
-- 1. Reconstruir users com CHECK role expandido
-- =========================================================================
ALTER TABLE users RENAME TO _users_028_bak;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  pin_hash      TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'OPERATOR'
                  CHECK (role IN ('ADMIN','OPERATOR','TECHNICIAN')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

INSERT INTO users SELECT * FROM _users_028_bak;
DROP TABLE _users_028_bak;

-- =========================================================================
-- 2. Vincular staff_members a contas de usuário (opcional, único por usuário)
-- =========================================================================
-- SQLite não permite ADD COLUMN UNIQUE; o índice é criado separadamente.
-- WHERE user_id IS NOT NULL: múltiplos técnicos sem conta ainda são permitidos.
ALTER TABLE staff_members ADD COLUMN user_id INTEGER REFERENCES users(id);
CREATE UNIQUE INDEX uidx_staff_user_id ON staff_members(user_id) WHERE user_id IS NOT NULL;
