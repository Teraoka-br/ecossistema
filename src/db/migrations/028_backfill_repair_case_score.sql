-- 028: Retroactively populate age_days and margin in repair_cases from source_order_parts
-- Joins by imei_norm (repair_cases) = imei (source_order_parts, already normalized on import)
-- Also fills cost and estimated_sale where available.

UPDATE repair_cases
SET
  age_days = COALESCE(age_days, (
    SELECT sop.idade FROM source_order_parts sop
    WHERE sop.imei = repair_cases.imei_norm
    ORDER BY sop.rowid LIMIT 1
  )),
  cost = COALESCE(cost, (
    SELECT sop.custo FROM source_order_parts sop
    WHERE sop.imei = repair_cases.imei_norm
    ORDER BY sop.rowid LIMIT 1
  )),
  estimated_sale = COALESCE(estimated_sale, (
    SELECT sop.venda FROM source_order_parts sop
    WHERE sop.imei = repair_cases.imei_norm
    ORDER BY sop.rowid LIMIT 1
  )),
  margin = COALESCE(margin, (
    SELECT sop.margem_legada FROM source_order_parts sop
    WHERE sop.imei = repair_cases.imei_norm
    ORDER BY sop.rowid LIMIT 1
  )),
  updated_at = datetime('now')
WHERE imei_norm IS NOT NULL
  AND (age_days IS NULL OR margin IS NULL);
