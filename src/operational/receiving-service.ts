import type { Db } from "../db/database.js";
import { catalogHasKey } from "../db/counting-queries.js";
import { getSystemState } from "../system/system-service.js";
import { getActiveBatch } from "../db/repository.js";
import { getPurchaseOrder, ProcurementError, type PurchaseOrderItemRow, type PurchaseOrderWithItems } from "./procurement-service.js";

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const v = (value ?? "").trim();
  if (v === "") throw new ProcurementError(400, `${field} é obrigatório.`);
  return v;
}

export interface ReceiveItemInput {
  purchaseOrderItemId: number;
  quantity: number;
}

export interface ReceivePreviewLine {
  purchaseOrderItemId: number;
  referencia: string;
  chavePeca: string | null;
  quantityOrdered: number;
  alreadyReceived: number;
  remaining: number;
  receivingNow: number;
  over: boolean;
}

export interface ReceivePreview {
  orderId: number;
  orderNumber: string;
  lines: ReceivePreviewLine[];
  anyOverReceipt: boolean;
}

function operationalBatchId(db: Db): number | null {
  return getSystemState(db).initial_import_batch_id ?? getActiveBatch(db)?.id ?? null;
}

function poItemOrThrow(order: PurchaseOrderWithItems, itemId: number): PurchaseOrderItemRow {
  const item = order.items.find((i) => i.id === itemId);
  if (!item) throw new ProcurementError(404, `Item ${itemId} não pertence ao pedido ${order.order_number}.`);
  return item;
}

export function previewReceipt(db: Db, orderId: number, items: ReceiveItemInput[]): ReceivePreview {
  const order = getPurchaseOrder(db, orderId);
  if (!Array.isArray(items) || items.length === 0) {
    throw new ProcurementError(400, "Informe ao menos um item para receber.");
  }
  const lines: ReceivePreviewLine[] = [];
  let anyOverReceipt = false;
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      throw new ProcurementError(400, `Quantidade inválida para o item ${it.purchaseOrderItemId}.`);
    }
    const poItem = poItemOrThrow(order, it.purchaseOrderItemId);
    const remaining = poItem.quantity_ordered - poItem.quantity_received;
    const over = it.quantity > remaining;
    if (over) anyOverReceipt = true;
    lines.push({
      purchaseOrderItemId: poItem.id,
      referencia: poItem.referencia,
      chavePeca: poItem.chave_peca,
      quantityOrdered: poItem.quantity_ordered,
      alreadyReceived: poItem.quantity_received,
      remaining,
      receivingNow: it.quantity,
      over,
    });
  }
  return { orderId, orderNumber: order.order_number, lines, anyOverReceipt };
}

export interface ConfirmReceiptInput {
  receivedBy: string;
  notes?: string | null;
  allowOverReceipt?: boolean;
  justification?: string | null;
  items: ReceiveItemInput[];
}

export interface ConfirmReceiptResult {
  receiptId: number;
  order: PurchaseOrderWithItems;
  movementsCreated: number;
  unitsReceived: number;
}

/**
 * Confirma um recebimento (parcial permitido). Recebimento acima do pedido
 * exige allowOverReceipt + responsável + justificativa (>= 10 caracteres).
 * Valida a chave contra o catálogo operacional. Transacional e sem
 * movimentações duplicadas (um stock_movement por item de recebimento, com
 * origem única).
 */
