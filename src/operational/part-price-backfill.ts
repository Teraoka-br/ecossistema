import type { Db } from "../db/database.js";
import { recordPriceEvent } from "./part-price-service.js";

export interface BackfillReport {
  cotacaoEventsCreated: number;
  orderEventsCreated: number;
  skipped: number;
  errors: string[];
}

export function backfillPriceEvents(db: Db): BackfillReport {
  const report: BackfillReport = {
    cotacaoEventsCreated: 0,
    orderEventsCreated: 0,
    skipped: 0,
    errors: [],
  };

  // Idempotência por registro: checa se cada origem já foi processada
  // via cotacao_item_id / purchase_order_item_id no evento existente.

  const existingCotacaoItemIds = new Set(
    (db.prepare(
      `SELECT cotacao_item_id FROM part_price_events WHERE source_type = 'BACKFILL_COTACAO' AND cotacao_item_id IS NOT NULL`,
    ).all() as { cotacao_item_id: number }[]).map(r => r.cotacao_item_id),
  );

  const existingOrderItemIds = new Set(
    (db.prepare(
      `SELECT purchase_order_item_id FROM part_price_events WHERE source_type = 'BACKFILL_ORDER' AND purchase_order_item_id IS NOT NULL`,
    ).all() as { purchase_order_item_id: number }[]).map(r => r.purchase_order_item_id),
  );

  // 1. Cotações aprovadas → BACKFILL_COTACAO
  const cotacaoRows = db.prepare(`
    SELECT ci.id AS item_id, ci.cotacao_id, ci.chave_peca, ci.valor_unitario, ci.qtde,
           c.supplier, c.approved_at, c.approved_by
    FROM cotacao_items ci
    JOIN cotacoes c ON c.id = ci.cotacao_id
    WHERE c.status = 'APPROVED'
      AND ci.valor_unitario > 0
      AND ci.chave_peca IS NOT NULL
      AND ci.chave_peca != ''
  `).all() as Array<{
    item_id: number; cotacao_id: number; chave_peca: string;
    valor_unitario: number; qtde: number;
    supplier: string; approved_at: string | null; approved_by: string | null;
  }>;

  for (const row of cotacaoRows) {
    if (existingCotacaoItemIds.has(row.item_id)) {
      report.skipped++;
      continue;
    }
    try {
      recordPriceEvent(db, {
        chavePeca: row.chave_peca,
        sourceType: "BACKFILL_COTACAO",
        unitPrice: row.valor_unitario,
        quantity: row.qtde,
        supplier: row.supplier,
        cotacaoId: row.cotacao_id,
        cotacaoItemId: row.item_id,
        confidence: "MEDIUM",
        createdBy: row.approved_by ?? "backfill",
        occurredAt: row.approved_at ?? new Date().toISOString(),
        notes: "Backfill de cotação aprovada existente",
      });
      report.cotacaoEventsCreated++;
    } catch (err) {
      report.errors.push(`Cotacao item ${row.item_id}: ${(err as Error).message}`);
      report.skipped++;
    }
  }

  // 2. Purchase order items (com preço via purchase_requests) → BACKFILL_ORDER
  const orderRows = db.prepare(`
    SELECT poi.id AS item_id, poi.purchase_order_id, poi.chave_peca,
           poi.quantity_ordered, poi.quantity_received,
           po.supplier, po.created_at AS order_date, po.created_by,
           pr.valor_unitario
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN purchase_requests pr ON pr.id = poi.purchase_request_id
    WHERE po.status != 'CANCELLED'
      AND pr.valor_unitario IS NOT NULL
      AND pr.valor_unitario > 0
      AND poi.chave_peca IS NOT NULL
      AND poi.chave_peca != ''
  `).all() as Array<{
    item_id: number; purchase_order_id: number; chave_peca: string;
    quantity_ordered: number; quantity_received: number;
    supplier: string | null; order_date: string; created_by: string | null;
    valor_unitario: number;
  }>;

  for (const row of orderRows) {
    if (existingOrderItemIds.has(row.item_id)) {
      report.skipped++;
      continue;
    }
    try {
      recordPriceEvent(db, {
        chavePeca: row.chave_peca,
        sourceType: "BACKFILL_ORDER",
        unitPrice: row.valor_unitario,
        quantity: row.quantity_ordered,
        supplier: row.supplier ?? undefined,
        purchaseOrderId: row.purchase_order_id,
        purchaseOrderItemId: row.item_id,
        confidence: "MEDIUM",
        createdBy: row.created_by ?? "backfill",
        occurredAt: row.order_date,
        notes: "Backfill de pedido de compra existente",
      });
      report.orderEventsCreated++;
    } catch (err) {
      report.errors.push(`PO item ${row.item_id}: ${(err as Error).message}`);
      report.skipped++;
    }
  }

  return report;
}
