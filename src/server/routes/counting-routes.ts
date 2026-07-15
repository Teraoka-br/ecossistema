import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { getActiveBatch } from "../../db/repository.js";
import * as svc from "../../counting/counting-service.js";
import { CountingError } from "../../counting/counting-service.js";
import * as q from "../../db/counting-queries.js";
import * as partKeysSvc from "../../operational/part-keys-service.js";
import type { CountScanRow, CountSessionRow, StockSnapshotRow } from "../../db/counting-repository.js";
import type { CountScan, CountSession, StockSnapshot, StockSnapshotItem } from "../../shared/types.js";

export const countingRouter = Router();

function toSession(r: CountSessionRow): CountSession {
  return {
    id: r.id,
    importBatchId: r.import_batch_id,
    responsibleName: r.responsible_name,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    notes: r.notes,
    finalizedBy: r.finalized_by,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancelReason: r.cancel_reason,
    countType: r.count_type ?? "OFICIAL",
  };
}

function toScan(r: CountScanRow): CountScan {
  return {
    id: r.id,
    sessionId: r.session_id,
    reference: r.reference,
    referenceNorm: r.reference_norm,
    chavePeca: r.chave_peca,
    chavePecaNorm: r.chave_peca_norm,
    mappingStatus: r.mapping_status,
    source: r.source,
    scannedAt: r.scanned_at,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancelReason: r.cancel_reason,
  };
}

function toSnapshot(r: StockSnapshotRow): StockSnapshot {
  return {
    id: r.id,
    countSessionId: r.count_session_id,
    importBatchId: r.import_batch_id,
    status: r.status,
    totalUnits: r.total_units,
    createdAt: r.created_at,
    createdBy: r.created_by,
    notes: r.notes,
  };
}

function toSnapshotItem(r: { id: number; snapshot_id: number; reference: string; reference_norm: string; chave_peca: string | null; chave_peca_norm: string | null; counted_quantity: number }): StockSnapshotItem {
  return {
    id: r.id,
    snapshotId: r.snapshot_id,
    reference: r.reference,
    referenceNorm: r.reference_norm,
    chavePeca: r.chave_peca,
    chavePecaNorm: r.chave_peca_norm,
    countedQuantity: r.counted_quantity,
  };
}

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof CountingError) {
    res.status(err.statusCode).json({ error: err.message, details: err.details });
    return;
  }
  res.status(500).json({ error: (err as Error).message || "Erro interno." });
}

function idParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CountingError(400, `Parâmetro de id inválido: "${raw}".`);
  return n;
}

// ===========================================================================
// Sessões
// ===========================================================================

countingRouter.get("/count-sessions/active", (_req, res) => {
  const session = svc.getActiveSession(getDb());
  res.json({ session: session ? toSession(session) : null });
});

const createSessionSchema = z.object({
  responsibleName: z.string().min(1),
  notes: z.string().optional().nullable(),
  countType: z.enum(["OFICIAL", "PARCIAL_TESTE"]).optional(),
});

countingRouter.post("/count-sessions", (req, res) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const session = svc.createSession(getDb(), parsed.data);
    res.status(201).json({ session: toSession(session) });
  } catch (err) {
    handleError(err, res);
  }
});

countingRouter.get("/count-sessions/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const session = svc.getSessionOrThrow(getDb(), id);
    res.json({ session: toSession(session) });
  } catch (err) {
    handleError(err, res);
  }
});

const cancelSchema = z.object({
  cancelledBy: z.string().min(1),
  cancelReason: z.string().min(1),
});

countingRouter.post("/count-sessions/:id/cancel", (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const session = svc.cancelSession(getDb(), id, parsed.data);
    res.json({ session: toSession(session) });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Scans
// ===========================================================================

const registerScanSchema = z.object({
  reference: z.string().min(1),
  source: z.string().optional().nullable(),
});

countingRouter.post("/count-sessions/:id/scans", (req, res) => {
  const parsed = registerScanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Referência (reference) é obrigatória.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const result = svc.registerScan(getDb(), id, parsed.data);
    res.status(201).json({ scan: toScan(result.scan), totalForReference: result.totalForReference });
  } catch (err) {
    handleError(err, res);
  }
});

countingRouter.get("/count-sessions/:id/scans", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const onlyActive = req.query.onlyActive === "true";
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const scans = svc.listScans(getDb(), id, { onlyActive, limit });
    res.json({ scans: scans.map(toScan) });
  } catch (err) {
    handleError(err, res);
  }
});

