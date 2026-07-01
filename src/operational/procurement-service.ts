import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";

export class ProcurementError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
    this.name = "ProcurementError";
  }
}

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const v = (value ?? "").trim();
  if (v === "") throw new ProcurementError(400, `${field} é obrigatório.`);
  return v;
}

export interface PurchaseRequestRow {
  id: number;
  source_quotation_id: number | null;
  import_batch_id: number | null;
  id_pedido: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  referencia: string | null;
  referencia_norm: string | null;
  quantidade: number | null;
  valor_unitario: number | null;
  valor_total: number | null;
  origin_status: string | null;
  status: "APPROVED" | "ORDERED" | "CANCELLED";
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItemRow {
  id: number;
  purchase_order_id: number;
  purchase_request_id: number | null;
  referencia: string;
  referencia_norm: string;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  quantity_ordered: number;
  quantity_received: number;
  created_at: string;
}

export interface PurchaseOrderRow {
  id: number;
  order_number: string;
  supplier: string | null;
  status: "AWAITING_RECEIPT" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";
  notes: string | null;
  created_at: string;
  created_by: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

export interface PurchaseOrderWithItems extends PurchaseOrderRow {
  items: PurchaseOrderItemRow[];
}

export function listPurchaseRequests(db: Db, status?: string): PurchaseRequestRow[] {
  if (status && status.trim() !== "") {
    return db
      .prepare("SELECT * FROM purchase_requests WHERE status = ? ORDER BY id")
      .all(status.trim().toUpperCase()) as unknown as PurchaseRequestRow[];
  }
  return db.prepare("SELECT * FROM purchase_requests ORDER BY id").all() as unknown as PurchaseRequestRow[];
}

function itemsOf(db: Db, orderId: number): PurchaseOrderItemRow[] {
  return db
    .prepare("SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id")
    .all(orderId) as unknown as PurchaseOrderItemRow[];
}

export function getPurchaseOrder(db: Db, id: number): PurchaseOrderWithItems {
  const order = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id) as unknown as PurchaseOrderRow | undefined;
  if (!order) throw new ProcurementError(404, `Pedido de compra ${id} não encontrado.`);
  return { ...order, items: itemsOf(db, id) };
}

export function listPurchaseOrders(db: Db, status?: string): PurchaseOrderWithItems[] {
  const orders = (
    status && status.trim() !== ""
      ? db.prepare("SELECT * FROM purchase_orders WHERE status = ? ORDER BY id DESC").all(status.trim().toUpperCase())
      : db.prepare("SELECT * FROM purchase_orders ORDER BY id DESC").all()
  ) as unknown as PurchaseOrderRow[];
  return orders.map((o) => ({ ...o, items: itemsOf(db, o.id) }));
}

/** Próximo número de pedido PC-AAAAMMDD-NNNN para o dia atual (dentro da transação). */
function nextOrderNumber(db: Db): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // AAAAMMDD
  const prefix = `PC-${stamp}-`;
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE order_number LIKE ?")
    .get(`${prefix}%`) as { c: number };
  const seq = String(row.c + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}

export interface CreateOrderItemInput {
  purchaseRequestId?: number | null;
  referencia: string;
  chavePeca?: string | null;
  quantity: number;
}

export interface CreateOrderInput {
  createdBy: string;
  supplier?: string | null;
  notes?: string | null;
  items: CreateOrderItemInput[];
}

/**
 * Gera um pedido de compra a partir de itens (opcionalmente vinculados a
 * solicitações aprovadas). Transacional e seguro contra duplicidade do número
 * (UNIQUE order_number + tentativa única recalculada na transação).
 */
export function createPurchaseOrder(db: Db, input: CreateOrderInput): PurchaseOrderWithItems {
  const createdBy = requireNonEmpty(input.createdBy, "responsável");
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ProcurementError(400, "Informe ao menos um item para o pedido de compra.");
  }
  for (const it of input.items) {
    requireNonEmpty(it.referencia, "referência do item");
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      throw new ProcurementError(400, `Quantidade inválida para a referência "${it.referencia}".`);
    }
  }

  db.exec("BEGIN");
  try {
    const orderNumber = nextOrderNumber(db);
    const orderRes = db
      .prepare(
        `INSERT INTO purchase_orders (order_number, supplier, status, notes, created_by)
         VALUES (?, ?, 'AWAITING_RECEIPT', ?, ?)`,
      )
      .run(orderNumber, input.supplier?.trim() || null, input.notes?.trim() || null, createdBy);
    const orderId = Number(orderRes.lastInsertRowid);

    const itemStmt = db.prepare(
      `INSERT INTO purchase_order_items
        (purchase_order_id, purchase_request_id, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity_ordered)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of input.items) {
      let chavePeca = it.chavePeca?.trim() || null;
      const requestId = it.purchaseRequestId ?? null;
      if (requestId !== null) {
        const req = db
          .prepare("SELECT * FROM purchase_requests WHERE id = ?")
          .get(requestId) as unknown as PurchaseRequestRow | undefined;
        if (!req) throw new ProcurementError(404, `Solicitação de compra ${requestId} não encontrada.`);
        if (req.status === "CANCELLED") throw new ProcurementError(422, `Solicitação ${requestId} está cancelada.`);
        if (!chavePeca) chavePeca = req.chave_peca;
        db.prepare("UPDATE purchase_requests SET status = 'ORDERED', updated_at = datetime('now') WHERE id = ?").run(requestId);
      }
      const referencia = it.referencia.trim();
      itemStmt.run(
        orderId,
        requestId,
        referencia,
        normalizeKey(referencia),
        chavePeca,
        chavePeca ? normalizeKey(chavePeca) : null,
        it.quantity,
      );
    }

    db.exec("COMMIT");
    return getPurchaseOrder(db, orderId);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface CancelOrderInput {
  cancelledBy: string;
  cancelReason: string;
}

export function cancelPurchaseOrder(db: Db, id: number, input: CancelOrderInput): PurchaseOrderWithItems {
  const order = getPurchaseOrder(db, id);
  if (order.status === "CANCELLED") return order; // idempotente
  if (order.status === "RECEIVED") {
    throw new ProcurementError(422, `Pedido ${order.order_number} já foi totalmente recebido — não pode ser cancelado.`);
  }
  const cancelledBy = requireNonEmpty(input.cancelledBy, "responsável");
  const cancelReason = requireNonEmpty(input.cancelReason, "motivo do cancelamento");
  db.prepare(
    `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?
     WHERE id = ?`,
  ).run(cancelledBy, cancelReason, id);
  return getPurchaseOrder(db, id);
}
