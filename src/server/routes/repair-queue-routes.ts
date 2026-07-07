import { Router, type Request } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import {
  getRepairCaseWithParts,
  type WorkflowStatus,
} from "../../repair/repair-service.js";
import {
  deriveNextAction, QUEUE_FILTER_STATUSES, type QueueFilter,
} from "../../match/next-action-service.js";
import {
  reserveKitFromEngine, reservePartial, releaseReservation, directToTechnician,
  listReservationsByCase,
} from "../../operational/reservation-service.js";
import {
  ensurePurchaseRequestsForCase, PurchaseRequestLinkError,
} from "../../operational/purchase-request-service.js";
import {
  getEngineState, runRepairMatchEngine, getPendingRequestCount,
} from "../../match/engine-orchestrator.js";
import { getCurrentOperationalStock } from "../../operational/stock-service.js";

export const repairQueueRouter = Router();

// ─── Engine state ─────────────────────────────────────────────────────────

repairQueueRouter.get("/engine/state", requireAuth, (_req, res) => {
  const db = getDb();
  const state = getEngineState(db);
  const pending = getPendingRequestCount(db);
  const lastRun = state.lastRunId
    ? db.prepare("SELECT * FROM repair_match_runs WHERE id = ?").get(state.lastRunId)
    : null;
  res.json({ state, pending, lastRun });
});

