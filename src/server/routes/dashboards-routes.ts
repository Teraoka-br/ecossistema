import { Router } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import { getAuditLog } from "../../audit/audit-service.js";
import * as q from "../../db/counting-queries.js";

export const dashboardsRouter = Router();

dashboardsRouter.get("/dashboards/overview", requireAuth, requireAdmin, (_req, res, next) => {
  try {
    const db = getDb();

    // ── Estoque atual ─────────────────────────────────────────────────────────
    const lastSnapshot = db.prepare(`
      SELECT ss.id, ss.total_units, ss.created_at, ss.created_by, ss.notes,
             cs.responsible_name, cs.count_type
      FROM stock_snapshots ss
      LEFT JOIN count_sessions cs ON cs.id = ss.count_session_id
      WHERE ss.status = 'OFFICIAL'
      ORDER BY ss.id DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    // Total do estoque operacional: base + movimentos não estornados
    const movTotal = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as q
      FROM stock_movements WHERE reversed_at IS NULL
    `).get() as { q: number };

    let baseTotal = 0;
    if (lastSnapshot) {
      baseTotal = lastSnapshot.total_units as number;
    } else {
      const si = db.prepare(`SELECT COUNT(*) as c FROM source_inventory_items`).get() as { c: number };
      baseTotal = si.c;
    }
    const stockTotal = baseTotal + movTotal.q;

    // Top 10 chaves por quantidade no último snapshot (ou importação)
    const topParts = lastSnapshot
      ? db.prepare(`
          SELECT chave_peca, SUM(counted_quantity) as qty
          FROM stock_snapshot_items WHERE snapshot_id = ?
          GROUP BY chave_peca ORDER BY qty DESC LIMIT 10
        `).all(lastSnapshot.id as number) as { chave_peca: string; qty: number }[]
      : db.prepare(`
          SELECT chave_peca, COUNT(*) as qty
          FROM source_inventory_items WHERE chave_peca IS NOT NULL
          GROUP BY chave_peca ORDER BY qty DESC LIMIT 10
        `).all() as { chave_peca: string; qty: number }[];

    // ── Última contagem: ajustes ──────────────────────────────────────────────
    let countingAdjustments: {
      reference: string;
      chavePeca: string | null;
      countedQty: number;
      legacyQty: number;
      delta: number;
    }[] = [];
    let countingMeta: {
      sessionId: number;
      responsibleName: string;
      countType: string;
      snapshotAt: string;
      totalCounted: number;
      totalLegacy: number;
      totalDelta: number;
    } | null = null;

    if (lastSnapshot) {
      const snapId = lastSnapshot.id as number;
      const batchId = db.prepare(`SELECT import_batch_id FROM stock_snapshots WHERE id = ?`).get(snapId) as { import_batch_id: number | null } | undefined;

      if (batchId?.import_batch_id) {
        const counted = db.prepare(`
          SELECT reference, chave_peca, chave_peca_norm, reference_norm, SUM(counted_quantity) as qty
          FROM stock_snapshot_items WHERE snapshot_id = ?
          GROUP BY reference_norm, chave_peca_norm
        `).all(snapId) as { reference: string; chave_peca: string | null; chave_peca_norm: string | null; reference_norm: string; qty: number }[];

        const legacyMap = q.legacyUnitsByReference(db, batchId.import_batch_id);

        const allRefs = new Set([...counted.map(c => c.reference_norm), ...legacyMap.keys()]);
        const countedMap = new Map(counted.map(c => [c.reference_norm, c]));

        const diffs = [...allRefs]
          .map((rn) => {
            const c = countedMap.get(rn);
            const legacy = legacyMap.get(rn) ?? 0;
            const count = c?.qty ?? 0;
            return {
              reference: c?.reference ?? rn,
              chavePeca: c?.chave_peca ?? null,
              countedQty: count,
              legacyQty: legacy,
              delta: count - legacy,
            };
          })
          .filter(d => d.delta !== 0)
          .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

        countingAdjustments = diffs.slice(0, 50);

        const legacyTotal = [...legacyMap.values()].reduce((s, v) => s + v, 0);
        const countedTotal = counted.reduce((s, c) => s + c.qty, 0);

        countingMeta = {
          sessionId: lastSnapshot.id as number,
          responsibleName: (lastSnapshot.responsible_name ?? lastSnapshot.created_by ?? "—") as string,
          countType: (lastSnapshot.count_type ?? "OFICIAL") as string,
          snapshotAt: lastSnapshot.created_at as string,
          totalCounted: countedTotal,
          totalLegacy: legacyTotal,
          totalDelta: countedTotal - legacyTotal,
        };
      }
    }

    // ── Match (part_requests por status) ─────────────────────────────────────
    const matchStats = db.prepare(`
      SELECT status, COUNT(*) as c
      FROM part_requests WHERE cancelled_at IS NULL
      GROUP BY status ORDER BY c DESC
    `).all() as { status: string; c: number }[];

    // ── Reparos por workflow ──────────────────────────────────────────────────
    const repairStats = db.prepare(`
      SELECT workflow_status, COUNT(*) as c
      FROM repair_cases WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO')
      GROUP BY workflow_status ORDER BY c DESC
    `).all() as { workflow_status: string; c: number }[];

    // ── Estoque: movimentações recentes ───────────────────────────────────────
    const recentMovements = db.prepare(`
      SELECT sm.id, sm.movement_type, sm.chave_peca, sm.referencia, sm.quantity,
             sm.source_type, sm.created_at, sm.reversed_at
      FROM stock_movements sm
      WHERE sm.reversed_at IS NULL
      ORDER BY sm.id DESC LIMIT 15
    `).all() as Record<string, unknown>[];

    // ── Atividade recente (audit) ─────────────────────────────────────────────
    const { entries: recentActivity } = getAuditLog(db, { limit: 15 });

    // ── Compras pendentes ─────────────────────────────────────────────────────
    const purchaseStats = db.prepare(`
      SELECT status, COUNT(*) as c FROM purchase_orders GROUP BY status
    `).all() as { status: string; c: number }[];

    res.json({
      stock: {
        total: stockTotal,
        baseType: lastSnapshot ? "OFFICIAL_SNAPSHOT" : "INITIAL_IMPORT",
        lastSnapshot: lastSnapshot ?? null,
        topParts,
      },
      counting: {
        meta: countingMeta,
        adjustments: countingAdjustments,
      },
      matchStats,
      repairStats,
      recentMovements,
      recentActivity,
      purchaseStats,
    });
  } catch (err) {
    next(err);
  }
});
