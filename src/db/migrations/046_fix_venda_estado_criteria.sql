-- Corrige classificação errada da migration 045:
-- Apenas casos com margem negativa confirmada pertencem a VENDA_ESTADO.
-- Casos que foram para lá por idade > 730 dias ou depósito "VENDA" sem margem
-- calculada não foram avaliados pelo motor — vão para VERIFICAR.
UPDATE repair_cases
SET workflow_status = 'VERIFICAR', updated_at = datetime('now')
WHERE workflow_status = 'VENDA_ESTADO'
  AND (margin IS NULL OR margin >= 0);
