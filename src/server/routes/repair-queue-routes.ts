import { Router, type Request } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin, requireOperator, requirePermissionOrAdmin } from "../middleware/auth-middleware.js";
import { getStaffByUserId } from "../../staff/staff-service.js";
import {
  getRepairCaseWithParts,
  type WorkflowStatus,
} from "../../repair/repair-service.js";
import {
  deriveNextAction, QUEUE_FILTER_STATUSES, type QueueFilter,
} from "../../match/next-action-service.js";
import {
  reserveKitFromEngine, reservePartial, releaseReservation, directToTechnician,
  redirectTechnician,
  startRepair, completeRepair, RepairFlowError,
  listReservationsByCase,
} from "../../operational/reservation-service.js";
import { recordOperationalEvent } from "../../operational/operational-event-service.js";
import {
  ensurePurchaseRequestsForCase, PurchaseRequestLinkError,
} from "../../operational/purchase-request-service.js";
import {
  getEngineState, runRepairMatchEngine, getPendingRequestCount,
  requestMatchRecompute, processPendingRecompute,
} from "../../match/engine-orchestrator.js";
import { getCurrentOperationalStock } from "../../operational/stock-service.js";

export const repairQueueRouter = Router();

// ─── Stats do técnico logado (dashboard home) ────────────────────────────

repairQueueRouter.get("/fila-reparos/minha-fila/stats", requireAuth, (req, res) => {
  const db = getDb();
  const userId = (req as Request).sessionUser!.id;
  const staff = getStaffByUserId(db, userId);
  if (!staff) { res.json({ linked: false, staffName: null, current: 0, completed: 0 }); return; }

  // default: from = início do mês atual, to = hoje (inclusive, até meia-noite amanhã)
  const today = new Date();
  const defaultFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const defaultTo   = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const from = (typeof req.query.from === "string" && req.query.from) ? req.query.from : defaultFrom;
  const to   = (typeof req.query.to   === "string" && req.query.to)   ? req.query.to   : defaultTo;

  const current = (db.prepare(`
    SELECT COUNT(*) AS c FROM repair_cases
    WHERE directed_technician_id = ?
      AND workflow_status IN ('DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO')
  `).get(staff.id) as { c: number }).c;

  const completed = (db.prepare(`
    SELECT COUNT(*) AS c FROM repair_cases
    WHERE directed_technician_id = ?
      AND repair_completed_at >= ? AND repair_completed_at <= ? || 'T23:59:59'
  `).get(staff.id, from, to) as { c: number }).c;

  res.json({ linked: true, staffName: staff.name, current, completed });
});

// ─── Fila do técnico logado ───────────────────────────────────────────────

repairQueueRouter.get("/fila-reparos/minha-fila", requireAuth, (req, res) => {
  const db = getDb();
  const userId = (req as Request).sessionUser!.id;
  const staff = getStaffByUserId(db, userId);
  if (!staff) {
    res.json({ cases: [], staffMember: null });
    return;
  }

  const rows = db.prepare(`
    SELECT rc.*,
           (SELECT COUNT(*) FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL) AS total_parts,
           (SELECT COUNT(*) FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL AND status IN ('INDICADA','RESERVADA','SEPARADA','CONSUMIDA')) AS matched_parts
    FROM repair_cases rc
    WHERE rc.directed_technician_id = ?
      AND rc.workflow_status IN ('DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO')
    ORDER BY
      CASE rc.workflow_status
        WHEN 'EM_REPARO' THEN 1
        WHEN 'DIRECIONADO_TECNICO' THEN 2
        WHEN 'REPARO_EXECUTADO' THEN 3
        WHEN 'TRIAGEM_FINAL' THEN 4
        WHEN 'RETORNO_TECNICO' THEN 5
        ELSE 9
      END,
      rc.updated_at DESC
  `).all(staff.id);

  res.json({ cases: rows, staffMember: staff });
});

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


