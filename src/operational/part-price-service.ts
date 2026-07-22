import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriceSourceType =
  | "COTACAO"
  | "APPROVED_COTACAO"
  | "PURCHASE_ORDER"
  | "GOODS_RECEIPT"
  | "MANUAL_OVERRIDE"
  | "COST_CORRECTION"
  | "BACKFILL_COTACAO"
  | "BACKFILL_ORDER"
  | "BACKFILL_RECEIPT";

export type PriceConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface PriceEventInput {
  chavePeca: string;
  sourceType: PriceSourceType;
  unitPrice: number;
  effectiveUnitCost?: number | null;
  quantity?: number | null;
  supplier?: string | null;
  cotacaoId?: number | null;
  cotacaoItemId?: number | null;
  purchaseOrderId?: number | null;
  purchaseOrderItemId?: number | null;
  goodsReceiptId?: number | null;
  goodsReceiptItemId?: number | null;
  confidence: PriceConfidence;
  previousPrice?: number | null;
  notes?: string | null;
  createdBy?: string | null;
  occurredAt: string;
}

export interface PriceEvent {
  id: number;
  chavePeca: string;
  chavePecaNorm: string;
  sourceType: PriceSourceType;
  unitPrice: number;
  effectiveUnitCost: number | null;
  quantity: number | null;
  supplier: string | null;
  cotacaoId: number | null;
  cotacaoItemId: number | null;
  purchaseOrderId: number | null;
  purchaseOrderItemId: number | null;
  goodsReceiptId: number | null;
  goodsReceiptItemId: number | null;
  confidence: PriceConfidence;
  previousPrice: number | null;
  notes: string | null;
  createdBy: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface PriceEventFilters {
  chavePecaNorm?: string;
  sourceType?: PriceSourceType;
  supplier?: string;
  limit?: number;
  offset?: number;
}

export interface PriceSummary {
  chavePecaNorm: string;
  latestPrice: number | null;
  latestSupplier: string | null;
  latestDate: string | null;
  avg30d: number | null;
  avg90d: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  eventCount: number;
  suppliers: string[];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function recordPriceEvent(db: Db, input: PriceEventInput): number {
  const norm = normalizeKey(input.chavePeca);
  if (!norm) throw new Error("chavePeca é obrigatória para registrar evento de preço.");
  if (input.unitPrice < 0) throw new Error("unitPrice não pode ser negativo.");

  const res = db.prepare(`
    INSERT INTO part_price_events (
      chave_peca, chave_peca_norm, source_type, unit_price, effective_unit_cost,
      quantity, supplier, cotacao_id, cotacao_item_id, purchase_order_id,
      purchase_order_item_id, goods_receipt_id, goods_receipt_item_id,
      confidence, previous_price, notes, created_by, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.chavePeca,
    norm,
    input.sourceType,
    input.unitPrice,
    input.effectiveUnitCost ?? null,
    input.quantity ?? null,
    input.supplier ?? null,
    input.cotacaoId ?? null,
    input.cotacaoItemId ?? null,
    input.purchaseOrderId ?? null,
    input.purchaseOrderItemId ?? null,
    input.goodsReceiptId ?? null,
    input.goodsReceiptItemId ?? null,
    input.confidence,
    input.previousPrice ?? null,
    input.notes ?? null,
    input.createdBy ?? null,
    input.occurredAt,
  );
  return Number(res.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function rowToEvent(r: Record<string, unknown>): PriceEvent {
  return {
    id: r.id as number,
    chavePeca: r.chave_peca as string,
    chavePecaNorm: r.chave_peca_norm as string,
    sourceType: r.source_type as PriceSourceType,
    unitPrice: r.unit_price as number,
    effectiveUnitCost: r.effective_unit_cost as number | null,
    quantity: r.quantity as number | null,
    supplier: r.supplier as string | null,
    cotacaoId: r.cotacao_id as number | null,
    cotacaoItemId: r.cotacao_item_id as number | null,
    purchaseOrderId: r.purchase_order_id as number | null,
    purchaseOrderItemId: r.purchase_order_item_id as number | null,
    goodsReceiptId: r.goods_receipt_id as number | null,
    goodsReceiptItemId: r.goods_receipt_item_id as number | null,
    confidence: r.confidence as PriceConfidence,
    previousPrice: r.previous_price as number | null,
    notes: r.notes as string | null,
    createdBy: r.created_by as string | null,
    occurredAt: r.occurred_at as string,
    createdAt: r.created_at as string,
  };
}

export function listPriceEvents(db: Db, filters: PriceEventFilters): PriceEvent[] {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filters.chavePecaNorm) {
    conditions.push("chave_peca_norm = ?");
    params.push(filters.chavePecaNorm);
  }
  if (filters.sourceType) {
    conditions.push("source_type = ?");
    params.push(filters.sourceType);
  }
  if (filters.supplier) {
    conditions.push("supplier = ?");
    params.push(filters.supplier);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const rows = db.prepare(
    `SELECT * FROM part_price_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(rowToEvent);
}

export function getLatestPrice(db: Db, chavePecaNorm: string, supplier?: string): PriceEvent | null {
  const params: (string | number | null)[] = [chavePecaNorm];
  let supplierClause = "";
  if (supplier) {
    supplierClause = " AND supplier = ?";
    params.push(supplier);
  }
  const row = db.prepare(
    `SELECT * FROM part_price_events
     WHERE chave_peca_norm = ?${supplierClause}
     ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? rowToEvent(row) : null;
}

export function getPriceSummary(db: Db, chavePecaNorm: string): PriceSummary {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS event_count,
      MIN(unit_price) AS min_price,
      MAX(unit_price) AS max_price
    FROM part_price_events
    WHERE chave_peca_norm = ?
  `).get(chavePecaNorm) as { event_count: number; min_price: number | null; max_price: number | null };

  const avg30 = db.prepare(`
    SELECT AVG(unit_price) AS avg_price
    FROM part_price_events
    WHERE chave_peca_norm = ? AND occurred_at >= datetime('now', '-30 days')
  `).get(chavePecaNorm) as { avg_price: number | null };

  const avg90 = db.prepare(`
    SELECT AVG(unit_price) AS avg_price
    FROM part_price_events
    WHERE chave_peca_norm = ? AND occurred_at >= datetime('now', '-90 days')
  `).get(chavePecaNorm) as { avg_price: number | null };

  const latest = getLatestPrice(db, chavePecaNorm);

  const suppliers = (db.prepare(`
    SELECT DISTINCT supplier FROM part_price_events
    WHERE chave_peca_norm = ? AND supplier IS NOT NULL
    ORDER BY supplier
  `).all(chavePecaNorm) as { supplier: string }[]).map(r => r.supplier);

  return {
    chavePecaNorm,
    latestPrice: latest?.unitPrice ?? null,
    latestSupplier: latest?.supplier ?? null,
    latestDate: latest?.occurredAt ?? null,
    avg30d: avg30.avg_price,
    avg90d: avg90.avg_price,
    minPrice: stats.min_price,
    maxPrice: stats.max_price,
    eventCount: stats.event_count,
    suppliers,
  };
}
