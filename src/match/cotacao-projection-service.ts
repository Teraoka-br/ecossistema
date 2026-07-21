/**
 * Serviço de projeção canônica para aprovação de cotação.
 *
 * Executa o motor de match duas vezes (cenário base e cenário projetado) e
 * calcula o impacto marginal de cada linha da cotação. Toda a lógica usa
 * exclusivamente calculateMatch — nunca SQL de contagem.
 */

import type { Db } from "../db/database.js";
import { calculateMatch } from "./calculate-match.js";
import type { CalculateMatchInput, StockGroupInput } from "./calculate-match.js";
import { loadEngineInput, loadActiveRuleStrict } from "./engine-loader.js";

/** Normaliza chave_peca da cotação para o formato canônico do motor (lower + sem espaços). */
function normKey(s: string): string {
  return s.toLowerCase().replace(/ /g, "");
}

export interface SelectedCotacaoItem {
  id: number;
  chavePeca: string;
  qtde: number;
  valorUnitario: number;
}

export interface LineProjection {
  id: number;
  chavePeca: string;
  chavePecaNorm: string;
  selectedQtde: number;
  valorUnitario: number;
  currentAvailable: number;
  marginalFullMatches: number;
  marginalPartialMatches: number;
}

export interface ProjectedCase {
  caseId: number;
  imei: string | null;
  model: string | null;
  estimatedSale: number | null;
  margin: number | null;
  isIncremental: boolean;
}

export interface CotacaoProjectionResult {
  baselineFullMatches: number;
  projectedFullMatches: number;
  incrementalFullMatches: number;
  baselinePartialMatches: number;
  projectedPartialMatches: number;
  partialToFullConversions: number;

  projectedCaseIds: number[];
  incrementalCaseIds: number[];
  projectedCases: ProjectedCase[];

  orderCost: number;
  projectedRevenue: number | null;
  incrementalRevenue: number | null;
  projectedMargin: number | null;
  incrementalMargin: number | null;
  marginToCostRatio: number | null;
  costPerIncrementalMatch: number | null;

  selectedItemCount: number;
  selectedUnitCount: number;
  lineProjections: LineProjection[];
}

/**
 * Mescla adições de cotação no estoque existente.
 * Se a mesma chavePecaNorm já existe, soma a quantidade.
 */
function mergeStockAdditions(
  base: StockGroupInput[],
  additions: Array<{ chavePecaNorm: string; qtde: number; chavePeca: string }>,
): StockGroupInput[] {
  const merged = new Map<string, StockGroupInput>();

  for (const g of base) {
    merged.set(g.chavePecaNorm, { ...g });
  }

  for (const a of additions) {
    const existing = merged.get(a.chavePecaNorm);
    if (existing) {
      merged.set(a.chavePecaNorm, {
        ...existing,
        availableQuantity: existing.availableQuantity + a.qtde,
      });
    } else {
      merged.set(a.chavePecaNorm, {
        chavePecaNorm: a.chavePecaNorm,
        referencia: a.chavePeca,
        referenciaNorm: a.chavePecaNorm,
        availableQuantity: a.qtde,
      });
    }
  }

  return Array.from(merged.values());
}

function countResults(cases: ReturnType<typeof calculateMatch>["cases"]) {
  let full = 0;
  let partial = 0;
  for (const c of cases) {
    if (c.result === "MATCH") full++;
    else if (c.result === "MATCH_PARCIAL") partial++;
  }
  return { full, partial };
}

