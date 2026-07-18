-- Migration 044 — creation_source em repair_cases + deduplicação de IMEI

-- 1. Campo que indica como o card foi criado
ALTER TABLE repair_cases ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'IMPORT'
  CHECK (creation_source IN ('IMPORT','MANUAL','DATASYS'));

-- Backfill: se tem legacy_import_batch_id → IMPORT; se não tem mas tem os → MANUAL
UPDATE repair_cases
SET creation_source = CASE
  WHEN legacy_import_batch_id IS NOT NULL THEN 'IMPORT'
  ELSE 'MANUAL'
END;

-- 2. Marcar como VERIFICAR os casos duplicados por IMEI
--    Critério: mesmo imei_norm, mais de um caso ativo, mantém o mais novo (maior id)
UPDATE repair_cases
SET workflow_status = 'VERIFICAR',
    updated_at = datetime('now')
WHERE imei_norm IS NOT NULL
  AND workflow_status NOT IN ('ENTREGUE','CANCELADO','VENDA_ESTADO','VERIFICAR')
  AND id NOT IN (
    SELECT MAX(id)
    FROM repair_cases
    WHERE imei_norm IS NOT NULL
      AND workflow_status NOT IN ('ENTREGUE','CANCELADO','VENDA_ESTADO')
    GROUP BY imei_norm
    HAVING COUNT(*) > 1
  )
  AND imei_norm IN (
    SELECT imei_norm
    FROM repair_cases
    WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO','VENDA_ESTADO')
    GROUP BY imei_norm
    HAVING COUNT(*) > 1
  );
