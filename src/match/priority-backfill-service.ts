/**
 * Backfill de campos de prioridade em repair_cases.
 *
 * Preenche age_days, cost, estimated_sale e margin a partir de:
 *  1. his_current (preferencial para age_days e cost)
 *  2. source_order_parts (fallback por IMEI normalizado)
 *
 * Regras:
 * - Nunca sobrescreve valor já preenchido (usa COALESCE).
 * - Não altera workflow_status nem part_requests.
 * - Registra quantos casos foram atualizados por campo.
 */

import type { Db } from "../db/database.js";

export interface BackfillResult {
  casesEligible: number;
  ageDaysUpdated: number;
  costUpdated: number;
  estimatedSaleUpdated: number;
  marginUpdated: number;
  skipped: number;
}

export interface PriorityCoverageStats {
  totalCompleted: number;
  withAgeDays: number;
  withCost: number;
  withEstimatedSale: number;
  withMargin: number;
  pctAgeDays: number;
  pctMargin: number;
  lowCoverageAlert: boolean;
}

export function getPriorityCoverage(db: Db): PriorityCoverageStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN age_days IS NOT NULL THEN 1 ELSE 0 END) AS with_age,
      SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS with_cost,
      SUM(CASE WHEN estimated_sale IS NOT NULL THEN 1 ELSE 0 END) AS with_sale,
      SUM(CASE WHEN margin IS NOT NULL THEN 1 ELSE 0 END) AS with_margin
    FROM repair_cases
    WHERE analysis_status = 'COMPLETED'
  `).get() as { total: number; with_age: number; with_cost: number; with_sale: number; with_margin: number };

  const total = row.total || 0;
  const pctAge = total > 0 ? row.with_age / total : 0;
  const pctMargin = total > 0 ? row.with_margin / total : 0;

  return {
    totalCompleted: total,
    withAgeDays: row.with_age,
    withCost: row.with_cost,
    withEstimatedSale: row.with_sale,
    withMargin: row.with_margin,
    pctAgeDays: Math.round(pctAge * 100),
    pctMargin: Math.round(pctMargin * 100),
    lowCoverageAlert: total > 0 && (pctAge < 0.8 || pctMargin < 0.8),
  };
}

export function backfillRepairCasePriorityFields(db: Db): BackfillResult {
  const result: BackfillResult = {
    casesEligible: 0,
    ageDaysUpdated: 0,
    costUpdated: 0,
    estimatedSaleUpdated: 0,
    marginUpdated: 0,
    skipped: 0,
  };

  // Casos que precisam de pelo menos um campo preenchido
  const cases = db.prepare(`
    SELECT id, imei_norm, age_days, cost, estimated_sale, margin
    FROM repair_cases
    WHERE imei_norm IS NOT NULL
      AND (age_days IS NULL OR cost IS NULL OR estimated_sale IS NULL OR margin IS NULL)
  `).all() as Array<{
    id: number;
    imei_norm: string;
    age_days: number | null;
    cost: number | null;
    estimated_sale: number | null;
    margin: number | null;
  }>;

  result.casesEligible = cases.length;
  if (cases.length === 0) return result;

  // --- Fonte 1: his_current (age_days e audited_cost por imei_norm) ---
  const hisRows = db.prepare(`
    SELECT imei_norm, age_days, audited_cost FROM his_current WHERE imei_norm IS NOT NULL
  `).all() as Array<{ imei_norm: string; age_days: number | null; audited_cost: number | null }>;

  const hisMap = new Map<string, { ageDays: number | null; cost: number | null }>();
  for (const h of hisRows) {
    if (h.imei_norm) hisMap.set(h.imei_norm, { ageDays: h.age_days, cost: h.audited_cost });
  }

  // --- Fonte 2: source_order_parts (fallback por IMEI normalizado) ---
  const sopRaw = db.prepare(`
    SELECT imei, idade, custo, venda, margem_legada
    FROM source_order_parts
    WHERE imei IS NOT NULL
    ORDER BY rowid ASC
  `).all() as Array<{ imei: string | null; idade: number | null; custo: number | null; venda: number | null; margem_legada: number | null }>;

  const sopMap = new Map<string, { idade: number | null; custo: number | null; venda: number | null; margem: number | null }>();
  for (const s of sopRaw) {
    if (!s.imei) continue;
    const norm = s.imei.replace(/\D/g, "").trim();
    if (norm.length >= 10 && !sopMap.has(norm)) {
      sopMap.set(norm, { idade: s.idade, custo: s.custo, venda: s.venda, margem: s.margem_legada });
    }
  }

  const updateCase = db.prepare(`
    UPDATE repair_cases
    SET
      age_days       = COALESCE(age_days, ?),
      cost           = COALESCE(cost, ?),
      estimated_sale = COALESCE(estimated_sale, ?),
      margin         = COALESCE(margin, ?),
      updated_at     = datetime('now')
    WHERE id = ?
  `);

  db.exec("BEGIN");
  try {
    for (const rc of cases) {
      const his = hisMap.get(rc.imei_norm);
      const sop = sopMap.get(rc.imei_norm);

      // Resolver cada campo: his prioritário, sop fallback, nulo se nenhum
      const newAge  = rc.age_days        ?? his?.ageDays ?? sop?.idade  ?? null;
      const newCost = rc.cost            ?? his?.cost    ?? sop?.custo  ?? null;
      const newSale = rc.estimated_sale  ??               sop?.venda   ?? null;

      // Margem: preferir calculada a partir dos dados reais; fallback: margem_legada
      let newMargin = rc.margin;
      if (newMargin === null) {
        if (newCost !== null && newSale !== null) {
          newMargin = newSale - newCost;
        } else {
          newMargin = sop?.margem ?? null;
        }
      }

      // Só atualizar se ao menos um campo mudaria
      const wouldChange =
        (rc.age_days === null && newAge !== null) ||
        (rc.cost === null && newCost !== null) ||
        (rc.estimated_sale === null && newSale !== null) ||
        (rc.margin === null && newMargin !== null);

      if (!wouldChange) { result.skipped++; continue; }

      updateCase.run(newAge, newCost, newSale, newMargin, rc.id);

      if (rc.age_days === null && newAge !== null) result.ageDaysUpdated++;
      if (rc.cost === null && newCost !== null) result.costUpdated++;
      if (rc.estimated_sale === null && newSale !== null) result.estimatedSaleUpdated++;
      if (rc.margin === null && newMargin !== null) result.marginUpdated++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return result;
}
