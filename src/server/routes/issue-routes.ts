import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import {
  listIssues,
  createIssue,
  updateIssue,
  type IssueModule,
  type IssueSeverityReport,
  type IssueStatus,
} from "../../issue/issue-service.js";

export const issueRouter = Router();

const MODULES = [
  "DASHBOARD","FILA_REPAROS","ANALISE","ESTOQUE",
  "REFERENCIAS","PEDIDOS","CONTAGEM","MATCH_RULES","USUARIOS","OUTRO",
] as const;
const SEVERITIES = ["LOW","MEDIUM","HIGH","CRITICAL"] as const;
const STATUSES   = ["OPEN","IN_ANALYSIS","RESOLVED","DISMISSED"] as const;

const createSchema = z.object({
  title:         z.string().min(3).max(200),
  description:   z.string().max(2000).optional(),
  module:        z.enum(MODULES),
  severity:      z.enum(SEVERITIES),
  metadata_json: z.string().max(4000).optional(),
});

const updateSchema = z.object({
  status:           z.enum(STATUSES).optional(),
  resolution_notes: z.string().max(2000).optional(),
});

issueRouter.get("/issue-reports", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const user = (req as unknown as { user?: { id: number; role: string; username?: string } }).user;
    const isAdmin = user?.role === "ADMIN";
    const issues = listIssues(db, { userId: user?.id, isAdmin });
    res.json({ issues });
  } catch (err) {
    next(err);
  }
});

issueRouter.post("/issue-reports", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const user = (req as unknown as { user?: { id: number; role: string; username?: string } }).user;
    const body = createSchema.parse(req.body);
    const issue = createIssue(db, {
      title:        body.title,
      description:  body.description,
      module:       body.module as IssueModule,
      severity:     body.severity as IssueSeverityReport,
      userId:       user?.id ?? null,
      userName:     user?.username ?? null,
      metadataJson: body.metadata_json ?? null,
    });
    res.status(201).json({ issue });
  } catch (err) {
    next(err);
  }
});

issueRouter.patch("/issue-reports/:id", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const db = getDb();
    const user = (req as unknown as { user?: { id: number } }).user;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "ID inválido" }); return; }
    const body = updateSchema.parse(req.body);
    const updated = updateIssue(db, id, {
      status:           body.status as IssueStatus | undefined,
      resolution_notes: body.resolution_notes,
      resolvedByUserId: user?.id,
    });
    if (!updated) { res.status(404).json({ error: "Problema não encontrado" }); return; }
    res.json({ issue: updated });
  } catch (err) {
    next(err);
  }
});
