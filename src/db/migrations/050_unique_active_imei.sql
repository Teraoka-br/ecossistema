-- Impede dois repair_cases ativos para o mesmo IMEI.
-- Casos concluídos/cancelados/venda não participam da constraint,
-- permitindo que o mesmo aparelho volte para uma nova OS no futuro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_cases_active_imei
ON repair_cases(imei_norm)
WHERE imei_norm IS NOT NULL
  AND workflow_status NOT IN ('CONCLUIDO', 'CANCELADO', 'VENDA_ESTADO');