countingRouter.post("/count-scans/:scanId/cancel", (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const scanId = idParam(req.params.scanId);
    const scan = svc.cancelScan(getDb(), scanId, parsed.data);
    res.json({ scan: toScan(scan) });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Resumo e pendências
// ===========================================================================

countingRouter.get("/count-sessions/:id/summary", (req, res) => {
  try {
    const id = idParam(req.params.id);
    res.json(svc.buildFinalizeSummary(getDb(), id));
  } catch (err) {
    handleError(err, res);
  }
});

countingRouter.get("/count-sessions/:id/pending", (req, res) => {
  try {
    const id = idParam(req.params.id);
    res.json({ pending: svc.getPending(getDb(), id) });
  } catch (err) {
    handleError(err, res);
  }
});

// Estado consolidado — única fonte de verdade da tela /bipagem (sobrevive a F5,
// reinício de front/back, reabertura). O frontend recarrega isto após cada mutação.
countingRouter.get("/count-sessions/:id/state", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const state = svc.getSessionState(getDb(), id);
    res.json({
      session: toSession(state.session),
      summary: state.summary,
      recentScans: state.recentScans.map(toScan),
      totalsByReference: state.totalsByReference,
      pending: state.pending,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// Catálogo de CHAVEPECA vinculado à SESSÃO (lote da sessão) — nunca o lote ativo mais recente.
countingRouter.get("/count-sessions/:id/reference-catalog/keys", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    const session = svc.getSessionOrThrow(db, id);
    if (!session.import_batch_id) return res.json({ keys: [] });
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    res.json({ keys: q.distinctCatalogKeys(db, session.import_batch_id, search) });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Catálogo de referências e resolução manual
// ===========================================================================

countingRouter.get("/reference-catalog/keys", (req, res) => {
  const db = getDb();
  const batch = getActiveBatch(db);
  if (!batch) return res.json({ keys: [] });
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  res.json({ keys: q.distinctCatalogKeys(db, batch.id, search) });
});

const resolveSchema = z.object({
  referenceNorm: z.string().min(1),
  chavePeca: z.string().min(1),
  responsibleName: z.string().min(1),
  notes: z.string().optional().nullable(),
  createIfMissing: z.boolean().optional(),
});

countingRouter.post("/count-sessions/:id/references/resolve", (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const mapping = svc.resolveReferenceManually(getDb(), id, parsed.data);
    res.json({ mapping });
  } catch (err) {
    handleError(err, res);
  }
});

const cancelPendingSchema = z.object({
  referenceNorm: z.string().min(1),
  cancelledBy: z.string().min(1),
  cancelReason: z.string().min(1),
});

countingRouter.post("/count-sessions/:id/references/cancel-scans", (req, res) => {
  const parsed = cancelPendingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Corpo inválido.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const cancelled = svc.cancelPendingScans(getDb(), id, parsed.data);
    res.json({ cancelled });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Finalização
// ===========================================================================

const finalizeSchema = z.object({
  finalizedBy: z.string().min(1),
  forceIncomplete: z.boolean().optional(),
  forceReason: z.string().optional(),
});

countingRouter.post("/count-sessions/:id/finalize", (req, res) => {
  const parsed = finalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Responsável (finalizedBy) é obrigatório.", details: parsed.error.flatten() });
  }
  try {
    const id = idParam(req.params.id);
    const result = svc.finalizeSession(getDb(), id, parsed.data);
    res.json({
      snapshot: toSnapshot(result.snapshot),
      summary: result.summary,
      alreadyFinalized: result.alreadyFinalized,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Snapshots de estoque
// ===========================================================================

countingRouter.get("/stock-snapshots/latest", (_req, res) => {
  const db = getDb();
  const snapshot = q.latestOfficialSnapshot(db);
  if (!snapshot) return res.json({ snapshot: null, items: [] });
  res.json({ snapshot: toSnapshot(snapshot), items: q.listSnapshotItems(db, snapshot.id).map(toSnapshotItem) });
});

countingRouter.get("/stock-snapshots/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    const snapshot = q.getSnapshotById(db, id);
    if (!snapshot) throw new CountingError(404, `Snapshot ${id} não encontrado.`);
    res.json({ snapshot: toSnapshot(snapshot), items: q.listSnapshotItems(db, snapshot.id).map(toSnapshotItem) });
  } catch (err) {
    handleError(err, res);
  }
});

// ===========================================================================
// Catálogo de chaves personalizadas (custom_part_keys)
// ===========================================================================

countingRouter.get("/part-keys", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  res.json({ keys: partKeysSvc.listPartKeys(getDb(), search) });
});

countingRouter.get("/part-keys/all", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const db = getDb();
  const batch = getActiveBatch(db);
  res.json({ keys: partKeysSvc.listAllPartKeys(db, batch?.id ?? null, search) });
});

const partKeyCreateSchema = z.object({
  chavePeca: z.string().min(1),
  descricao: z.string().optional(),
  createdBy: z.string().optional(),
});

countingRouter.post("/part-keys", (req, res, next) => {
  try {
    const body = partKeyCreateSchema.parse(req.body);
    const key = partKeysSvc.createPartKey(getDb(), body);
    res.status(201).json({ key });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if ((err as NodeJS.ErrnoException).message?.includes("UNIQUE")) {
      res.status(409).json({ error: "CHAVEPECA já existe no catálogo." }); return;
    }
    next(err);
  }
});

const partKeyUpdateSchema = z.object({
  chavePeca: z.string().min(1).optional(),
  descricao: z.string().nullable().optional(),
  editedBy: z.string().optional(),
  notes: z.string().optional(),
});

countingRouter.patch("/part-keys/:id", (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    const body = partKeyUpdateSchema.parse(req.body);
    const key = partKeysSvc.updatePartKey(getDb(), id, body);
    res.json({ key });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if ((err as Error).message === "Chave não encontrada.") { res.status(404).json({ error: "Chave não encontrada." }); return; }
    if ((err as NodeJS.ErrnoException).message?.includes("UNIQUE")) {
      res.status(409).json({ error: "CHAVEPECA já existe no catálogo." }); return;
    }
    next(err);
  }
});

// Editar chave importada (por chave_peca_norm) — cria/atualiza entrada custom
const partKeyImportedEditSchema = z.object({
  chavePeca: z.string().min(1).optional(),
  descricao: z.string().nullable().optional(),
  editedBy: z.string().optional(),
  notes: z.string().optional(),
});

countingRouter.patch("/part-keys/imported/:norm", (req, res, next) => {
  try {
    const norm = req.params.norm;
    const body = partKeyImportedEditSchema.parse(req.body);
    const db = getDb();
    const batch = getActiveBatch(db);
    const key = partKeysSvc.editImportedKey(db, norm, body, batch?.id ?? null);
    res.json({ key });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if ((err as NodeJS.ErrnoException).message?.includes("UNIQUE")) {
      res.status(409).json({ error: "CHAVEPECA já existe no catálogo." }); return;
    }
    next(err);
  }
});

// Histórico de edições de uma chave (por norm)
countingRouter.get("/part-keys/history/:norm", (req, res) => {
  const norm = req.params.norm;
  const history = partKeysSvc.getPartKeyHistory(getDb(), norm);
  res.json({ history });
});

countingRouter.delete("/part-keys/:id", (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    partKeysSvc.deletePartKey(getDb(), id);
    res.json({ ok: true });
  } catch (err) {
    if ((err as Error).message === "Chave não encontrada.") { res.status(404).json({ error: "Chave não encontrada." }); return; }
    next(err);
  }
});
