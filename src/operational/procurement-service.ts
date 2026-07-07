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

    const PRESERVED_CASE_STATUSES = new Set([
      "RESERVADA", "SEPARADA", "CONSUMIDA", "APTO_REPARO",
      "DIRECIONADO_TECNICO", "CONCLUIDO",
    ]);

    const itemStmt = db.prepare(
      `INSERT INTO purchase_order_items
        (purchase_order_id, purchase_request_id, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity_ordered)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const affectedCaseIds = new Set<number>();

    for (const it of input.items) {
      let chavePeca = it.chavePeca?.trim() || null;
      const requestId = it.purchaseRequestId ?? null;
      if (requestId !== null) {
        const req = db
          .prepare("SELECT id, chave_peca, part_request_id, status FROM purchase_requests WHERE id = ?")
          .get(requestId) as { id: number; chave_peca: string | null; part_request_id: number | null; status: string } | undefined;
        if (!req) throw new ProcurementError(404, `Solicitação de compra ${requestId} não encontrada.`);
        if (req.status === "CANCELLED") throw new ProcurementError(422, `Solicitação ${requestId} está cancelada.`);
        if (!chavePeca) chavePeca = req.chave_peca;

        db.prepare("UPDATE purchase_requests SET status = 'ORDERED', updated_at = datetime('now') WHERE id = ?").run(requestId);

        // Atualizar part_request vinculada
        if (req.part_request_id !== null) {
          const pr = db.prepare("SELECT id, repair_case_id, status FROM part_requests WHERE id = ?")
            .get(req.part_request_id) as { id: number; repair_case_id: number; status: string } | undefined;
          if (pr && pr.status === "PEDIR_PECA") {
            db.prepare(
              "UPDATE part_requests SET status = 'AGUARDANDO_RECEBIMENTO', updated_at = datetime('now') WHERE id = ?",
            ).run(pr.id);
            affectedCaseIds.add(pr.repair_case_id);
          }
        }
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

    // Atualizar repair_cases com partes aguardando recebimento (se não em estado preservado)
    for (const caseId of affectedCaseIds) {
      const rc = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?")
        .get(caseId) as { workflow_status: string } | undefined;
      if (!rc || PRESERVED_CASE_STATUSES.has(rc.workflow_status)) continue;

      // Verificar se há reserva ativa
      const hasReservation = (db.prepare(
        "SELECT COUNT(*) AS c FROM operational_reservations WHERE repair_case_id = ? AND status = 'ACTIVE'",
      ).get(caseId) as { c: number }).c > 0;
      if (hasReservation) continue;

      // Verificar se há ao menos uma part_request aguardando recebimento
      const hasWaiting = (db.prepare(
        "SELECT COUNT(*) AS c FROM part_requests WHERE repair_case_id = ? AND status = 'AGUARDANDO_RECEBIMENTO' AND cancelled_at IS NULL",
      ).get(caseId) as { c: number }).c > 0;
      if (!hasWaiting) continue;

      db.prepare(
        "UPDATE repair_cases SET workflow_status = 'AGUARDANDO_RECEBIMENTO', updated_at = datetime('now') WHERE id = ?",
      ).run(caseId);
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

const PRESERVED_CASE_STATUSES_CANCEL = new Set([
  "RESERVADA","SEPARADA","CONSUMIDA","APTO_REPARO","DIRECIONADO_TECNICO","CONCLUIDO",
]);

export function cancelPurchaseOrder(db: Db, id: number, input: CancelOrderInput): PurchaseOrderWithItems {
  const order = getPurchaseOrder(db, id);
  if (order.status === "CANCELLED") return getPurchaseOrder(db, id); // idempotente
  if (order.status === "RECEIVED") {
    throw new ProcurementError(422, `Pedido ${order.order_number} já foi totalmente recebido — não pode ser cancelado.`);
  }
  const cancelledBy = requireNonEmpty(input.cancelledBy, "responsável");
  const cancelReason = requireNonEmpty(input.cancelReason, "motivo do cancelamento");

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?
       WHERE id = ?`,
    ).run(cancelledBy, cancelReason, id);

    // Reverter purchase_requests vinculadas a este pedido → APPROVED
    const linkedRequests = db.prepare(
      `SELECT purch.id AS purchaseRequestId, purch.part_request_id
       FROM purchase_order_items poi
       JOIN purchase_requests purch ON purch.id = poi.purchase_request_id
       WHERE poi.purchase_order_id = ? AND purch.status = 'ORDERED'`,
    ).all(id) as { purchaseRequestId: number; part_request_id: number | null }[];

    for (const lr of linkedRequests) {
      db.prepare(
        "UPDATE purchase_requests SET status = 'APPROVED', updated_at = datetime('now') WHERE id = ?",
      ).run(lr.purchaseRequestId);

      if (lr.part_request_id == null) continue;

      // Verificar se a part_request tem outro pedido ativo antes de regredir
      const otherActive = (db.prepare(
        `SELECT COUNT(*) AS c
         FROM purchase_order_items poi2
         JOIN purchase_requests purch2 ON purch2.id = poi2.purchase_request_id
         JOIN purchase_orders po2 ON po2.id = poi2.purchase_order_id
         WHERE purch2.part_request_id = ?
           AND poi2.purchase_order_id != ?
           AND purch2.status = 'ORDERED'
           AND po2.status IN ('AWAITING_RECEIPT','PARTIALLY_RECEIVED')`,
      ).get(lr.part_request_id, id) as { c: number }).c;

      if (otherActive > 0) continue;

      // Sem outro pedido ativo: regredir part_request → PEDIR_PECA se estava AGUARDANDO_RECEBIMENTO
      db.prepare(
        `UPDATE part_requests SET status = 'PEDIR_PECA', updated_at = datetime('now')
         WHERE id = ? AND status = 'AGUARDANDO_RECEBIMENTO'`,
      ).run(lr.part_request_id);

      // Regredir repair_case se estava AGUARDANDO_RECEBIMENTO e não há mais peças esperando
      const prRow = db.prepare(
        "SELECT repair_case_id FROM part_requests WHERE id = ?",
      ).get(lr.part_request_id) as { repair_case_id: number | null } | undefined;
      if (!prRow?.repair_case_id) continue;

      const caseId = prRow.repair_case_id;
      const stillWaiting = (db.prepare(
        `SELECT COUNT(*) AS c FROM part_requests
         WHERE repair_case_id = ? AND status = 'AGUARDANDO_RECEBIMENTO' AND cancelled_at IS NULL`,
      ).get(caseId) as { c: number }).c;

      if (stillWaiting > 0) continue;

      const caseStatus = (db.prepare(
        "SELECT workflow_status FROM repair_cases WHERE id = ?",
      ).get(caseId) as { workflow_status: string } | undefined)?.workflow_status;
      if (caseStatus && !PRESERVED_CASE_STATUSES_CANCEL.has(caseStatus)) {
        db.prepare(
          `UPDATE repair_cases SET workflow_status = 'PEDIR_PECA', updated_at = datetime('now') WHERE id = ?`,
        ).run(caseId);
      }
    }

    db.exec("COMMIT");
    return getPurchaseOrder(db, id);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
