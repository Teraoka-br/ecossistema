/**
 * Grupos de compatibilidade simétrica de peças.
 *
 * Permissão: MANAGE_PART_COMPATIBILITY ou ADMIN.
 * Leitura: qualquer usuário autenticado.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { requireAuth, requirePermissionOrAdmin } from "../middleware/auth-middleware.js";
import {
  listCompatibilityGroups,
  getCompatibilityGroup,
  createCompatibilityGroup,
  addGroupMember,
  removeGroupMember,
  PartCompatibilityError,
} from "../../operational/part-compatibility-service.js";
import { processPendingRecompute } from "../../match/engine-orchestrator.js";

export const partCompatibilityRouter = Router();

const PERM = "MANAGE_PART_COMPATIBILITY";

// ─── Leitura ────────────────────────────────────────────────────────────────

partCompatibilityRouter.get("/part-compatibility-groups", requireAuth, (_req, res, next) => {
  try {
    res.json({ groups: listCompatibilityGroups(getDb()) });
  } catch (err) {
    next(err);
  }
});

partCompatibilityRouter.get("/part-compatibility-groups/:id", requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = getCompatibilityGroup(getDb(), id);
    if (!g) { res.status(404).json({ error: "Grupo não encontrado." }); return; }
    res.json(g);
  } catch (err) {
    next(err);
  }
});

// ─── Criação de grupo ────────────────────────────────────────────────────────

const createGroupSchema = z.object({
  name: z.string().optional().nullable(),
});

partCompatibilityRouter.post(
  "/part-compatibility-groups",
  requireAuth,
  requirePermissionOrAdmin(PERM),
  (req, res, next) => {
    try {
      const body = createGroupSchema.parse(req.body);
      const group = createCompatibilityGroup(getDb(), {
        name: body.name ?? null,
        userId: (req as Request).sessionUser?.id ?? null,
      });
      res.status(201).json(group);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Dados inválidos.", details: err.errors });
        return;
      }
      next(err);
    }
  },
);

// ─── Adicionar membro ────────────────────────────────────────────────────────

const addMemberSchema = z.object({
  chavePeca: z.string().min(1),
});

partCompatibilityRouter.post(
  "/part-compatibility-groups/:id/members",
  requireAuth,
  requirePermissionOrAdmin(PERM),
  async (req, res, next) => {
    try {
      const groupId = Number(req.params.id);
      const body = addMemberSchema.parse(req.body);
      const db = getDb();
      const member = addGroupMember(db, groupId, {
        chavePeca: body.chavePeca,
        userId: (req as Request).sessionUser?.id ?? null,
      });
      const recompute = await processPendingRecompute(db).catch(() => null);
      res.status(201).json({ member, recompute });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Dados inválidos.", details: err.errors });
        return;
      }
      if (err instanceof PartCompatibilityError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  },
);

// ─── Remover membro ──────────────────────────────────────────────────────────

partCompatibilityRouter.delete(
  "/part-compatibility-groups/:groupId/members/:memberId",
  requireAuth,
  requirePermissionOrAdmin(PERM),
  async (req, res, next) => {
    try {
      const memberId = Number(req.params.memberId);
      if (!Number.isInteger(memberId) || memberId <= 0) {
        res.status(400).json({ error: `ID de membro inválido: "${req.params.memberId}".` });
        return;
      }
      const db = getDb();
      const { wasActive } = removeGroupMember(db, memberId, {
        userId: (req as Request).sessionUser?.id ?? null,
      });
      const recompute = wasActive ? await processPendingRecompute(db).catch(() => null) : null;
      res.json({ ok: true, recompute });
    } catch (err) {
      if (err instanceof PartCompatibilityError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  },
);
