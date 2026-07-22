import type { Db } from "../db/database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostContext = "CURRENT_REPAIR" | "PURCHASE_SIMULATION" | "HISTORICAL_EVALUATION";
export type CostConfidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING" | "CONFLICT";

export interface ResolvedCost {
  unitCost: number | null;
  confidence: CostConfidence;
  sourceType: string | null;
  sourceEventId: number | null;
  supplier: string | null;
  occurredAt: string | null;
  ageInDays: number | null;
  isStale: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Configuração de validade (dias)
// ---------------------------------------------------------------------------

export const COST_STALENESS_DAYS = {
  GOODS_RECEIPT_FRESH: 90,
  APPROVED_COTACAO_FRESH: 60,
  COTACAO_FRESH: 30,
};

export const CONFLICT_THRESHOLD_PCT = 0.30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function demoteConfidence(c: CostConfidence): CostConfidence {
  switch (c) {
    case "HIGH": return "MEDIUM";
    case "MEDIUM": return "LOW";
    default: return "LOW";
  }
}

interface PriceRow {
  id: number;
  unit_price: number;
  source_type: string;
  supplier: string | null;
  occurred_at: string;
  confidence: string;
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

export function resolveEffectivePartCost(
  db: Db,
  opts: {
    chavePecaNorm: string;
    context: CostContext;
    compatGroupMembers?: string[];
    asOfDate?: string;
  },
): ResolvedCost {
  const now = opts.asOfDate ? new Date(opts.asOfDate) : new Date();
  const reasons: string[] = [];

  // Buscar eventos para a chave direta, ordenados por relevância
  const directEvents = db.prepare(`
    SELECT id, unit_price, source_type, supplier, occurred_at, confidence
    FROM part_price_events
    WHERE chave_peca_norm = ?
    ORDER BY occurred_at DESC, id DESC
  `).all(opts.chavePecaNorm) as unknown as PriceRow[];

  // Tentar resolver pela chave direta
  const direct = resolveFromEvents(directEvents, now, reasons);
  if (direct && direct.confidence !== "CONFLICT") return direct;

  // Se CONFLICT na direta, retornar CONFLICT
  if (direct && direct.confidence === "CONFLICT") return direct;

  // Tentar compatíveis (se fornecidos)
  if (opts.compatGroupMembers && opts.compatGroupMembers.length > 0) {
    const otherKeys = opts.compatGroupMembers.filter(k => k !== opts.chavePecaNorm);
    for (const key of otherKeys) {
      const compatEvents = db.prepare(`
        SELECT id, unit_price, source_type, supplier, occurred_at, confidence
        FROM part_price_events
        WHERE chave_peca_norm = ?
        ORDER BY occurred_at DESC, id DESC
      `).all(key) as unknown as PriceRow[];

      const resolved = resolveFromEvents(compatEvents, now, []);
      if (resolved && resolved.confidence !== "MISSING" && resolved.confidence !== "CONFLICT") {
        reasons.push(`Custo via compatível: ${key}`);
        return {
          ...resolved,
          confidence: demoteConfidence(resolved.confidence),
          reasons,
        };
      }
    }
  }

  reasons.push("Nenhuma fonte de custo encontrada");
  return {
    unitCost: null,
    confidence: "MISSING",
    sourceType: null,
    sourceEventId: null,
    supplier: null,
    occurredAt: null,
    ageInDays: null,
    isStale: false,
    reasons,
  };
}

function resolveFromEvents(
  events: PriceRow[],
  now: Date,
  reasons: string[],
): ResolvedCost | null {
  if (events.length === 0) return null;

  // Check for conflict: multiple suppliers with price divergence >30%
  const bySupplier = new Map<string, number>();
  for (const e of events.slice(0, 10)) {
    const key = e.supplier ?? "__unknown__";
    if (!bySupplier.has(key)) bySupplier.set(key, e.unit_price);
  }
  if (bySupplier.size > 1) {
    const prices = [...bySupplier.values()];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min > 0 && (max - min) / min > CONFLICT_THRESHOLD_PCT) {
      reasons.push(`Conflito: ${bySupplier.size} fornecedores com dispersão ${((max - min) / min * 100).toFixed(0)}%`);
      // Still return the most recent, but flag as CONFLICT
      const best = events[0];
      const age = daysBetween(best.occurred_at, now);
      return {
        unitCost: best.unit_price,
        confidence: "CONFLICT",
        sourceType: best.source_type,
        sourceEventId: best.id,
        supplier: best.supplier,
        occurredAt: best.occurred_at,
        ageInDays: age,
        isStale: age > COST_STALENESS_DAYS.GOODS_RECEIPT_FRESH,
        reasons,
      };
    }
  }

