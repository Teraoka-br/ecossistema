import type { Db } from "../db/database.js";
import { resolvePartCostsBatch, type CostConfidence, type ResolvedCost } from "./cost-resolution-service.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PartCostItem {
  partRequestId: number;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  unitCost: number | null;
  quantity: number;
  totalCost: number | null;
  confidence: CostConfidence;
  sourceType: string | null;
  isStale: boolean;
}

export interface RepairPartsCostResult {
  totalPartsCost: number;
  coveragePercentage: number;
  items: PartCostItem[];
  overallConfidence: CostConfidence;
  missingCostItems: number;
  lowConfidenceItems: number;
  fingerprint: string;
}

// Status de part_request que contam para o custo do reparo
const ACTIVE_PART_STATUSES = [
  "INDICADA",
  "PEDIR_PECA",
  "RESERVADA",
  "SEPARADA",
  "AGUARDANDO_RECEBIMENTO",
  "VERIFICAR",
];

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function calculateRepairPartsCost(
  db: Db,
  caseId: number,
  context: "CURRENT_REPAIR" | "PURCHASE_SIMULATION" | "HISTORICAL_EVALUATION" = "CURRENT_REPAIR",
): RepairPartsCostResult {
  const parts = db.prepare(`
    SELECT id, chave_peca, chave_peca_norm, status
    FROM part_requests
    WHERE repair_case_id = ?
      AND cancelled_at IS NULL
      AND status IN (${ACTIVE_PART_STATUSES.map(() => "?").join(",")})
  `).all(caseId, ...ACTIVE_PART_STATUSES) as Array<{
    id: number;
    chave_peca: string | null;
    chave_peca_norm: string | null;
    status: string;
  }>;

  if (parts.length === 0) {
    return {
      totalPartsCost: 0,
      coveragePercentage: 100,
      items: [],
      overallConfidence: "HIGH",
      missingCostItems: 0,
      lowConfidenceItems: 0,
      fingerprint: "empty",
    };
  }

  // Coletar todas as chaves únicas e resolver em batch
  const uniqueKeys = [...new Set(parts.map(p => p.chave_peca_norm).filter(Boolean))] as string[];
  const costMap = resolvePartCostsBatch(db, uniqueKeys, context);

  let totalPartsCost = 0;
  let missingCostItems = 0;
  let lowConfidenceItems = 0;
  let worstConfidence: CostConfidence = "HIGH";
  const items: PartCostItem[] = [];
  const fingerprintParts: string[] = [];

  for (const part of parts) {
    const resolved: ResolvedCost | undefined = part.chave_peca_norm
      ? costMap.get(part.chave_peca_norm)
      : undefined;

    const unitCost = resolved?.unitCost ?? null;
    // Cada part_request = 1 unidade (o sistema não tem quantity na part_request)
    const quantity = 1;
    const totalCost = unitCost !== null ? unitCost * quantity : null;
    const confidence = resolved?.confidence ?? "MISSING";
    const isStale = resolved?.isStale ?? false;

    if (confidence === "MISSING") missingCostItems++;
    if (confidence === "LOW") lowConfidenceItems++;
    if (totalCost !== null) totalPartsCost += totalCost;

    worstConfidence = worseConfidence(worstConfidence, confidence);

    items.push({
      partRequestId: part.id,
      chavePeca: part.chave_peca,
      chavePecaNorm: part.chave_peca_norm,
      unitCost,
      quantity,
      totalCost,
      confidence,
      sourceType: resolved?.sourceType ?? null,
      isStale,
    });

    fingerprintParts.push(`${part.chave_peca_norm ?? "null"}:${unitCost}:${confidence}`);
  }

  const coveredItems = items.filter(i => i.unitCost !== null).length;
  const coveragePercentage = parts.length > 0 ? (coveredItems / parts.length) * 100 : 100;

  // Ordenar antes de gerar o hash — mesmos dados em qualquer ordem = mesmo fingerprint
  fingerprintParts.sort();
  const fingerprint = createHash("md5").update(fingerprintParts.join("|")).digest("hex").slice(0, 12);

  return {
    totalPartsCost,
    coveragePercentage,
    items,
    overallConfidence: worstConfidence,
    missingCostItems,
    lowConfidenceItems,
    fingerprint,
  };
}

function worseConfidence(a: CostConfidence, b: CostConfidence): CostConfidence {
  const order: CostConfidence[] = ["HIGH", "MEDIUM", "LOW", "CONFLICT", "MISSING"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
