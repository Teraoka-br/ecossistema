import { Router } from "express";
import { z } from "zod";
import {
  listRepairCases, getRepairCaseWithParts, createRepairCase, updateRepairCase,
  completeAnalysis, closeRepairCase, addPart, updatePart, cancelPart,
  setManualPriority, removeManualPriority, getPrioritiesByCase,
  RepairError,
} from "../../repair/repair-service.js";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { logAudit } from "../../audit/audit-service.js";

export const repairRouter = Router();

function handleRepairError(err: unknown, res: import("express").Response): boolean {
  if (err instanceof RepairError) {
    const statusMap: Record<string, number> = { NOT_FOUND: 404, DUPLICATE_ACTIVE_IMEI: 409, ALREADY_CLOSED: 409, ALREADY_PRIORITY: 409, NO_PRIORITY: 409, ALREADY_COMPLETED: 409 };
    res.status(statusMap[err.code] ?? 422).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

// ─── Repair Cases ─────────────────────────────────────────────────────────

repairRouter.get("/repair-cases", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  const result = listRepairCases(getDb(), {
    workflowStatus: req.query.workflow as any,
    analysisStatus: req.query.analysis as any,
    limit, offset,
  });
  res.json(result);
});

repairRouter.get("/repair-cases/:id", requireAuth, (req, res) => {
  const rc = getRepairCaseWithParts(getDb(), Number(req.params.id));
  if (!rc) { res.status(404).json({ error: "Caso não encontrado." }); return; }
  res.json({ repairCase: rc });
});

const CaseSchema = z.object({
  imei: z.string().nullish(),
  os: z.string().nullish(),
  brand: z.string().nullish(),
  model: z.string().nullish(),
  entryDate: z.string().nullish(),
  ageDays: z.number().int().nonnegative().nullish(),
  cost: z.number().nonnegative().nullish(),
  estimatedSale: z.number().nonnegative().nullish(),
  notes: z.string().nullish(),
  assignedTechnicianId: z.number().int().positive().nullish(),
});

repairRouter.post("/repair-cases", requireAuth, (req, res, next) => {
  try {
    const body = CaseSchema.parse(req.body);
    const rc = createRepairCase(getDb(), { ...body, createdByUserId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "REPAIR_CASE_CREATED", entityType: "REPAIR_CASE", entityId: String(rc.id) });
    res.status(201).json({ repairCase: rc });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos.", details: err.issues }); return; }
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

const UpdateCaseSchema = CaseSchema.extend({ workflowStatus: z.string().optional() });

repairRouter.patch("/repair-cases/:id", requireAuth, (req, res, next) => {
  try {
    const body = UpdateCaseSchema.parse(req.body);
    const rc = updateRepairCase(getDb(), Number(req.params.id), { ...body as any, updatedByUserId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "REPAIR_CASE_UPDATED", entityType: "REPAIR_CASE", entityId: req.params.id });
    res.json({ repairCase: rc });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.post("/repair-cases/:id/complete-analysis", requireAuth, (req, res, next) => {
  try {
    const rc = completeAnalysis(getDb(), Number(req.params.id), req.sessionUser!.id);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "ANALYSIS_COMPLETED", entityType: "REPAIR_CASE", entityId: req.params.id });
    res.json({ repairCase: rc });
  } catch (err) {
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.post("/repair-cases/:id/cancel", requireAuth, (req, res, next) => {
  try {
    const rc = closeRepairCase(getDb(), Number(req.params.id), { status: "CANCELADO", userId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "REPAIR_CASE_CANCELLED", entityType: "REPAIR_CASE", entityId: req.params.id });
    res.json({ repairCase: rc });
  } catch (err) {
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.post("/repair-cases/:id/sell-as-is", requireAuth, (req, res, next) => {
  try {
    const rc = closeRepairCase(getDb(), Number(req.params.id), { status: "VENDA_ESTADO", userId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "REPAIR_CASE_SOLD_AS_IS", entityType: "REPAIR_CASE", entityId: req.params.id });
    res.json({ repairCase: rc });
  } catch (err) {
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.post("/repair-cases/:id/complete", requireAuth, (req, res, next) => {
  try {
    const rc = closeRepairCase(getDb(), Number(req.params.id), { status: "CONCLUIDO", userId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "REPAIR_CASE_COMPLETED", entityType: "REPAIR_CASE", entityId: req.params.id });
    res.json({ repairCase: rc });
  } catch (err) {
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

// ─── Parts ────────────────────────────────────────────────────────────────

const PartSchema = z.object({
  description: z.string().nullish(),
  chavePeca: z.string().nullish(),
  status: z.enum(["PEDIR_PECA","AGUARDANDO_RECEBIMENTO","INDICADA","RESERVADA","SEPARADA","CANCELADA","VERIFICAR"]).optional(),
});

repairRouter.post("/repair-cases/:id/parts", requireAuth, (req, res, next) => {
  try {
    const body = PartSchema.parse(req.body);
    const rc = getRepairCaseWithParts(getDb(), Number(req.params.id));
    if (!rc) { res.status(404).json({ error: "Caso não encontrado." }); return; }
    const part = addPart(getDb(), Number(req.params.id), { ...body as any, createdByUserId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "PART_ADDED", entityType: "PART_REQUEST", entityId: String(part.id), meta: { repairCaseId: Number(req.params.id) } });
    res.status(201).json({ part });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.patch("/part-requests/:id", requireAuth, (req, res, next) => {
  try {
    const body = PartSchema.parse(req.body);
    const part = updatePart(getDb(), Number(req.params.id), { ...body as any, updatedByUserId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "PART_UPDATED", entityType: "PART_REQUEST", entityId: req.params.id });
    res.json({ part });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.post("/part-requests/:id/cancel", requireAuth, (req, res, next) => {
  try {
    const part = cancelPart(getDb(), Number(req.params.id), req.sessionUser!.id);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "PART_CANCELLED", entityType: "PART_REQUEST", entityId: req.params.id });
    res.json({ part });
  } catch (err) {
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

// ─── Priorities ───────────────────────────────────────────────────────────

repairRouter.post("/repair-cases/:id/manual-priority", requireAuth, (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().min(10) }).parse(req.body);
    const priority = setManualPriority(getDb(), Number(req.params.id), { reason, userId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "PRIORITY_SET", entityType: "REPAIR_CASE", entityId: req.params.id, meta: { reason } });
    res.status(201).json({ priority });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Justificativa deve ter pelo menos 10 caracteres." }); return; }
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.post("/repair-cases/:id/manual-priority/remove", requireAuth, (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);
    removeManualPriority(getDb(), Number(req.params.id), { reason, userId: req.sessionUser!.id });
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "PRIORITY_REMOVED", entityType: "REPAIR_CASE", entityId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    if (handleRepairError(err, res)) return;
    next(err);
  }
});

repairRouter.get("/repair-cases/:id/priorities", requireAuth, (req, res) => {
  const priorities = getPrioritiesByCase(getDb(), Number(req.params.id));
  res.json({ priorities });
});
