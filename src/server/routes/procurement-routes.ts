import fs from "node:fs";
import XLSX from "xlsx";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { getSystemState } from "../../system/system-service.js";
import * as proc from "../../operational/procurement-service.js";
import { ProcurementError } from "../../operational/procurement-service.js";
import * as recv from "../../operational/receiving-service.js";
import { getCurrentOperationalStock, listMovements, StockError } from "../../operational/stock-service.js";
import * as cotacaoSvc from "../../operational/cotacao-service.js";
import { projectCotacaoImpact, savePurchaseDecisionSnapshot } from "../../match/cotacao-projection-service.js";
import { config } from "../config.js";

export const procurementRouter = Router();

const uploadCotacao = multer({
  dest: config.uploadTmpDir,
  limits: { fileSize: config.maxUploadBytes },
});

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
    const db = getDb();
    const order = proc.cancelPurchaseOrder(db, id, { ...parsed.data, cancelledBy });
    // Reprocessar motor após cancelamento para reclassificar casos afetados
    import("../../match/engine-orchestrator.js").then(async ({ requestMatchRecompute, processPendingRecompute }) => {
      requestMatchRecompute(db, `CANCEL_ORDER_${id}`, "purchase_order", id);
      await processPendingRecompute(db);
    }).catch(() => { /* motor não-crítico */ });
    res.json({ order });
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

procurementRouter.post("/purchase-orders/:id/receipts/confirm", async (req, res, next) => {
  const parsed = confirmReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    const receivedBy = req.sessionUser!.displayName;
    const result = recv.confirmReceipt(db, id, { ...parsed.data, receivedBy });

    // Disparar recompute do motor após o COMMIT — falha não desfaz o recebimento
    let matchTriggered = false;
    let matchExecuted = false;
    let matchError: string | null = null;
    let matchStats: Record<string, unknown> = {};
    try {
      const { requestMatchRecompute, processPendingRecompute } = await import("../../match/engine-orchestrator.js");
      requestMatchRecompute(db, `RECEIPT_${id}`, "goods_receipt", result.receiptId);
      matchTriggered = true;
      const matchResult = await processPendingRecompute(db);
      if (matchResult) {
        matchExecuted = true;
        matchStats = {
          fullKitsFound: matchResult.fullKitsFound,
          partialKitsFound: matchResult.partialKitsFound,
          casesChanged: matchResult.casesChanged,
        };
      }
    } catch (e) {
      matchError = (e as Error).message;
    }

    res.json({ ...result, matchTriggered, matchExecuted, matchStats, matchError });
  } catch (err) {
    if (err instanceof ProcurementError || err instanceof StockError) {
      return res.status(err.statusCode).json({ error: err.message, details: err.details });
    }
    next(err);
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

// ===========================================================================
// Necessidades de compra (derivadas dos casos PEDIR_PECA)
// ===========================================================================

procurementRouter.get("/necessidades", (_req, res) => {
  try {
    res.json({ items: cotacaoSvc.listNecessidades(getDb()) });
  } catch (err) { handleError(err, res); }
});

// Export CSV template para cotação
procurementRouter.get("/necessidades/detail/:chavePeca", (req, res) => {
  try {
    const chavePeca = decodeURIComponent(req.params.chavePeca);
    res.json(cotacaoSvc.getCasesNeedingPart(getDb(), chavePeca));
  } catch (err) { handleError(err, res); }
});

procurementRouter.get("/necessidades/leverage", (req, res) => {
  try {
    const pecasParam = typeof req.query.pecas === "string" ? req.query.pecas : "";
    const selectedParts = pecasParam.split(",").map(s => s.trim()).filter(Boolean);
    res.json(cotacaoSvc.getLeverageData(getDb(), selectedParts));
  } catch (err) { handleError(err, res); }
});

procurementRouter.get("/necessidades/export.xlsx", (req, res) => {
  try {
    const items = cotacaoSvc.listNecessidades(getDb());
    const selected = typeof req.query.pecas === "string"
      ? new Set(req.query.pecas.split(",").map(s => s.trim()).filter(Boolean))
      : null;
    const rows = selected ? items.filter(i => selected.has(i.chavePeca)) : items;
    const buffer = cotacaoSvc.buildNecessidadesXlsx(rows);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="cotacao_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buffer);
  } catch (err) { handleError(err, res); }
});

// Recebe o template preenchido pelo fornecedor (.xlsx) e devolve os itens
// interpretados — evita o parser CSV frágil a locale (vírgula decimal pt-BR).
procurementRouter.post("/cotacoes/parse", uploadCotacao.single("file"), (req, res) => {
  if (!req.file) { res.status(400).json({ error: "Arquivo não enviado." }); return; }
  try {
    const items = cotacaoSvc.parseCotacaoXlsx(req.file.path);
    res.json({ items });
  } catch (err) {
    handleError(err, res);
  } finally {
    try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
  }
});

// ===========================================================================
// Projeção canônica de match para aprovação de cotação
// ===========================================================================

const projectMatchSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    chavePeca: z.string().min(1),
    qtde: z.number().int().positive(),
    valorUnitario: z.number().nonnegative(),
  })).min(1),
});