export function confirmReceipt(db: Db, orderId: number, input: ConfirmReceiptInput): ConfirmReceiptResult {
  const receivedBy = requireNonEmpty(input.receivedBy, "responsável pelo recebimento");
  const order = getPurchaseOrder(db, orderId);
  if (order.status === "CANCELLED") {
    throw new ProcurementError(422, `Pedido ${order.order_number} está cancelado — não pode receber.`);
  }
  const preview = previewReceipt(db, orderId, input.items);

  if (preview.anyOverReceipt) {
    const justification = (input.justification ?? "").trim();
    if (!input.allowOverReceipt || justification.length < 10) {
      throw new ProcurementError(
        422,
        "Recebimento acima do pedido: envie allowOverReceipt=true, responsável e uma justificativa " +
          "com pelo menos 10 caracteres.",
        { code: "OVER_RECEIPT", lines: preview.lines.filter((l) => l.over) },
      );
    }
  }

  // Validação de chave:
  // - item vinculado a purchase_request com part_request_id: validar via part_request (não catálogo)
  // - item avulso (sem vínculo): manter validação contra catálogo operacional
  const batchId = operationalBatchId(db);
  for (const line of preview.lines) {
    const poItem = poItemOrThrow(order, line.purchaseOrderItemId);
    if (!poItem.chave_peca_norm) continue; // sem chave: sem validação

    // Tentar resolver vínculo part_request
    const partRequest = poItem.purchase_request_id != null
      ? (db.prepare(
          `SELECT pr.id, pr.chave_peca_norm, pr.status
           FROM purchase_requests purch
           JOIN part_requests pr ON pr.id = purch.part_request_id
           WHERE purch.id = ? AND purch.part_request_id IS NOT NULL`,
        ).get(poItem.purchase_request_id) as { id: number; chave_peca_norm: string | null; status: string } | undefined)
      : undefined;

    if (partRequest) {
      // Fluxo vinculado: validar contra a part_request
      if (partRequest.status === "CANCELADA") {
        throw new ProcurementError(
          422,
          `A solicitação de peça vinculada ao item ${poItem.id} está cancelada.`,
          { code: "PART_CANCELLED", purchaseOrderItemId: poItem.id },
        );
      }
      // A chave do item deve corresponder à da part_request (quando a part_request tem chave)
      if (partRequest.chave_peca_norm && partRequest.chave_peca_norm !== poItem.chave_peca_norm) {
        throw new ProcurementError(
          422,
          `A CHAVEPECA do item (${poItem.chave_peca}) não corresponde à solicitação vinculada.`,
          { code: "KEY_MISMATCH", purchaseOrderItemId: poItem.id },
        );
      }
      // Chave nova (não existe no catálogo): permitido por vínculo explícito
    } else {
      // Fluxo legado / avulso: exige chave no catálogo operacional
      if (batchId !== null && !catalogHasKey(db, batchId, poItem.chave_peca_norm)) {
        throw new ProcurementError(
          422,
          `CHAVEPECA "${poItem.chave_peca}" do item ${poItem.id} não existe no catálogo operacional.`,
          { code: "UNKNOWN_KEY", purchaseOrderItemId: poItem.id },
        );
      }
    }
  }

  db.exec("BEGIN");
  try {
    const justification = (input.justification ?? "").trim() || null;
    const receiptRes = db
      .prepare(
        `INSERT INTO goods_receipts (purchase_order_id, received_by, allow_over_receipt, justification, notes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(orderId, receivedBy, input.allowOverReceipt ? 1 : 0, justification, input.notes?.trim() || null);
    const receiptId = Number(receiptRes.lastInsertRowid);

    const grItemStmt = db.prepare(
      `INSERT INTO goods_receipt_items
        (goods_receipt_id, purchase_order_item_id, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity_received)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const movementStmt = db.prepare(
      `INSERT INTO stock_movements
        (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity, source_type, source_id, created_by, notes)
       VALUES ('PURCHASE_RECEIPT', ?, ?, ?, ?, ?, 'GOODS_RECEIPT_ITEM', ?, ?, ?)`,
    );

    let movementsCreated = 0;
    let unitsReceived = 0;
    for (const it of input.items) {
      const poItem = poItemOrThrow(order, it.purchaseOrderItemId);
      const grItemRes = grItemStmt.run(
        receiptId,
        poItem.id,
        poItem.referencia,
        poItem.referencia_norm,
        poItem.chave_peca,
        poItem.chave_peca_norm,
        it.quantity,
      );
      const grItemId = Number(grItemRes.lastInsertRowid);
      movementStmt.run(
        poItem.referencia,
        poItem.referencia_norm,
        poItem.chave_peca,
        poItem.chave_peca_norm,
        it.quantity,
        grItemId,
        receivedBy,
        `Recebimento do pedido ${order.order_number}`,
      );
      db.prepare("UPDATE purchase_order_items SET quantity_received = quantity_received + ? WHERE id = ?").run(it.quantity, poItem.id);
      movementsCreated++;
      unitsReceived += it.quantity;
    }

    // Recalcula o status do pedido: tudo recebido (>= pedido) => RECEBIDO.
    const updatedItems = db
      .prepare("SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id = ?")
      .all(orderId) as { quantity_ordered: number; quantity_received: number }[];
    const allReceived = updatedItems.every((i) => i.quantity_received >= i.quantity_ordered);
    if (allReceived) {
      db.prepare("UPDATE purchase_orders SET status = 'RECEIVED', received_at = datetime('now') WHERE id = ?").run(orderId);
    } else {
      db.prepare("UPDATE purchase_orders SET status = 'PARTIALLY_RECEIVED' WHERE id = ?").run(orderId);
    }

    db.exec("COMMIT");
    return { receiptId, order: getPurchaseOrder(db, orderId), movementsCreated, unitsReceived };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface GoodsReceiptRow {
  id: number;
  purchase_order_id: number;
  received_by: string;
  allow_over_receipt: number;
  justification: string | null;
  notes: string | null;
  created_at: string;
}

export function listReceipts(db: Db, orderId: number): (GoodsReceiptRow & { items: unknown[] })[] {
  const receipts = db
    .prepare("SELECT * FROM goods_receipts WHERE purchase_order_id = ? ORDER BY id")
    .all(orderId) as unknown as GoodsReceiptRow[];
  return receipts.map((r) => ({
    ...r,
    items: db.prepare("SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ? ORDER BY id").all(r.id),
  }));
}
