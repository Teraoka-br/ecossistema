-- Adiciona coluna venda_estado_count ao snapshot diário
ALTER TABLE dashboard_daily_snapshots ADD COLUMN venda_estado_count INTEGER NOT NULL DEFAULT 0;