repairQueueRouter.post("/engine/run", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as Request).sessionUser?.id ?? null;
    const result = await runRepairMatchEngine(db, { triggerReason: "MANUAL_ADMIN", userId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Fila de reparos ──────────────────────────────────────────────────────

repairQueueRouter.get("/fila-reparos", requireAuth, (req, res) => {
  const db = getDb();
  const filter = (req.query.filter as QueueFilter) || "DO_NOW";
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
  const offset = (page - 1) * limit;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const statuses = QUEUE_FILTER_STATUSES[filter] ?? null;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (statuses && statuses.length > 0) {
    conditions.push(`rc.workflow_status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }

  if (q) {
    const like = `%${q}%`;
    conditions.push(
      `(rc.imei LIKE ? OR rc.os LIKE ? OR rc.brand LIKE ? OR rc.model LIKE ?
        OR rc.deposito_atual LIKE ?
        OR EXISTS (
          SELECT 1 FROM part_requests pr
          WHERE pr.repair_case_id = rc.id AND pr.cancelled_at IS NULL
            AND (pr.chave_peca LIKE ? OR pr.description LIKE ?
                 OR pr.allocated_reference LIKE ?
                 OR EXISTS (
                   SELECT 1 FROM purchase_requests pur
                   WHERE pur.part_request_id = pr.id AND pur.referencia LIKE ?
                 ))
        ))`,
    );
    params.push(like, like, like, like, like, like, like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM repair_cases rc ${where}`).get(...params) as { c: number }).c;

  const rows = db.prepare(`
    SELECT rc.*,
           (SELECT COUNT(*) FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL) AS total_parts,
           (SELECT COUNT(*) FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL AND status IN ('INDICADA','RESERVADA','SEPARADA')) AS matched_parts,
           (SELECT COUNT(*) FROM operational_reservations WHERE repair_case_id = rc.id AND status = 'ACTIVE') AS reserved_count,
           (SELECT active FROM repair_case_priorities WHERE repair_case_id = rc.id AND active = 1 LIMIT 1) AS has_priority
    FROM repair_cases rc
    ${where}
    ORDER BY
      CASE WHEN rc.manual_priority_active = 1 THEN 0 ELSE 1 END,
      CASE rc.workflow_status
        WHEN 'MATCH' THEN 1
        WHEN 'APTO_REPARO' THEN 2
        WHEN 'MATCH_PARCIAL' THEN 3
        WHEN 'VERIFICAR' THEN 4
        WHEN 'EM_SEPARACAO' THEN 5
        WHEN 'PEDIR_PECA' THEN 6
        WHEN 'AGUARDANDO_RECEBIMENTO' THEN 7
        WHEN 'EM_ANALISE' THEN 8
        ELSE 9
      END,
      rc.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[];

  const items = rows.map((r) => {
    const workflowStatus = r.workflow_status as WorkflowStatus;
    const nextAction = deriveNextAction(workflowStatus, {
      analysisCompleted: r.analysis_status === "COMPLETED",
      allPartsReserved: (r.reserved_count as number) >= (r.total_parts as number) && (r.total_parts as number) > 0,
      hasActiveReservations: (r.reserved_count as number) > 0,
    });
    return {
      id: r.id,
      imei: r.imei,
      os: r.os,
      brand: r.brand,
      model: r.model,
      capacity: r.capacity,
      color: r.color,
      repairDate: r.repair_date,
      ageDays: r.age_days,
      workflowStatus,
      analysisStatus: r.analysis_status,
      manualPriorityActive: r.manual_priority_active === 1,
      assignedTechnicianId: r.assigned_technician_id,
      directedTechnicianId: r.directed_technician_id,
      totalParts: r.total_parts,
      matchedParts: r.matched_parts,
      reservedCount: r.reserved_count,
      depositoAtual: r.deposito_atual,
      nextAction,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });

  res.json({ items, total, page, limit, filter });
});

// ─── Drawer do caso ───────────────────────────────────────────────────────

repairQueueRouter.get("/fila-reparos/:id", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });

    const rc = getRepairCaseWithParts(db, id);
    if (!rc) return res.status(404).json({ error: "Caso não encontrado." });

    const reservations = listReservationsByCase(db, id);
    const nextAction = deriveNextAction(rc.workflowStatus as WorkflowStatus, {
      analysisCompleted: rc.analysisStatus === "COMPLETED",
      allPartsReserved: reservations.filter(r => r.status === "ACTIVE").length >= rc.parts.filter(p => p.status !== "CANCELADA").length,
      hasActiveReservations: reservations.some(r => r.status === "ACTIVE"),
    });

    // Get match results for this case from last run
    const matchResults = db.prepare(`
      SELECT rmr.*, pr.description, pr.chave_peca, pr.status AS part_status
      FROM repair_match_results rmr
      JOIN part_requests pr ON pr.id = rmr.part_request_id
      WHERE rmr.repair_case_id = ?
        AND rmr.run_id = (SELECT MAX(run_id) FROM repair_match_results WHERE repair_case_id = ?)
    `).all(id, id) as Record<string, unknown>[];

    // Get stock for each chave
    const { groups: stockGroups } = getCurrentOperationalStock(db);
    const stockMap = new Map<string, number>();
    for (const g of stockGroups) {
      if (g.chavePecaNorm) {
        const prev = stockMap.get(g.chavePecaNorm) ?? 0;
        stockMap.set(g.chavePecaNorm, prev + g.availableQuantity);
      }
    }

    // Enrich parts with availability
    const partsEnriched = rc.parts.map(p => {
      const reserved = reservations.find(r => r.partRequestId === p.id && r.status === "ACTIVE");
      const available = p.chavePecaNorm ? (stockMap.get(p.chavePecaNorm) ?? 0) : 0;
      const matchResult = matchResults.find(mr => mr.part_request_id === p.id);
      return {
        ...p,
        availableQty: available,
        reservedQty: reserved?.quantity ?? 0,
        reservationId: reserved?.id ?? null,
        matchResultStatus: matchResult?.result_status ?? null,
        allocatedReference: matchResult?.allocated_reference ?? null,
      };
    });

    // History
    const history = db.prepare(`
      SELECT * FROM operational_events
      WHERE entity_type = 'repair_case' AND entity_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(id) as Record<string, unknown>[];

    const technician = rc.assignedTechnicianId
      ? db.prepare("SELECT * FROM staff_members WHERE id = ?").get(rc.assignedTechnicianId)
      : null;
    const directedTechnician = rc.directedTechnicianId
      ? db.prepare("SELECT * FROM staff_members WHERE id = ?").get(rc.directedTechnicianId)
      : null;

    res.json({
      ...rc,
      parts: partsEnriched,
      reservations,
      nextAction,
      matchResults,
      history,
      technician,
      directedTechnician,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Separação / Reservas ─────────────────────────────────────────────────

// Backend-driven: peças e referências determinadas pelo servidor via resultado do motor.
// Frontend envia apenas o repairCaseId (URL). Body é ignorado.
repairQueueRouter.post("/fila-reparos/:id/reserve-kit", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const userId = (req as Request).sessionUser?.id ?? null;
    const reservations = reserveKitFromEngine(db, repairCaseId, userId);
    res.json({ reservations });
  } catch (err) {
    next(err);
  }
});

repairQueueRouter.post("/fila-reparos/:id/reserve-partial", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    const userId = (req as Request).sessionUser?.id ?? null;
    const { parts } = req.body as { parts: Array<{ partRequestId: number; chavePeca: string; reference: string | null; quantity: number }> };
    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: "Lista de peças obrigatória." });
    }
    const reservations = reservePartial(db, repairCaseId, parts, userId);
    res.json({ reservations });
  } catch (err) {
    next(err);
  }
});

