-- Migration 039 — Correções da auditoria externa (quatro falhas pré-deploy)
--
-- 1. Grupos de compatibilidade simétrica: substituem aliases direcionais.
--    Uma chave pertence a no máximo um grupo ativo. Todos os membros do grupo
--    são intercompatíveis; o motor tenta cada membro com saldo disponível.
--
-- 2. Prioridade manual configurável: match_rule_sets.manual_priority_enabled
--    (default 0 / false). Antes exigia flag explícito no deploy para ser real.
--    O banco atual tem 0 prioridades manuais ativas — impacto zero imediato.
--
-- NOTA: part_key_aliases (036) é mantida como histórico — o motor deixa de
-- consultá-la a partir desta versão. Não é apagada para preservar rastreabilidade.

-- Grupos de compatibilidade simétrica ─────────────────────────────────────────

CREATE TABLE part_compatibility_groups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE part_compatibility_group_members (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id            INTEGER NOT NULL REFERENCES part_compatibility_groups(id) ON DELETE CASCADE,
  chave_peca          TEXT NOT NULL,
  chave_peca_norm     TEXT NOT NULL,
  added_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at            TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at          TEXT,
  removed_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Uma chave só pode pertencer a um grupo ativo de cada vez (simétrico real).
CREATE UNIQUE INDEX idx_pcgm_key_active
  ON part_compatibility_group_members(chave_peca_norm)
  WHERE removed_at IS NULL;

CREATE UNIQUE INDEX idx_pcgm_group_key_active
  ON part_compatibility_group_members(group_id, chave_peca_norm)
  WHERE removed_at IS NULL;

CREATE INDEX idx_pcgm_group ON part_compatibility_group_members(group_id);
CREATE INDEX idx_pcgm_key   ON part_compatibility_group_members(chave_peca_norm);

-- Prioridade manual configurável ──────────────────────────────────────────────

ALTER TABLE match_rule_sets
  ADD COLUMN manual_priority_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (manual_priority_enabled IN (0,1));

-- MANAGE_PART_COMPATIBILITY: permissão granular para gerenciar grupos de
-- compatibilidade sem precisar ser ADMIN. Concedida via API de permissões.
-- (Apenas documentado aqui; a tabela user_permissions já existe desde 034.)
