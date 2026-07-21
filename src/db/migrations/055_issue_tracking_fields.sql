-- Campos de rastreamento para ciclo de vida completo do issue.
-- fix_commit: hash ou referência do commit que corrigiu o problema.
-- validated_by/at: quem e quando validou que a correção funcionou em produção.
ALTER TABLE issue_reports ADD COLUMN fix_commit TEXT;
ALTER TABLE issue_reports ADD COLUMN validated_by_user_id INTEGER REFERENCES users(id);
ALTER TABLE issue_reports ADD COLUMN validated_at TEXT;
-- Status AWAITING_TEST: correção aplicada, aguardando validação em produção.
-- Não precisa de coluna nova — o campo status TEXT aceita qualquer valor.
