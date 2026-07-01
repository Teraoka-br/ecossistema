import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import {
  createSeparationBatch,
  confirmPartialItem,
  confirmFullDevice,
  confirmAll,
  cancelPartialItem,
  cancelFullDevice,
  cancelBatch,
  getBatchState,
  listSeparationBatches,
  getSeparationBatch,
  getSeparationItem,
  SeparationError,
} from "../../separation/separation-service.js";

export const separationRouter = Router();

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof SeparationError) {
    res.status(err.statusCode).json({ error: err.message, details: err.details });
    return;
  }
  res.status(500).json({ error: (err as Error).message || "Erro interno." });
}

function idParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new SeparationError(400, `ID inválido: "${raw}".`);
  return n;
}

function pagination(q: Record<string, unknown>) {
  return {
    limit: Math.min(Number(q.limit) || 50, 200),
    offset: Number(q.offset) || 0,
  };
}

// ---------------------------------------------------------------------------
// Listar lotes
// ---------------------------------------------------------------------------

separationRouter.get("/separation-batches", (req, res) => {
  try {
    const q = req.query as Record<string, string>;
    const { limit, offset } = pagination(q);
    const { batches, total } = listSeparationBatches(getDb(), {
      status: q.status as any,
      batchNumber: q.batchNumber,
      createdBy: q.createdBy,
      imei: q.imei,
      os: q.os,
      idPedido: q.idPedido,
      matchRunId: q.matchRunId ? Number(q.matchRunId) : undefined,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      limit,
      offset,
    });
    res.json({ batches, total, limit, offset });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Criar lote
// ---------------------------------------------------------------------------

const createBatchSchema = z.object({
  createdBy: z.string().min(1),
  notes: z.string().optional().nullable(),
  fullDeviceResultIds: z.array(z.number().int().positive()).optional().default([]),
  partialMatchResultIds: z.array(z.number().int().positive()).optional().default([]),
  idempotencyKey: z.string().min(1),
  matchRunId: z.number().int().positive(),
});

separationRouter.post("/separation-batches", (req, res) => {
  try {
    const body = createBatchSchema.parse(req.body);
    const batch = createSeparationBatch(getDb(), body);
    res.status(201).json({ batch });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Lote por ID
// ---------------------------------------------------------------------------

separationRouter.get("/separation-batches/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const batch = getSeparationBatch(getDb(), id);
    if (!batch) { res.status(404).json({ error: `Lote ${id} não encontrado.` }); return; }
    res.json({ batch });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Estado detalhado do lote
// ---------------------------------------------------------------------------

separationRouter.get("/separation-batches/:id/state", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const state = getBatchState(getDb(), id);
    res.json(state);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Confirmar lote inteiro
// ---------------------------------------------------------------------------

const confirmAllSchema = z.object({
  confirmedBy: z.string().min(1),
  notes: z.string().optional().nullable(),
  idempotencyKey: z.string().min(1),
});

separationRouter.post("/separation-batches/:id/confirm-all", (req, res) => {
  try {
    const batchId = idParam(req.params.id);
    const body = confirmAllSchema.parse(req.body);
    confirmAll(getDb(), { batchId, ...body });
    const state = getBatchState(getDb(), batchId);
    res.json({ message: "Lote confirmado.", state });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Cancelar lote
// ---------------------------------------------------------------------------

const cancelBatchSchema = z.object({
  cancelledBy: z.string().min(1),
  cancelReason: z.string().min(10),
});

separationRouter.post("/separation-batches/:id/cancel", (req, res) => {
  try {
    const batchId = idParam(req.params.id);
    const body = cancelBatchSchema.parse(req.body);
    const batch = cancelBatch(getDb(), { batchId, ...body });
    res.json({ batch });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Confirmar aparelho (full kit)
// ---------------------------------------------------------------------------

const confirmDeviceSchema = z.object({
  confirmedBy: z.string().min(1),
  notes: z.string().optional().nullable(),
  idempotencyKey: z.string().min(1),
});

separationRouter.post("/separation-batches/:batchId/devices/:deviceResultId/confirm", (req, res) => {
  try {
    const batchId = idParam(req.params.batchId);
    const deviceResultId = idParam(req.params.deviceResultId);
    const body = confirmDeviceSchema.parse(req.body);
    confirmFullDevice(getDb(), { batchId, deviceResultId, ...body });
    const state = getBatchState(getDb(), batchId);
    res.json({ message: "Aparelho confirmado.", state });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Cancelar aparelho (full kit)
// ---------------------------------------------------------------------------

const cancelDeviceSchema = z.object({
  cancelledBy: z.string().min(1),
  cancelReason: z.string().min(10),
});

separationRouter.post("/separation-batches/:batchId/devices/:deviceResultId/cancel", (req, res) => {
  try {
    const batchId = idParam(req.params.batchId);
    const deviceResultId = idParam(req.params.deviceResultId);
    const body = cancelDeviceSchema.parse(req.body);
    cancelFullDevice(getDb(), { batchId, deviceResultId, ...body });
    const state = getBatchState(getDb(), batchId);
    res.json({ message: "Aparelho cancelado.", state });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Confirmar item parcial
// ---------------------------------------------------------------------------

const confirmItemSchema = z.object({
  confirmedBy: z.string().min(1),
  notes: z.string().optional().nullable(),
  idempotencyKey: z.string().min(1),
});

separationRouter.post("/separation-items/:id/confirm", (req, res) => {
  try {
    const itemId = idParam(req.params.id);
    const body = confirmItemSchema.parse(req.body);
    const item = confirmPartialItem(getDb(), { itemId, ...body });
    res.json({ item });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Cancelar item parcial
// ---------------------------------------------------------------------------

const cancelItemSchema = z.object({
  cancelledBy: z.string().min(1),
  cancelReason: z.string().min(10),
});

separationRouter.post("/separation-items/:id/cancel", (req, res) => {
  try {
    const itemId = idParam(req.params.id);
    const body = cancelItemSchema.parse(req.body);
    const item = cancelPartialItem(getDb(), { itemId, ...body });
    res.json({ item });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Item por ID
// ---------------------------------------------------------------------------

separationRouter.get("/separation-items/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const item = getSeparationItem(getDb(), id);
    if (!item) { res.status(404).json({ error: `Item ${id} não encontrado.` }); return; }
    res.json({ item });
  } catch (err) {
    handleError(err, res);
  }
});