repairQueueRouter.post("/fila-reparos/:id/release-reservation", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as Request).sessionUser?.id ?? null;
    const { partRequestId, reason, reasonCode } = req.body as { partRequestId: number; reason: string; reasonCode?: string };
    if (!partRequestId || !reason) return res.status(400).json({ error: "partRequestId e reason são obrigatórios." });
    releaseReservation(db, partRequestId, { reason, reasonCode, userId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

repairQueueRouter.post("/fila-reparos/:id/direct-technician", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    const userId = (req as Request).sessionUser?.id ?? null;
    const { technicianId, notes } = req.body as { technicianId: number; notes?: string };
    if (!technicianId) return res.status(400).json({ error: "technicianId obrigatório." });
    directToTechnician(db, repairCaseId, { technicianId, userId, notes });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Incluir em compra ────────────────────────────────────────────────────

repairQueueRouter.post("/fila-reparos/:id/add-to-purchase", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const userId = (req as Request).sessionUser?.id ?? null;
    const { results, partIds } = ensurePurchaseRequestsForCase(db, repairCaseId, userId);
    const created = results.filter((r) => r.created).length;
    const existing = results.filter((r) => r.alreadyExisted).length;
    res.json({ partIds, created, existing, total: results.length });
  } catch (err) {
    if (err instanceof PurchaseRequestLinkError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// ─── Match rules (admin) ──────────────────────────────────────────────────
import {
  listRuleSets, getActiveRuleSet, createDraftRuleSet, updateDraftRuleSet, activateRuleSet,
} from "../../match/match-rule-service.js";

repairQueueRouter.get("/match-rules", requireAuth, (_req, res) => {
  const db = getDb();
  res.json({ rules: listRuleSets(db) });
});

repairQueueRouter.get("/match-rules/active", requireAuth, (_req, res, next) => {
  try {
    const db = getDb();
    res.json(getActiveRuleSet(db));
  } catch (err) {
    next(err);
  }
});

repairQueueRouter.post("/match-rules", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as Request).sessionUser?.id ?? null;
    const input = { ...req.body, createdByUserId: userId };
    res.status(201).json(createDraftRuleSet(db, input));
  } catch (err) {
    next(err);
  }
});

repairQueueRouter.patch("/match-rules/:id", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as Request).sessionUser?.id ?? null;
    res.json(updateDraftRuleSet(db, parseInt(req.params.id), req.body, userId));
  } catch (err) {
    next(err);
  }
});

repairQueueRouter.post("/match-rules/:id/activate", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as Request).sessionUser?.id ?? null;
    const { reason } = req.body as { reason: string };
    const updated = activateRuleSet(db, parseInt(req.params.id), { reason, userId });
    // Trigger engine recompute
    const { requestMatchRecompute } = await import("../../match/engine-orchestrator.js");
    requestMatchRecompute(db, `RULE_ACTIVATED_v${updated.version}`, "match_rule_set", updated.id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
