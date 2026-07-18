-- Recalcula margin = estimated_sale - cost para todos os casos onde ambos estão
-- preenchidos mas o valor armazenado diverge da conta (dados legados do Excel
-- que tinham fórmula diferente, ou edições de custo/venda sem recálculo).
UPDATE repair_cases
SET margin = estimated_sale - cost, updated_at = datetime('now')
WHERE cost IS NOT NULL
  AND estimated_sale IS NOT NULL
  AND ABS(margin - (estimated_sale - cost)) > 0.01;
