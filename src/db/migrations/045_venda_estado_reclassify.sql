-- Reclassifica como VENDA_ESTADO os casos que atendem critérios de baixo valor
-- (margem negativa, idade > 730 dias ou depósito contendo "VENDA"),
-- exceto casos já finalizados ou que estejam ativos com técnico.
UPDATE repair_cases
SET workflow_status = 'VENDA_ESTADO', updated_at = datetime('now')
WHERE workflow_status NOT IN (
    'CONCLUIDO','CANCELADO','VENDA_ESTADO',
    'DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO',
    'TRIAGEM_FINAL','RETORNO_TECNICO'
  )
  AND (
    (margin IS NOT NULL AND margin < 0)
    OR (age_days IS NOT NULL AND age_days > 730)
    OR (deposito_atual IS NOT NULL AND deposito_atual LIKE '%VENDA%')
  );
