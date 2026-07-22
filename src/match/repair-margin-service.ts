import type { CostConfidence } from "../operational/cost-resolution-service.js";
import type { RepairPartsCostResult } from "../operational/repair-parts-cost-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepairMarginResult {
  legacyMargin: number | null;
  partsCost: number | null;
  repairMargin: number | null;
  repairCostRatio: number | null;
  partsCostCoverage: number;
  partsCostConfidence: CostConfidence;
  hasCompleteCostCoverage: boolean;
}

// ---------------------------------------------------------------------------
// Função pura — sem acesso a DB
// ---------------------------------------------------------------------------

export function calculateRepairMargin(opts: {
  estimatedSale: number | null;
  cost: number | null;
  partsCostResult: RepairPartsCostResult;
}): RepairMarginResult {
  const { estimatedSale, cost, partsCostResult } = opts;

  const legacyMargin =
    estimatedSale !== null && cost !== null ? estimatedSale - cost : null;

  const partsCost =
    partsCostResult.items.length > 0 ? partsCostResult.totalPartsCost : null;

  let repairMargin: number | null = null;
  if (estimatedSale !== null && cost !== null && partsCost !== null) {
    repairMargin = estimatedSale - cost - partsCost;
  }

  let repairCostRatio: number | null = null;
  if (partsCost !== null && estimatedSale !== null && estimatedSale > 0) {
    repairCostRatio = partsCost / estimatedSale;
  }

  return {
    legacyMargin,
    partsCost,
    repairMargin,
    repairCostRatio,
    partsCostCoverage: partsCostResult.coveragePercentage,
    partsCostConfidence: partsCostResult.overallConfidence,
    hasCompleteCostCoverage: partsCostResult.coveragePercentage >= 100,
  };
}
