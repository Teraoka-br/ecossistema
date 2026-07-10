-- Adiciona tipo de sessão de contagem: OFICIAL (padrão) ou PARCIAL_TESTE.
-- PARCIAL_TESTE pula o bloqueio de 80% e não zera referências não contadas.
ALTER TABLE count_sessions ADD COLUMN count_type TEXT NOT NULL DEFAULT 'OFICIAL';
