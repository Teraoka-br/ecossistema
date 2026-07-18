-- Após recálculo de margem (047), casos em VENDA_ESTADO com margem positiva
-- foram classificados erroneamente por dados legados incorretos do Excel.
-- Voltam para VERIFICAR para serem reavaliados pelo motor.
UPDATE repair_cases
SET workflow_status = 'VERIFICAR', updated_at = datetime('now')
WHERE workflow_status = 'VENDA_ESTADO'
  AND (margin IS NULL OR margin >= 0);
