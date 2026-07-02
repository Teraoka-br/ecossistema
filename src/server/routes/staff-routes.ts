import { Router } from "express";
import { z } from "zod";
import { listStaff, createStaff, updateStaff, StaffError } from "../../staff/staff-service.js";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { logAudit } from "../../audit/audit-service.js";

export const staffRouter = Router();

staffRouter.get("/staff", requireAuth, (_req, res) => {
  res.json({ staff: listStaff(getDb()) });
});

const CreateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["TECHNICIAN"]).default("TECHNICIAN"),
});

staffRouter.post("/staff", requireAuth, (req, res, next) => {
  try {
    const body = CreateSchema.parse(req.body);
    const member = createStaff(getDb(), body);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "STAFF_CREATED", entityType: "STAFF", entityId: String(member.id), meta: { name: member.name } });
    res.status(201).json({ staff: member });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos.", details: err.issues }); return; }
    if (err instanceof StaffError) { res.status(400).json({ error: err.message }); return; }
    next(err);
  }
});

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

staffRouter.patch("/staff/:id", requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = UpdateSchema.parse(req.body);
    const member = updateStaff(getDb(), id, body);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "STAFF_UPDATED", entityType: "STAFF", entityId: String(id), meta: body });
    res.json({ staff: member });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (err instanceof StaffError) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); return; }
    next(err);
  }
});