export function projectCotacaoImpact(
  db: Db,
  selectedItems: SelectedCotacaoItem[],
): CotacaoProjectionResult {
  if (selectedItems.length === 0) {
    return emptyResult();
  }

  const activeRule = loadActiveRuleStrict(db);
  const engineInput = loadEngineInput(db, activeRule);

  const baseInput: CalculateMatchInput = {
    cases: engineInput.cases,
    availableStock: engineInput.availableStock,
    activeRule: engineInput.activeRule,
    compatibility: engineInput.compatibility,
  };

  // ── Cenário base ──────────────────────────────────────────────────────────
  const baseOutput = calculateMatch(baseInput);
  const baseStats = countResults(baseOutput.cases);
  const baseMatchIds = new Set(
    baseOutput.cases.filter((c) => c.result === "MATCH").map((c) => c.caseId),
  );

  // ── Construir adições de estoque a partir da seleção ──────────────────────
  const additions = selectedItems.map((item) => ({
    chavePecaNorm: normKey(item.chavePeca),
    chavePeca: item.chavePeca,
    qtde: item.qtde,
  }));

  const projectedStock = mergeStockAdditions(engineInput.availableStock, additions);

  // ── Cenário projetado (todos os selecionados) ─────────────────────────────
  const projOutput = calculateMatch({ ...baseInput, availableStock: projectedStock });
  const projStats = countResults(projOutput.cases);

  const projMatchIds = new Set(
    projOutput.cases.filter((c) => c.result === "MATCH").map((c) => c.caseId),
  );

  const projectedCaseIds = Array.from(projMatchIds);
  const incrementalCaseIds = projectedCaseIds.filter((id) => !baseMatchIds.has(id));
  const partialToFullConversions = incrementalCaseIds.filter((id) =>
    baseOutput.cases.find((c) => c.caseId === id && c.result === "MATCH_PARCIAL"),
  ).length;

  // ── Impacto marginal por linha ────────────────────────────────────────────
  const lineProjections: LineProjection[] = selectedItems.map((item) => {
    const norm = normKey(item.chavePeca);
    const currentAvailable =
      engineInput.availableStock.find((g) => g.chavePecaNorm === norm)?.availableQuantity ?? 0;

    // Recalcular sem a contribuição deste item específico
    const additionsMinus = selectedItems
      .filter((si) => si.id !== item.id)
      .map((si) => ({
        chavePecaNorm: normKey(si.chavePeca),
        chavePeca: si.chavePeca,
        qtde: si.qtde,
      }));
    const stockMinus = mergeStockAdditions(engineInput.availableStock, additionsMinus);
    const minusOutput = calculateMatch({ ...baseInput, availableStock: stockMinus });
    const minusStats = countResults(minusOutput.cases);

    return {
      id: item.id,
      chavePeca: item.chavePeca,
      chavePecaNorm: norm,
      selectedQtde: item.qtde,
      valorUnitario: item.valorUnitario,
      currentAvailable,
      marginalFullMatches: projStats.full - minusStats.full,
      marginalPartialMatches: projStats.partial - minusStats.partial,
    };
  });

  // ── Dados financeiros dos casos projetados ────────────────────────────────
  interface CaseFinancial {
    id: number;
    imei: string | null;
    model: string | null;
    estimated_sale: number | null;
    margin: number | null;
  }

  let projectedCases: ProjectedCase[] = [];
  if (projectedCaseIds.length > 0) {
    const placeholders = projectedCaseIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, imei, model, estimated_sale, margin FROM repair_cases WHERE id IN (${placeholders})`,
      )
      .all(...projectedCaseIds) as unknown as CaseFinancial[];
    projectedCases = rows.map((r) => ({
      caseId: r.id,
      imei: r.imei,
      model: r.model,
      estimatedSale: r.estimated_sale,
      margin: r.margin,
      isIncremental: incrementalCaseIds.includes(r.id),
    }));
  }

  // Financeiro apenas dos incrementais (novos matches)
  const incrementalFinancial = projectedCases.filter((c) => c.isIncremental);
  const projectedRevenue = projectedCases.reduce(
    (s, c) => (c.estimatedSale !== null ? s + c.estimatedSale : s),
    0,
  );
  const incrementalRevenue = incrementalFinancial.reduce(
    (s, c) => (c.estimatedSale !== null ? s + c.estimatedSale : s),
    0,
  );
  const projectedMargin = projectedCases.reduce(
    (s, c) => (c.margin !== null ? s + c.margin : s),
    0,
  );
  const incrementalMargin = incrementalFinancial.reduce(
    (s, c) => (c.margin !== null ? s + c.margin : s),
    0,
  );

  const orderCost = selectedItems.reduce((s, i) => s + i.qtde * i.valorUnitario, 0);
  const marginToCostRatio = orderCost > 0 && incrementalMargin > 0 ? incrementalMargin / orderCost : null;
  const costPerIncrementalMatch =
    incrementalCaseIds.length > 0 && orderCost > 0 ? orderCost / incrementalCaseIds.length : null;

  return {
    baselineFullMatches: baseStats.full,
    projectedFullMatches: projStats.full,
    incrementalFullMatches: incrementalCaseIds.length,
    baselinePartialMatches: baseStats.partial,
    projectedPartialMatches: projStats.partial,
    partialToFullConversions,
    projectedCaseIds,
    incrementalCaseIds,
    projectedCases,
    orderCost,
    projectedRevenue: projectedCases.some((c) => c.estimatedSale !== null) ? projectedRevenue : null,
    incrementalRevenue: incrementalFinancial.some((c) => c.estimatedSale !== null) ? incrementalRevenue : null,
    projectedMargin: projectedCases.some((c) => c.margin !== null) ? projectedMargin : null,
    incrementalMargin: incrementalFinancial.some((c) => c.margin !== null) ? incrementalMargin : null,
    marginToCostRatio,
    costPerIncrementalMatch,
    selectedItemCount: selectedItems.length,
    selectedUnitCount: selectedItems.reduce((s, i) => s + i.qtde, 0),
    lineProjections,
  };
}

function emptyResult(): CotacaoProjectionResult {
  return {
    baselineFullMatches: 0,
    projectedFullMatches: 0,
    incrementalFullMatches: 0,
    baselinePartialMatches: 0,
    projectedPartialMatches: 0,
    partialToFullConversions: 0,
    projectedCaseIds: [],
    incrementalCaseIds: [],
    projectedCases: [],
    orderCost: 0,
    projectedRevenue: null,
    incrementalRevenue: null,
    projectedMargin: null,
    incrementalMargin: null,
    marginToCostRatio: null,
    costPerIncrementalMatch: null,
    selectedItemCount: 0,
    selectedUnitCount: 0,
    lineProjections: [],
  };
}

/**
 * Persiste um snapshot de decisão ao aprovar a cotação.
 */
export function savePurchaseDecisionSnapshot(
  db: Db,
  cotacaoId: number,
  createdBy: string | null,
  result: CotacaoProjectionResult,
): number {
  const stmt = db.prepare(`
    INSERT INTO purchase_decision_snapshots (
      cotacao_id, created_by,
      baseline_full_matches, projected_full_matches, incremental_full_matches,
      baseline_partial_matches, projected_partial_matches, partial_to_full_conversions,
      order_cost, projected_revenue, incremental_revenue,
      projected_margin, incremental_margin, margin_to_cost_ratio, cost_per_incremental_match,
      selected_item_count, selected_unit_count, snapshot_json
    ) VALUES (
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  const r = stmt.run(
    cotacaoId,
    createdBy,
    result.baselineFullMatches,
    result.projectedFullMatches,
    result.incrementalFullMatches,
    result.baselinePartialMatches,
    result.projectedPartialMatches,
    result.partialToFullConversions,
    result.orderCost,
    result.projectedRevenue,
    result.incrementalRevenue,
    result.projectedMargin,
    result.incrementalMargin,
    result.marginToCostRatio,
    result.costPerIncrementalMatch,
    result.selectedItemCount,
    result.selectedUnitCount,
    JSON.stringify(result),
  );

  return r.lastInsertRowid as number;
}