  // Priority: GOODS_RECEIPT > APPROVED_COTACAO > PURCHASE_ORDER > COTACAO > MANUAL_OVERRIDE > BACKFILL_*
  const priority: Record<string, number> = {
    GOODS_RECEIPT: 1,
    APPROVED_COTACAO: 2,
    PURCHASE_ORDER: 3,
    COTACAO: 4,
    MANUAL_OVERRIDE: 5,
    COST_CORRECTION: 5,
    BACKFILL_RECEIPT: 6,
    BACKFILL_ORDER: 7,
    BACKFILL_COTACAO: 8,
  };

  // Group events by source type priority, pick the best (most recent within highest priority)
  let bestEvent: PriceRow | null = null;
  let bestPriority = Infinity;

  for (const e of events) {
    const p = priority[e.source_type] ?? 99;
    if (p < bestPriority || (p === bestPriority && (!bestEvent || e.occurred_at > bestEvent.occurred_at))) {
      bestEvent = e;
      bestPriority = p;
    }
  }

  if (!bestEvent) return null;

  const age = daysBetween(bestEvent.occurred_at, now);
  let confidence: CostConfidence;
  let isStale = false;

  switch (bestEvent.source_type) {
    case "GOODS_RECEIPT":
    case "BACKFILL_RECEIPT":
      confidence = age <= COST_STALENESS_DAYS.GOODS_RECEIPT_FRESH ? "HIGH" : "MEDIUM";
      isStale = age > COST_STALENESS_DAYS.GOODS_RECEIPT_FRESH;
      break;
    case "APPROVED_COTACAO":
    case "PURCHASE_ORDER":
    case "BACKFILL_ORDER":
      confidence = age <= COST_STALENESS_DAYS.APPROVED_COTACAO_FRESH ? "MEDIUM" : "LOW";
      isStale = age > COST_STALENESS_DAYS.APPROVED_COTACAO_FRESH;
      break;
    case "MANUAL_OVERRIDE":
    case "COST_CORRECTION":
      confidence = "HIGH";
      break;
    default:
      confidence = "LOW";
      isStale = age > COST_STALENESS_DAYS.COTACAO_FRESH;
  }

  reasons.push(`Fonte: ${bestEvent.source_type} (${age}d atrás)`);

  return {
    unitCost: bestEvent.unit_price,
    confidence,
    sourceType: bestEvent.source_type,
    sourceEventId: bestEvent.id,
    supplier: bestEvent.supplier,
    occurredAt: bestEvent.occurred_at,
    ageInDays: age,
    isStale,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Batch resolution (para evitar N+1 no motor)
// ---------------------------------------------------------------------------

export function resolvePartCostsBatch(
  db: Db,
  chavePecaNorms: string[],
  context: CostContext,
): Map<string, ResolvedCost> {
  const result = new Map<string, ResolvedCost>();
  if (chavePecaNorms.length === 0) return result;

  // Pré-carregar grupos de compatibilidade para todas as chaves
  const compatMap = new Map<string, string[]>();
  const placeholders = chavePecaNorms.map(() => "?").join(",");
  const groupRows = db.prepare(`
    SELECT m1.chave_peca_norm AS requested, m2.chave_peca_norm AS compat
    FROM part_compatibility_group_members m1
    JOIN part_compatibility_group_members m2 ON m2.group_id = m1.group_id AND m2.removed_at IS NULL
    WHERE m1.removed_at IS NULL AND m1.chave_peca_norm IN (${placeholders})
  `).all(...chavePecaNorms) as { requested: string; compat: string }[];

  for (const row of groupRows) {
    let arr = compatMap.get(row.requested);
    if (!arr) { arr = []; compatMap.set(row.requested, arr); }
    if (!arr.includes(row.compat)) arr.push(row.compat);
  }

  for (const norm of chavePecaNorms) {
    if (result.has(norm)) continue;
    result.set(norm, resolveEffectivePartCost(db, {
      chavePecaNorm: norm,
      context,
      compatGroupMembers: compatMap.get(norm),
    }));
  }

  return result;
}