repairQueueRouter.get("/fila-reparos", requireAuth, requireOperator, (req, res) => {
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
      rc.margin ASC NULLS FIRST,
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
      problema: r.problema ?? null,
      nextAction,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      margin: r.margin ?? null,
      creationSource: r.creation_source ?? "IMPORT",
    };
  });

  res.json({ items, total, page, limit, filter });
});

// ─── Exportação completa do filtro (sem paginação) ───────────────────────

repairQueueRouter.get("/fila-reparos/export", requireAuth, requireOperator, (req, res) => {
  const db = getDb();
  const filter = (req.query.filter as QueueFilter) || "TODOS";
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

  // Busca todos os casos sem paginação, incluindo dados de score e peças
  const rows = db.prepare(`
    SELECT
      rc.id,
      rc.imei,
      rc.os,
      rc.brand,
      rc.model,
      rc.color,
      rc.capacity,
      rc.deposito_atual,
      rc.workflow_status,
      rc.age_days,
      rc.cost,
      rc.estimated_sale,
      rc.margin,
      rc.manual_priority_active,
      (SELECT COUNT(*) FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL) AS total_parts,
      (SELECT GROUP_CONCAT(chave_peca, ' | ') FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL) AS pecas,
      (SELECT GROUP_CONCAT(allocated_reference, ' | ') FROM part_requests WHERE repair_case_id = rc.id AND cancelled_at IS NULL AND allocated_reference IS NOT NULL) AS referencias,
      rmcr.score,
      rmcr.result_status AS match_result,
      mrs.name AS regra_ativa
    FROM repair_cases rc
    LEFT JOIN repair_match_case_results rmcr ON rmcr.repair_case_id = rc.id
      AND rmcr.run_id = (SELECT MAX(run_id) FROM repair_match_case_results WHERE repair_case_id = rc.id)
    LEFT JOIN match_rule_sets mrs ON mrs.id = rmcr.rule_set_id
    ${where}
    ORDER BY
      CASE WHEN rc.manual_priority_active = 1 THEN 0 ELSE 1 END,
      CASE rc.workflow_status
        WHEN 'MATCH' THEN 1 WHEN 'APTO_REPARO' THEN 2 WHEN 'MATCH_PARCIAL' THEN 3
        WHEN 'VERIFICAR' THEN 4 WHEN 'EM_SEPARACAO' THEN 5 WHEN 'PEDIR_PECA' THEN 6
        WHEN 'AGUARDANDO_RECEBIMENTO' THEN 7 WHEN 'EM_ANALISE' THEN 8 ELSE 9
      END,
      rc.id ASC
  `).all(...params) as Record<string, unknown>[];

  // Gera CSV
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = [
    "IMEI", "OS", "Marca", "Modelo", "Cor", "Capacidade",
    "Depósito", "Status", "Score", "Margem (R$)", "Idade (dias)",
    "Qtd peças", "Peças necessárias", "Referências alocadas", "Regra ativa",
  ].join(",");

  const lines = rows.map(r => [
    esc(r.imei),
    esc(r.os),
    esc(r.brand),
    esc(r.model),
    esc(r.color),
    esc(r.capacity),
    esc(r.deposito_atual),
    esc(r.workflow_status),
    esc(r.score != null ? Number(r.score).toFixed(4) : ""),
    esc(r.margin),
    esc(r.age_days),
    esc(r.total_parts),
    esc(r.pecas),
    esc(r.referencias),
    esc(r.regra_ativa),
  ].join(","));

  const csv = [header, ...lines].join("\r\n");
  const date = new Date().toISOString().slice(0, 10);
  const fname = `fila-reparos-${filter.toLowerCase()}-${date}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.send("﻿" + csv); // BOM para Excel reconhecer UTF-8
});

// ─── Summary (KPIs reais) ─────────────────────────────────────────────────

repairQueueRouter.get("/fila-reparos/summary", requireAuth, (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT workflow_status, COUNT(*) AS cnt FROM repair_cases GROUP BY workflow_status`,
  ).all() as { workflow_status: string; cnt: number }[];
  const summary: Record<string, number> = {};
  for (const r of rows) summary[r.workflow_status] = r.cnt;
  const total = (db.prepare("SELECT COUNT(*) AS c FROM repair_cases").get() as { c: number }).c;
  const priorityCount = (
    db.prepare("SELECT COUNT(*) AS c FROM repair_cases WHERE manual_priority_active = 1").get() as { c: number }
  ).c;

  const FILTER_STATUSES: Record<string, string[] | null> = {
    DO_NOW:           ["MATCH", "APTO_REPARO", "MATCH_PARCIAL", "VERIFICAR"],
    MATCH:            ["MATCH"],
    MATCH_PARCIAL:    ["MATCH_PARCIAL"],
    AGUARDANDO_PECAS: ["PEDIR_PECA", "AGUARDANDO_RECEBIMENTO"],
    COM_TECNICO:      ["APTO_REPARO", "DIRECIONADO_TECNICO", "EM_REPARO", "REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO"],
    EM_ANALISE:       ["EM_ANALISE", "EM_SEPARACAO"],
    VERIFICAR:        ["VERIFICAR"],
    VENDA_ESTADO:     ["VENDA_ESTADO"],
    FINALIZADOS:      ["CONCLUIDO", "CANCELADO"],
    TODOS:            null,
  };
  const filterCounts: Record<string, number> = {};
  for (const [f, statuses] of Object.entries(FILTER_STATUSES)) {
    filterCounts[f] = statuses === null
      ? total
      : statuses.reduce((acc, s) => acc + (summary[s] ?? 0), 0);
  }

  res.json({ summary, total, priorityCount, filterCounts });
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

    // Resultado canônico por caso (explicabilidade: motivos, score decimal, regra)
    const caseResultRow = db.prepare(`
      SELECT rmcr.*, mrs.name AS rule_name
      FROM repair_match_case_results rmcr
      LEFT JOIN match_rule_sets mrs ON mrs.id = rmcr.rule_set_id
      WHERE rmcr.repair_case_id = ?
      ORDER BY rmcr.run_id DESC LIMIT 1
    `).get(id) as Record<string, unknown> | undefined;
    const matchCaseResult = caseResultRow
      ? {
          runId: caseResultRow.run_id,
          eligible: caseResultRow.eligible === 1,
          resultStatus: caseResultRow.result_status,
          verifyReasons: caseResultRow.verify_reasons_json
            ? (JSON.parse(caseResultRow.verify_reasons_json as string) as string[])
            : [],
          margin: caseResultRow.margin,
          marginPoints: caseResultRow.margin_points,
          agePoints: caseResultRow.age_points,
          score: caseResultRow.score,
          priorityRank: caseResultRow.priority_rank,
          ruleSetId: caseResultRow.rule_set_id,
          ruleSetVersion: caseResultRow.rule_set_version,
          ruleName: caseResultRow.rule_name ?? null,
          depositoAtual: caseResultRow.deposito_atual,
          computedAt: caseResultRow.created_at,
        }
      : null;

    // Get stock for each chave
    const { groups: stockGroups } = getCurrentOperationalStock(db);
    const stockMap = new Map<string, number>();
    for (const g of stockGroups) {
      if (g.chavePecaNorm) {
        const prev = stockMap.get(g.chavePecaNorm) ?? 0;
        stockMap.set(g.chavePecaNorm, prev + g.availableQuantity);
      }
    }

    // Enriquecer cada part_request com informações de compra ativa
    const purchaseInfoRows = db.prepare(`
      SELECT
        purch.part_request_id,
        purch.id          AS purchase_request_id,
        purch.status      AS purchase_request_status,
        po.id             AS purchase_order_id,
        po.status         AS purchase_order_status
      FROM purchase_requests purch
      LEFT JOIN purchase_order_items poi ON poi.purchase_request_id = purch.id
      LEFT JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE purch.part_request_id IN (${rc.parts.map(() => "?").join(",")})
        AND purch.status IN ('APPROVED','ORDERED')
      ORDER BY purch.id DESC
    `).all(...rc.parts.map(p => p.id)) as Array<{
      part_request_id: number;
      purchase_request_id: number;
      purchase_request_status: string;
      purchase_order_id: number | null;
      purchase_order_status: string | null;
    }>;

    const purchaseByPart = new Map<number, typeof purchaseInfoRows[number]>();
    for (const row of purchaseInfoRows) {
      if (!purchaseByPart.has(row.part_request_id)) {
        purchaseByPart.set(row.part_request_id, row);
      }
    }

    // Enrich parts with availability
    const partsEnriched = rc.parts.map(p => {
      const reserved = reservations.find(r => r.partRequestId === p.id && r.status === "ACTIVE");
      const matchResult = matchResults.find(mr => mr.part_request_id === p.id);
      // Alias resolution: when matched via ALIAS, stock lives under a different chave_peca_norm.
      const lookupNorm = (matchResult?.alias_stock_chave_norm as string | null) ?? p.chavePecaNorm;
      const available = lookupNorm ? (stockMap.get(lookupNorm) ?? 0) : 0;
      const purchInfo = purchaseByPart.get(p.id);
      return {
        ...p,
        availableQty: available,
        reservedQty: reserved?.quantity ?? 0,
        reservationId: reserved?.id ?? null,
        matchResultStatus: matchResult?.result_status ?? null,
        allocatedReference: matchResult?.allocated_reference ?? null,
        activePurchaseRequestId: purchInfo?.purchase_request_id ?? null,
        purchaseRequestStatus: purchInfo?.purchase_request_status ?? null,
        activePurchaseOrderId: purchInfo?.purchase_order_id ?? null,
        purchaseOrderStatus: purchInfo?.purchase_order_status ?? null,
      };
    });

    // Resumo de compra para o drawer
    const purchasableParts = partsEnriched.filter(
      p => p.status === "PEDIR_PECA" && p.activePurchaseRequestId == null,
    );
    const alreadyInPurchase = partsEnriched.filter(
      p => p.status === "PEDIR_PECA" && p.activePurchaseRequestId != null,
    );

    // History — entity_id stored as TEXT via String(repairCaseId)
    const history = db.prepare(`
      SELECT * FROM operational_events
      WHERE entity_type = 'repair_case' AND entity_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(String(id)) as Record<string, unknown>[];

    const technician = rc.assignedTechnicianId
      ? db.prepare("SELECT * FROM staff_members WHERE id = ?").get(rc.assignedTechnicianId)
      : null;
    const directedTechnician = rc.directedTechnicianId
      ? db.prepare("SELECT * FROM staff_members WHERE id = ?").get(rc.directedTechnicianId)
      : null;

    const rcRow = db.prepare("SELECT deposito_atual, problema FROM repair_cases WHERE id = ?").get(id) as { deposito_atual: string | null; problema: string | null } | undefined;
    res.json({
      ...rc,
      depositoAtual: rcRow?.deposito_atual ?? null,
      problema: rcRow?.problema ?? null,
      parts: partsEnriched,
      reservations,
      nextAction,
      matchResults,
      matchCaseResult,
      history,
      technician,
      directedTechnician,
      purchasablePartsCount: purchasableParts.length,
      partsAlreadyInPurchaseCount: alreadyInPurchase.length,
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

// Redirecionar técnico — aceita APTO_REPARO e DIRECIONADO_TECNICO (alterar técnico após direcionamento)
repairQueueRouter.post("/fila-reparos/:id/redirect-technician", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    const userId = (req as Request).sessionUser?.id ?? null;
    const { technicianId, notes } = req.body as { technicianId: number; notes?: string };
    if (!technicianId) return res.status(400).json({ error: "technicianId obrigatório." });
    redirectTechnician(db, repairCaseId, { technicianId, userId, notes });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Direcionamento em lote — APTO_REPARO → DIRECIONADO_TECNICO para múltiplos casos
repairQueueRouter.post("/fila-reparos/direct-technician-batch", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as Request).sessionUser?.id ?? null;
    const { caseIds, technicianId, notes } = req.body as { caseIds: number[]; technicianId: number; notes?: string };
    if (!technicianId) return res.status(400).json({ error: "technicianId obrigatório." });
    if (!Array.isArray(caseIds) || caseIds.length === 0) return res.status(400).json({ error: "caseIds obrigatório." });

    const results: Array<{ id: number; ok: boolean; error?: string }> = [];
    for (const id of caseIds) {
      try {
        redirectTechnician(db, id, { technicianId, userId, notes });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    const succeeded = results.filter(r => r.ok).length;
    res.json({ ok: true, succeeded, failed: results.length - succeeded, results });
  } catch (err) {
    next(err);
  }
});

// ─── Fechar caso (VERIFICAR → CONCLUIDO / CANCELADO / VENDA_ESTADO) ───────

repairQueueRouter.post("/fila-reparos/:id/close", requireAuth, requireOperator, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const { status, notes } = req.body as { status?: string; notes?: string };
    const VALID_CLOSE = ["CONCLUIDO", "CANCELADO", "VENDA_ESTADO"];
    if (!status || !VALID_CLOSE.includes(status)) {
      return res.status(400).json({ error: `Status deve ser um de: ${VALID_CLOSE.join(", ")}.` });
    }
    const rc = db.prepare("SELECT id FROM repair_cases WHERE id = ?").get(repairCaseId);
    if (!rc) return res.status(404).json({ error: "Caso não encontrado." });
    db.prepare(
      `UPDATE repair_cases SET workflow_status = ?, closed_at = datetime('now'),
         updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(status, (req as Request).sessionUser?.id ?? null, repairCaseId);
    if (notes?.trim()) {
      recordOperationalEvent(db, {
        repairCaseId,
        eventType: "NOTE_ADDED",
        responsibleName: (req as Request).sessionUser?.displayName ?? null,
        notes: notes.trim(),
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Candidatos a VENDA_ESTADO (piores pontuadores do último run) ─────────

repairQueueRouter.get("/fila-reparos/venda-estado-candidatos", requireAuth, requireOperator, (req, res, next) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt((req.query.limit as string) ?? "10", 10) || 10, 50);

    const lastRun = db.prepare(
      "SELECT id FROM repair_match_runs WHERE status='COMPLETED' ORDER BY id DESC LIMIT 1",
    ).get() as { id: number } | undefined;

    if (!lastRun) return res.json({ candidatos: [], runId: null });

    const rows = db.prepare(`
      SELECT
        rc.id, rc.brand, rc.model, rc.capacity, rc.color, rc.imei,
        rc.workflow_status, rc.cost, rc.estimated_sale, rc.margin,
        rc.age_days, rc.deposito_atual, rc.os,
        rmcr.score, rmcr.margin_points, rmcr.age_points
      FROM repair_match_case_results rmcr
      JOIN repair_cases rc ON rc.id = rmcr.repair_case_id
      WHERE rmcr.run_id = ?
        AND rmcr.eligible = 1
        AND rc.workflow_status NOT IN ('CONCLUIDO','CANCELADO','VENDA_ESTADO')
      ORDER BY rmcr.score ASC NULLS LAST
      LIMIT ?
    `).all(lastRun.id, limit) as Record<string, unknown>[];

    res.json({ candidatos: rows, runId: lastRun.id });
  } catch (err) { next(err); }
});

// ─── Override manual de fase ──────────────────────────────────────────────

repairQueueRouter.post("/fila-reparos/:id/override-status", requireAuth, requirePermissionOrAdmin("OVERRIDE_REPAIR_STATUS"), (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const { toStatus, notes } = req.body as { toStatus?: string; notes?: string };
    const VALID_STATUSES = [
      "EM_ANALISE", "PEDIR_PECA", "AGUARDANDO_RECEBIMENTO",
      "MATCH_PARCIAL", "MATCH", "EM_SEPARACAO", "APTO_REPARO",
      "DIRECIONADO_TECNICO", "EM_REPARO", "REPARO_EXECUTADO",
      "TRIAGEM_FINAL", "RETORNO_TECNICO",
      "CONCLUIDO", "VENDA_ESTADO", "CANCELADO", "VERIFICAR",
    ];
    if (!toStatus || !VALID_STATUSES.includes(toStatus)) {
      return res.status(400).json({ error: "Status inválido." });
    }
    if (!notes?.trim()) {
      return res.status(400).json({ error: "Justificativa obrigatória." });
    }
    const rc = db.prepare("SELECT id, workflow_status FROM repair_cases WHERE id = ?").get(repairCaseId) as { id: number; workflow_status: string } | undefined;
    if (!rc) return res.status(404).json({ error: "Caso não encontrado." });
    const fromStatus = rc.workflow_status;
    const userId = (req as Request).sessionUser!.id;
    const userName = (req as Request).sessionUser!.displayName;

    db.prepare(
      `UPDATE repair_cases SET workflow_status = ?, updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(toStatus, userId, repairCaseId);

    recordOperationalEvent(db, {
      repairCaseId,
      eventType: "STATUS_OVERRIDE",
      previousStatus: fromStatus,
      newStatus: toStatus,
      responsibleName: userName,
      notes: notes.trim(),
    });

    db.prepare(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'OVERRIDE_REPAIR_STATUS', 'repair_case', ?, ?)`,
    ).run(userId, String(repairCaseId), JSON.stringify({ fromStatus, toStatus, notes: notes.trim() }));

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Editar campos do caso ────────────────────────────────────────────────

repairQueueRouter.patch("/fila-reparos/:id/info", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const allowed = ["problema", "notes", "brand", "model", "color", "capacity"] as const;
    const body = req.body as Partial<Record<typeof allowed[number], string | null>>;
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const col of allowed) {
      if (col in body) { sets.push(`${col} = ?`); vals.push((body[col] ?? null) as string | number | null); }
    }
    if (sets.length === 0) return res.json({ ok: true });
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE repair_cases SET ${sets.join(", ")} WHERE id = ?`).run(...vals, repairCaseId);

    // Correção de dado indispensável (ex.: modelo) devolve o card ao motor
    if ("model" in body || "brand" in body) {
      requestMatchRecompute(db, `INFO_EDIT_${repairCaseId}`, "repair_case", repairCaseId);
      await processPendingRecompute(db).catch(() => null);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Corrigir dados de score (custo/venda/idade) — tela VERIFICAR ─────────

repairQueueRouter.patch("/fila-reparos/:id/score", requireAuth, requireOperator, async (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });

    const body = req.body as { ageDays?: number | null; cost?: number | null; estimatedSale?: number | null; margin?: number | null };
    const rc = db.prepare(
      "SELECT age_days, cost, estimated_sale, margin FROM repair_cases WHERE id = ?",
    ).get(repairCaseId) as { age_days: number | null; cost: number | null; estimated_sale: number | null; margin: number | null } | undefined;
    if (!rc) return res.status(404).json({ error: "Caso não encontrado." });

    const num = (v: unknown): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const ageDays = "ageDays" in body ? num(body.ageDays) : rc.age_days;
    const cost = "cost" in body ? num(body.cost) : rc.cost;
    const estimatedSale = "estimatedSale" in body ? num(body.estimatedSale) : rc.estimated_sale;
    // margem é derivada (venda − custo); só aceita valor direto se algum dos dois faltar
    const margin = cost !== null && estimatedSale !== null
      ? estimatedSale - cost
      : ("margin" in body ? num(body.margin) : rc.margin);

    const userId = (req as Request).sessionUser?.id ?? null;
    const userName = (req as Request).sessionUser?.displayName ?? null;

    db.prepare(
      "UPDATE repair_cases SET age_days = ?, cost = ?, estimated_sale = ?, margin = ?, updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(ageDays, cost, estimatedSale, margin, userId, repairCaseId);

    recordOperationalEvent(db, {
      repairCaseId,
      eventType: "DADOS_SCORE_EDITADOS",
      responsibleName: userName,
      notes: `Idade/custo/venda corrigidos: idade ${rc.age_days ?? "—"}→${ageDays ?? "—"}, custo ${rc.cost ?? "—"}→${cost ?? "—"}, venda ${rc.estimated_sale ?? "—"}→${estimatedSale ?? "—"}`,
    });
    db.prepare(
      "INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'EDIT_SCORE_DATA', 'repair_case', ?, ?)",
    ).run(userId, String(repairCaseId), JSON.stringify({ before: rc, after: { ageDays, cost, estimatedSale, margin } }));

    // O card retorna imediatamente ao motor
    requestMatchRecompute(db, `SCORE_DATA_EDIT_${repairCaseId}`, "repair_case", repairCaseId);
    const recompute = await processPendingRecompute(db).catch(() => null);

    const updated = db.prepare(
      "SELECT id, workflow_status, age_days, cost, estimated_sale, margin FROM repair_cases WHERE id = ?",
    ).get(repairCaseId);
    res.json({ ok: true, case: updated, recompute });
  } catch (err) { next(err); }
});

// ─── Mover para depósito ──────────────────────────────────────────────────

repairQueueRouter.patch("/fila-reparos/:id/deposito", requireAuth, requireOperator, async (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const { deposito } = req.body as { deposito?: string | null };

    const rc = db.prepare("SELECT deposito_atual FROM repair_cases WHERE id = ?").get(repairCaseId) as
      | { deposito_atual: string | null }
      | undefined;
    if (!rc) return res.status(404).json({ error: "Caso não encontrado." });
    const previous = rc.deposito_atual;
    const newValue = deposito?.trim() || null;
    const userId = (req as Request).sessionUser?.id ?? null;
    const userName = (req as Request).sessionUser?.displayName ?? null;

    db.prepare(
      "UPDATE repair_cases SET deposito_atual = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newValue, repairCaseId);

    // Auditoria: usuário, data e valor anterior
    recordOperationalEvent(db, {
      repairCaseId,
      eventType: "DEPOSITO_ALTERADO",
      previousStatus: previous,
      newStatus: newValue,
      responsibleName: userName,
      notes: `Depósito alterado manualmente: ${previous ?? "(vazio)"} → ${newValue ?? "(vazio)"}`,
    });
    db.prepare(
      "INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'DEPOSITO_MANUAL', 'repair_case', ?, ?)",
    ).run(userId, String(repairCaseId), JSON.stringify({ previous, newValue }));

    // O card retorna imediatamente ao motor
    requestMatchRecompute(db, `DEPOSITO_MANUAL_${repairCaseId}`, "repair_case", repairCaseId);
    const recompute = await processPendingRecompute(db).catch(() => null);

    const updated = db.prepare("SELECT workflow_status, deposito_atual FROM repair_cases WHERE id = ?").get(repairCaseId);
    res.json({ ok: true, case: updated, recompute });
  } catch (err) { next(err); }
});

// ─── Lista de depósitos conhecidos (do Com Saldo) ────────────────────────

repairQueueRouter.get("/depositos", requireAuth, (_req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT deposito_atual, COUNT(*) as c FROM rel_seriais_saldo_current
       WHERE deposito_atual IS NOT NULL AND deposito_atual != ''
       GROUP BY deposito_atual ORDER BY c DESC`,
    ).all() as { deposito_atual: string; c: number }[];
    res.json(rows.map(r => r.deposito_atual));
  } catch (err) { next(err); }
});