procurementRouter.post("/cotacoes/project-match", (req, res) => {
  const parsed = projectMatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  try {
    const result = projectCotacaoImpact(getDb(), parsed.data.items);
    res.json(result);
  } catch (err) { handleError(err, res); }
});

// ===========================================================================
// Cotações
// ===========================================================================

const createCotacaoSchema = z.object({
  supplier: z.string().min(1),
  notes: z.string().optional().nullable(),
  items: z.array(z.object({
    chavePeca: z.string().min(1),
    qtde: z.number().int().positive(),
    valorUnitario: z.number().nonnegative(),
  })).min(1),
});

procurementRouter.post("/cotacoes", (req, res) => {
  const parsed = createCotacaoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  try {
    const createdBy = req.sessionUser?.displayName;
    const cotacao = cotacaoSvc.createCotacao(getDb(), { ...parsed.data, createdBy });
    res.status(201).json({ cotacao });
  } catch (err) { handleError(err, res); }
});

procurementRouter.get("/cotacoes", (_req, res) => {
  try {
    res.json({ cotacoes: cotacaoSvc.listCotacoes(getDb()) });
  } catch (err) { handleError(err, res); }
});

procurementRouter.get("/cotacoes/:id", (req, res) => {
  try {
    res.json({ cotacao: cotacaoSvc.getCotacao(getDb(), idParam(req.params.id)) });
  } catch (err) { handleError(err, res); }
});

const aprovaCotacaoSchema2 = z.object({
  aprovados: z.array(z.object({
    id:           z.number().int().positive(),
    qtde:         z.number().int().positive(),
    chavePeca:    z.string().min(1).optional(),
    valorUnitario: z.number().nonnegative().optional(),
  })).min(1),
});

procurementRouter.post("/cotacoes/:id/aprovar", (req, res) => {
  const parsed = aprovaCotacaoSchema2.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  try {
    const db = getDb();
    const cotacaoId = idParam(req.params.id);
    const approvedBy = req.sessionUser?.displayName ?? "Sistema";
    const result = cotacaoSvc.aprovaCotacao(db, cotacaoId, {
      aprovados: parsed.data.aprovados.map((a) => a.id),
      approvedBy,
    });

    // Persistir snapshot de decisão (não-crítico — falha não desfaz a aprovação)
    try {
      const snapshotItems = parsed.data.aprovados
        .filter((a): a is typeof a & { chavePeca: string; valorUnitario: number } =>
          typeof a.chavePeca === "string" && typeof a.valorUnitario === "number")
        .map((a) => ({ id: a.id, chavePeca: a.chavePeca, qtde: a.qtde, valorUnitario: a.valorUnitario }));
      if (snapshotItems.length > 0) {
        const projection = projectCotacaoImpact(db, snapshotItems);
        savePurchaseDecisionSnapshot(db, cotacaoId, approvedBy, projection);
      }
    } catch { /* snapshot não-crítico */ }

    res.json(result);
  } catch (err) { handleError(err, res); }
});

procurementRouter.post("/cotacoes/:id/cancelar", (req, res) => {
  try {
    cotacaoSvc.cancelCotacao(getDb(), idParam(req.params.id));
    res.json({ ok: true });
  } catch (err) { handleError(err, res); }
});

// Export XLSX do pedido aprovado — usa quantidades gravadas em purchase_order_items
procurementRouter.get("/cotacoes/:id/pedido.xlsx", (req, res) => {
  try {
    const db = getDb();
    const cotacao = cotacaoSvc.getCotacao(db, idParam(req.params.id));
    if (cotacao.status !== "APPROVED") return res.status(400).json({ error: "Cotação não aprovada." });

    // Mapa: chavePeca → valorUnitario (da cotação)
    const precoMap = new Map(cotacao.items.map(i => [i.chavePeca, i.valorUnitario]));

    // Quantidades aprovadas vêm do purchase_order, não do cotacao_items
    type OiRow = { chave_peca: string; quantity_ordered: number };
    const orderItems = db.prepare(
      "SELECT chave_peca, quantity_ordered FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY chave_peca"
    ).all(cotacao.purchaseOrderId) as OiRow[];

    const rows: (string | number)[][] = orderItems.map(oi => {
      const valorUn = precoMap.get(oi.chave_peca) ?? 0;
      return [oi.chave_peca, oi.quantity_ordered, valorUn, oi.quantity_ordered * valorUn];
    });
    const total = rows.reduce((s, r) => s + (r[3] as number), 0);

    const aoa: (string | number)[][] = [
      ["PEÇA", "QTDE", "VALOR UN", "VALOR TOTAL"],
      ...rows,
      ["", "", "TOTAL", total],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Formatar colunas de valor como moeda BR
    const fmt = '#.##0,00';
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    for (let R = 1; R <= range.e.r; R++) {
      for (const C of [2, 3]) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (ws[addr] && typeof ws[addr].v === "number") ws[addr].z = fmt;
      }
    }
    ws["!cols"] = [{ wch: 32 }, { wch: 8 }, { wch: 14 }, { wch: 14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pedido");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const safeName = `${cotacao.supplier.replace(/[^a-z0-9]/gi, "_")}`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="pedido_${cotacao.id}_${safeName}.xlsx"`);
    res.send(buf);
  } catch (err) { handleError(err, res); }
});
