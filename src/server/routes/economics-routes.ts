/**
 * Rotas de avaliação econômica (Venda no Estado) e custos de peças.
 *
 * A classificação econômica é separada do workflow — somente aprovação
 * humana move um caso para VENDA_ESTADO (economic-evaluation-service).
 */

import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { requireAuth, requireOperator } from "../middleware/auth-middleware.js";
import {
  evaluateEconomics,
  approveAsIs,
  rejectAsIs,
  getEconomicEvaluation,
  loadAsIsPolicy,
  EconomicEvaluationError,
} from "../../match/economic-evaluation-service.js";
import { listPriceEvents, getPriceSummary } from "../../operational/part-price-service.js";
import { normalizeKey } from "../../domain/text.js";

export const economicsRouter = Router();

const decisionSchema = z.object({ reason: z.string().min(5) });

// Reavalia todos os casos abertos e retorna o resumo.
economicsRouter.post("/repair-economics/simulate", requireAuth, requireOperator, (req, res, next) => {
  try {
    const report = evaluateEconomics(getDb());
    res.json({ report, policy: loadAsIsPolicy(getDb()) });
  } catch (err) {
    if (err instanceof EconomicEvaluationError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

// Candidatos ativos e classificações atuais.
economicsRouter.get("/repair-economics/candidates", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT e.*, c.imei, c.model, c.estimated_sale, c.cost, c.age_days, c.workflow_status
      FROM case_economic_evaluations e
      JOIN repair_cases c ON c.id = e.repair_case_id
      WHERE e.classification IN ('ACTIVE_AS_IS_CANDIDATE', 'AS_IS_APPROVED', 'AS_IS_REJECTED')
      ORDER BY e.repair_cost_ratio DESC
    `).all();
    res.json({ candidates: rows, policy: loadAsIsPolicy(db) });
  } catch (err) {
    next(err);
  }
});

economicsRouter.get("/repair-cases/:id/economic-evaluation", requireAuth, (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    if (!Number.isInteger(caseId)) {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const evaluation = getEconomicEvaluation(getDb(), caseId);
    res.json({ evaluation });
  } catch (err) {
    next(err);
  }
});

economicsRouter.post("/repair-cases/:id/as-is/approve", requireAuth, requireOperator, (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const body = decisionSchema.parse(req.body);
    approveAsIs(getDb(), caseId, {
      userId: req.sessionUser?.username ?? null,
      reason: body.reason,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof EconomicEvaluationError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Justificativa obrigatória (mín. 5 caracteres)." });
      return;
    }
    next(err);
  }
});

economicsRouter.post("/repair-cases/:id/as-is/reject", requireAuth, requireOperator, (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const body = decisionSchema.parse(req.body);
    rejectAsIs(getDb(), caseId, {
      userId: req.sessionUser?.username ?? null,
      reason: body.reason,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof EconomicEvaluationError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Justificativa obrigatória (mín. 5 caracteres)." });
      return;
    }
    next(err);
  }
});

// ── Histórico de preços ────────────────────────────────────────────────────

economicsRouter.get("/part-costs/chavepeca/:key/summary", requireAuth, (req, res, next) => {
  try {
    const norm = normalizeKey(req.params.key);
    res.json({ summary: getPriceSummary(getDb(), norm) });
  } catch (err) {
    next(err);
  }
});

economicsRouter.get("/part-costs/chavepeca/:key/history", requireAuth, (req, res, next) => {
  try {
    const norm = normalizeKey(req.params.key);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const events = listPriceEvents(getDb(), { chavePecaNorm: norm, limit, offset });
    res.json({ events, limit, offset });
  } catch (err) {
    next(err);
  }
});
