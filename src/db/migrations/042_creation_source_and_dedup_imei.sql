-- Migration 042 — creation_source em repair_cases + dedup IMEI ativo → VERIFICAR
--
-- 1. creation_source: registra como o card foi criado (IMPORT, MANUAL, DATASYS).
--    Backfill: se tem legacy_import_batch_id → IMPORT, senão → MANUAL.
-- 2. IMEIs duplicados entre casos ATIVOS: mantém o mais recente (MAX id),
--    move os anteriores para VERIFICAR para João analisar.

ALTER TABLE repair_cases ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'IMPORT'
  CHECK (creation_source IN ('IMPORT','MANUAL','DATASYS'));

-- Backfill: casos com batch de importação → IMPORT, demais → MANUAL
UPDATE repair_cases
SET creation_source = CASE
  WHEN legacy_import_batch_id IS NOT NULL THEN 'IMPORT'
  ELSE 'MANUAL'
END;

-- Dedup IMEI: IMEIs com mais de um caso ativo (excluindo terminais)
-- → mantém o mais novo (MAX id), os mais antigos vão para VERIFICAR
UPDATE repair_cases
SET workflow_status = 'VERIFICAR', updated_at = datetime('now')
WHERE imei_norm IS NOT NULL
  AND workflow_status NOT IN ('ENTREGUE','CANCELADO','VENDA_ESTADO','VERIFICAR','CONCLUIDO')
  AND id NOT IN (
    SELECT MAX(id)
    FROM repair_cases
    WHERE imei_norm IS NOT NULL
      AND workflow_status NOT IN ('ENTREGUE','CANCELADO','VENDA_ESTADO','CONCLUIDO')
    GROUP BY imei_norm
    HAVING COUNT(*) > 1
  )
  AND imei_norm IN (
    SELECT imei_norm
    FROM repair_cases
    WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO','VENDA_ESTADO','CONCLUIDO')
    GROUP BY imei_norm
    HAVING COUNT(*) > 1
  );
