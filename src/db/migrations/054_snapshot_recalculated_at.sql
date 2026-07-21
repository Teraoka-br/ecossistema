-- Rastreia quando cada snapshot foi recalculado pela última vez.
-- Permite saber se o snapshot do dia já foi gerado/atualizado intencionalmente.
ALTER TABLE dashboard_daily_snapshots ADD COLUMN recalculated_at TEXT;
