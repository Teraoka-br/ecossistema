import { Router } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import { getDashboardOverview } from "../../dashboard/dashboard-overview-service.js";
import { getOperationalAlerts } from "../../dashboard/dashboard-alert-service.js";
import { getCountingBlockData } from "../../dashboard/dashboard-counting-service.js";
import { getIssueSummary } from "../../issue/issue-service.js";
import { getFinancialData, getFinancialByBucket } from "../../dashboard/dashboard-financial-service.js";
import {
  createOrUpdateDashboardSnapshot,
  todaySaoPaulo,
  type DashboardSnapshot,
} from "../../dashboard/dashboard-snapshot-service.js";

export const dashboardsRouter = Router();

// ── GET /api/dashboards/home ──────────────────────────────────────────────────
dashboardsRouter.get("/dashboards/home", requireAuth, requireAdmin, (_req, res, next) => {
  try {
    const t0 = Date.now();
    const db = getDb();

    const overview   = getDashboardOverview(db);
    const alerts     = getOperationalAlerts(db);
    const counting   = getCountingBlockData(db);
    const issues     = getIssueSummary(db);
    const financial         = getFinancialData(db);
    const financialByBucket = getFinancialByBucket(db);

    // Atualiza snapshot do dia ao acessar a home
    let todaySnapshot: DashboardSnapshot | null = null;
    try {
      todaySnapshot = createOrUpdateDashboardSnapshot(db, todaySaoPaulo());
    } catch {
      // não bloqueia a resposta se o snapshot falhar
    }

    res.json({
      current: overview.cards,
      comparison: overview.cardComparison,
      stock: overview.stock,
      panorama: overview.panorama,
      technicians: overview.technicians,
      counting,
      alerts,
      recentIssues: issues,
      financial,
      financialByBucket,
      todaySnapshot,
      lastUpdatedAt: overview.lastUpdatedAt,
      _queryMs: Date.now() - t0,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/dashboards/timeline ──────────────────────────────────────────────
// Parâmetros: metric (campo do snapshot), from (YYYY-MM-DD), to (YYYY-MM-DD)
dashboardsRouter.get("/dashboards/timeline", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const metric = req.query.metric as string | undefined ?? "match_count";
    const from   = req.query.from   as string | undefined;
    const to     = req.query.to     as string | undefined;

    const ALLOWED_METRICS = [
      "total_cases","total_unique_imeis",
      "match_count","match_partial_count","apto_reparo_count",
      "verificar_count","em_analise_count","aguardando_peca_count",
      "com_tecnico_count","venda_estado_count","finalizados_count",
      "stock_total_units","stock_available_units","stock_reserved_units",
    ];
    if (!ALLOWED_METRICS.includes(metric)) {
      res.status(400).json({ error: `Métrica inválida: ${metric}` });
      return;
    }

    type Row = { snapshot_date: string; value: number };
    const rows = db
      .prepare(
        `SELECT snapshot_date, ${metric} as value
         FROM dashboard_daily_snapshots
         WHERE (?1 IS NULL OR snapshot_date >= ?1)
           AND (?2 IS NULL OR snapshot_date <= ?2)
         ORDER BY snapshot_date ASC`,
      )
      .all(from ?? null, to ?? null) as Row[];

    res.json({ metric, data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/dashboards/timeline/multi ───────────────────────────────────────
// Retorna todos os status como séries para o gráfico multi-linha
dashboardsRouter.get("/dashboards/timeline/multi", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const from = req.query.from as string | undefined;
    const to   = req.query.to   as string | undefined;

    type Row = {
      snapshot_date: string;
      match_count: number; match_partial_count: number; apto_reparo_count: number;
      verificar_count: number; em_analise_count: number; aguardando_peca_count: number;
      com_tecnico_count: number; venda_estado_count: number; finalizados_count: number;
      total_cases: number;
    };
    const rows = db.prepare(`
      SELECT snapshot_date,
        match_count, match_partial_count, apto_reparo_count,
        verificar_count, em_analise_count, aguardando_peca_count,
        com_tecnico_count, venda_estado_count, finalizados_count,
        total_cases
      FROM dashboard_daily_snapshots
      WHERE (?1 IS NULL OR snapshot_date >= ?1)
        AND (?2 IS NULL OR snapshot_date <= ?2)
      ORDER BY snapshot_date ASC
    `).all(from ?? null, to ?? null) as Row[];

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/dashboards/counting/justify ────────────────────────────────────
dashboardsRouter.post("/dashboards/counting/justify", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const db = getDb();
    const { date, justification } = req.body as { date?: string; justification?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "Data inválida" }); return; }
    const createdBy = req.sessionUser?.displayName ?? null;
    if (!justification || !justification.trim()) {
      db.prepare(`DELETE FROM counting_day_justifications WHERE date = ?`).run(date);
    } else {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO counting_day_justifications (date, justification, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET justification=excluded.justification, created_by=excluded.created_by, updated_at=excluded.updated_at
      `).run(date, justification.trim(), createdBy, now, now);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/dashboards/technician/:id/cases ─────────────────────────────────
dashboardsRouter.get("/dashboards/technician/:id/cases", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const techId = parseInt(req.params.id);
    if (isNaN(techId)) { res.status(400).json({ error: "ID inválido" }); return; }

    type Row = {
      id: number; imei: string; brand: string|null; model: string|null;
      os_number: string|null; workflow_status: string; repair_date: string|null;
      cost: number|null; estimated_sale: number|null; margin: number|null;
    };
    const cases = db.prepare(`
      SELECT id, imei, brand, model, os_number, workflow_status,
             repair_date, cost, estimated_sale, margin
      FROM repair_cases
      WHERE directed_technician_id = ?
        AND workflow_status NOT IN ('CONCLUIDO','CANCELADO','VENDA_ESTADO')
      ORDER BY repair_date ASC
    `).all(techId) as Row[];

    res.json({ cases });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/dashboards/snapshots/recalculate ────────────────────────────────
dashboardsRouter.post(
  "/dashboards/snapshots/recalculate",
  requireAuth,
  requireAdmin,
  (_req, res, next) => {
    try {
      const db = getDb();
      const snapshot = createOrUpdateDashboardSnapshot(db, todaySaoPaulo());
      res.json({ snapshot });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/dashboards/overview (mantido para compatibilidade) ────────────────
dashboardsRouter.get("/dashboards/overview", requireAuth, requireAdmin, (_req, res, next) => {
  try {
    const db = getDb();
    const overview  = getDashboardOverview(db);
    const lastSnap  = db
      .prepare(
        `SELECT ss.id, ss.total_units, ss.created_at, ss.created_by,
                cs.responsible_name, cs.count_type
         FROM stock_snapshots ss
         LEFT JOIN count_sessions cs ON cs.id = ss.count_session_id
         WHERE ss.status = 'OFFICIAL'
         ORDER BY ss.id DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;

    // Mantém o shape antigo para não quebrar nada que porventura ainda use
    res.json({
      stock: {
        total: overview.stock.totalUnits,
        baseType: overview.stock.baseType,
        lastSnapshot: lastSnap ?? null,
        topParts: [],
      },
      counting: { meta: null, adjustments: [] },
      matchStats: [],
      repairStats: [],
      recentMovements: [],
      recentActivity: [],
      purchaseStats: [],
    });
  } catch (err) {
    next(err);
  }
});
