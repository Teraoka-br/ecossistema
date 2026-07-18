-- Migration 043 — Reclassifica piores pontuadores para VENDA_ESTADO
--
-- Critérios (qualquer um é suficiente):
--   • margem negativa (margin < 0)
--   • mais de 2 anos de idade (age_days > 730)
--   • depósito contém "VENDA" (ex: "VENDA NO ESTADO")
--
-- Não toca em casos já terminais (CONCLUIDO, CANCELADO, VENDA_ESTADO)
-- nem casos com técnico ativo (DIRECIONADO_TECNICO..RETORNO_TECNICO).

UPDATE repair_cases
SET workflow_status = 'VENDA_ESTADO',
    updated_at      = datetime('now')
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