// ─── Observação ───────────────────────────────────────────────────────────

repairQueueRouter.post("/fila-reparos/:id/notes", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });

    const { note } = req.body as { note?: string };
    if (!note || note.trim().length < 2) {
      return res.status(400).json({ error: "Observação deve ter pelo menos 2 caracteres." });
    }

    const rc = db.prepare("SELECT id FROM repair_cases WHERE id = ?").get(repairCaseId);
    if (!rc) return res.status(404).json({ error: "Caso não encontrado." });

    const responsibleName = (req as Request).sessionUser?.displayName ?? null;

    recordOperationalEvent(db, {
      repairCaseId,
      eventType: "NOTE_ADDED",
      responsibleName,
      notes: note.trim(),
    });

    const history = db.prepare(`
      SELECT * FROM operational_events
      WHERE entity_type = 'repair_case' AND entity_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(String(repairCaseId));

    res.json({ ok: true, history });
  } catch (err) {
    next(err);
  }
});

// ─── Iniciar reparo ───────────────────────────────────────────────────────

repairQueueRouter.post("/fila-reparos/:id/start-repair", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const userId = (req as Request).sessionUser?.id ?? null;
    const responsibleName = (req as Request).sessionUser?.displayName ?? null;
    startRepair(db, repairCaseId, { userId, responsibleName });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof RepairFlowError) {
      const code = err.code === "NOT_FOUND" ? 404 : 422;
      return res.status(code).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ─── Concluir reparo ──────────────────────────────────────────────────────

repairQueueRouter.post("/fila-reparos/:id/complete-repair", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const repairCaseId = parseInt(req.params.id);
    if (!repairCaseId) return res.status(400).json({ error: "ID inválido." });
    const userId = (req as Request).sessionUser?.id ?? null;
    const responsibleName = (req as Request).sessionUser?.displayName ?? null;
    const { notes } = req.body as { notes?: string };
    completeRepair(db, repairCaseId, { userId, responsibleName, notes: notes ?? null });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof RepairFlowError) {
      const code = err.code === "NOT_FOUND" ? 404 : 422;
      return res.status(code).json({ error: err.message, code: err.code });
    }
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
    requestMatchRecompute(db, `RULE_ACTIVATED_v${updated.version}`, "match_rule_set", updated.id);
    const result = await processPendingRecompute(db);
    res.json({
      ...updated,
      casesEvaluated: result?.casesEvaluated ?? 0,
      casesChanged: result?.casesChanged ?? 0,
      fullKitsFound: result?.fullKitsFound ?? 0,
      partialKitsFound: result?.partialKitsFound ?? 0,
      runId: result?.runId ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// Diagnóstico de cobertura dos campos de prioridade
repairQueueRouter.get("/match-rules/priority-coverage", requireAuth, async (_req, res, next) => {
  try {
    const { getPriorityCoverage } = await import("../../match/priority-backfill-service.js");
    res.json(getPriorityCoverage(getDb()));
  } catch (err) { next(err); }
});

// Backfill dos campos de prioridade (admin only)
repairQueueRouter.post("/match-rules/backfill-priority", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const db = getDb();
    const { backfillRepairCasePriorityFields } = await import("../../match/priority-backfill-service.js");
    const backfillResult = backfillRepairCasePriorityFields(db);
    requestMatchRecompute(db, "PRIORITY_BACKFILL", "system", 0);
    const recomputeResult = await processPendingRecompute(db);
    res.json({ backfillResult, recomputeResult });
  } catch (err) { next(err); }
});

// Simulação dry-run — não altera banco
repairQueueRouter.post("/match-rules/simulate", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const { ruleSetId, compareWithActive } = req.body as {
      ruleSetId?: number;
      compareWithActive?: boolean;
    };
    const { simulateMatchRules } = await import("../../match/simulate-service.js");
    const result = await simulateMatchRules(db, { ruleSetId, compareWithActive });
    res.json(result);
  } catch (err) { next(err); }
});
