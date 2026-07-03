import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { getSystemState } from "../../system/system-service.js";
import * as proc from "../../operational/procurement-service.js";
import { ProcurementError } from "../../operational/procurement-service.js";
import * as recv from "../../operational/receiving-service.js";
import { getCurrentOperationalStock, listMovements, StockError } from "../../operational/stock-service.js";

export const procurementRouter = Router();

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof ProcurementError || err instanceof StockError) {
    res.status(err.statusCode).json({ error: err.message, details: err.details });
    return;
  }
  res.status(500).json({ error: (err as Error).message || "Erro interno." });
}

function idParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ProcurementError(400, `Parâmetro de id inválido: "${raw}".`);
  return n;
}

// ===========================================================================
// Estado do sistema
// ===========================================================================

procurementRouter.get("/system/state", (_req, res) => {
  res.json({ state: getSystemState(getDb()) });
});

// ===========================================================================
// Solicitações de compra aprovadas
// ===========================================================================

procurementRouter.get("/purchase-requests", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ requests: proc.listPurchaseRequests(getDb(), status) });
});

procurementRouter.get("/purchase-requests/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const requests = proc.listPurchaseRequests(getDb());
    const request = requests.find((r) => r.id === id);
    if (!request) throw new ProcurementError(404, `Solicitação ${id} não encontrada.`);
    res.json({ request });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Pedidos de compra
// ===========================================================================

const createOrderSchema = z.object({
  supplier: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        purchaseRequestId: z.number().int().positive().optional().nullable(),
        referencia: z.string().min(1),
        chavePeca: z.string().optional().nullable(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
});

procurementRouter.post("/purchase-orders", (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const createdBy = req.sessionUser!.displayName;
    const order = proc.createPurchaseOrder(getDb(), { ...parsed.data, createdBy });
    res.status(201).json({ order });
  } catch (err) {
    handleError(err, res);
  }
});

procurementRouter.get("/purchase-orders", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ orders: proc.listPurchaseOrders(getDb(), status) });
});

procurementRouter.get("/purchase-orders/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    res.json({ order: proc.getPurchaseOrder(getDb(), id) });
  } catch (err) {
    handleError(err, res);
  }
});

const cancelOrderSchema = z.object({
  cancelReason: z.string().min(1),
});

procurementRouter.post("/purchase-orders/:id/cancel", (req, res) => {
  const parsed = cancelOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const cancelledBy = req.sessionUser!.displayName;
    res.json({ order: proc.cancelPurchaseOrder(getDb(), id, { ...parsed.data, cancelledBy }) });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Recebimentos
// ===========================================================================

const receiveItemsSchema = z.object({
  items: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), quantity: z.number().int().positive() })).min(1),
});

procurementRouter.post("/purchase-orders/:id/receipts/preview", (req, res) => {
  const parsed = receiveItemsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    res.json(recv.previewReceipt(getDb(), id, parsed.data.items));
  } catch (err) {
    handleError(err, res);
  }
});

const confirmReceiptSchema = z.object({
  notes: z.string().optional().nullable(),
  allowOverReceipt: z.boolean().optional(),
  justification: z.string().optional().nullable(),
  items: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), quantity: z.number().int().positive() })).min(1),
});

procurementRouter.post("/purchase-orders/:id/receipts/confirm", (req, res) => {
  const parsed = confirmReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const receivedBy = req.sessionUser!.displayName;
    res.json(recv.confirmReceipt(getDb(), id, { ...parsed.data, receivedBy }));
  } catch (err) {
    handleError(err, res);
  }
});

procurementRouter.get("/purchase-orders/:id/receipts", (req, res) => {
  try {
    const id = idParam(req.params.id);
    res.json({ receipts: recv.listReceipts(getDb(), id) });
  } catch (err) {
    handleError(err, res);
  }
});

procurementRouter.get("/goods-receipts/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    const receipt = db.prepare("SELECT * FROM goods_receipts WHERE id = ?").get(id);
    if (!receipt) throw new ProcurementError(404, `Recebimento ${id} não encontrado.`);
    const items = db.prepare("SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ? ORDER BY id").all(id);
    res.json({ receipt, items });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Estoque operacional
// ===========================================================================

procurementRouter.get("/stock/current", (_req, res) => {
  try {
    res.json(getCurrentOperationalStock(getDb()));
  } catch (err) {
    handleError(err, res);
  }
});

procurementRouter.get("/stock/movements", (req, res) => {
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ movements: listMovements(getDb(), { type, search, limit }) });
});
