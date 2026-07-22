import { Router } from "express";
import { getDb } from "../../db/database.js";
import {
  activeBatchId,
  diagnostic,
  distinctOrderStatuses,
  groupByDevice,
  inventoryTotalUnits,
  listInventoryGroups,
  listInventoryItems,
  listOrderParts,
  listQuotations,
} from "../../db/queries.js";
import { latestOfficialSnapshot, listSnapshotItems } from "../../db/counting-queries.js";
import { getSessionByIdOrThrow } from "../../db/counting-repository.js";
import { getCurrentOperationalStock } from "../../operational/stock-service.js";

export const dataRouter = Router();

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

dataRouter.get("/diagnostico", (req, res) => {
  const batchId = str(req.query.batchId);
  const report = diagnostic(getDb(), batchId ? Number(batchId) : undefined);
  res.json(report);
});

// Casos elegíveis ao motor de match com age_days ou margin ausentes
dataRouter.get("/diagnostico/score-gaps", (_req, res) => {
  const db = getDb();
  const TERMINAL = ["CONCLUIDO", "VENDA_ESTADO", "CANCELADO"];
  const rows = db.prepare(`
    SELECT rc.id, rc.imei, rc.brand, rc.model, rc.color, rc.os,
           rc.workflow_status, rc.age_days, rc.cost, rc.estimated_sale, rc.margin, rc.deposito_atual,
           (SELECT COUNT(*) FROM part_requests pr
            WHERE pr.repair_case_id = rc.id AND pr.cancelled_at IS NULL
              AND pr.status NOT IN ('CANCELADA','SEPARADA','CONSUMIDA','RESERVADA')) AS open_parts
    FROM repair_cases rc
    WHERE rc.analysis_status = 'COMPLETED'
      AND rc.workflow_status NOT IN (${TERMINAL.map(() => "?").join(",")})
      AND (rc.age_days IS NULL OR rc.margin IS NULL)
    ORDER BY rc.id ASC
  `).all(...TERMINAL) as Array<{
    id: number; imei: string | null; brand: string | null; model: string | null;
    color: string | null; os: string | null; workflow_status: string;
    age_days: number | null; cost: number | null; estimated_sale: number | null;
    margin: number | null; open_parts: number; deposito_atual: string | null;
  }>;

  res.json({
    total: rows.length,
    cases: rows.map(r => ({
      id: r.id, imei: r.imei, brand: r.brand, model: r.model, color: r.color, os: r.os,
      workflowStatus: r.workflow_status, ageDays: r.age_days, cost: r.cost,
      estimatedSale: r.estimated_sale, margin: r.margin, openParts: r.open_parts,
      depositoAtual: r.deposito_atual,
    })),
  });
});

dataRouter.get("/pedidos", (req, res) => {
  const db = getDb();
  const batchId = activeBatchId(db);
  if (batchId === null) {
    return res.json({ batchId: null, statuses: [], devices: [], totalParts: 0 });
  }
  const parts = listOrderParts(db, batchId, {
    search: str(req.query.search),
    status: str(req.query.status),
  });
  res.json({
    batchId,
    statuses: distinctOrderStatuses(db, batchId),
    devices: groupByDevice(parts),
    totalParts: parts.length,
  });
});

dataRouter.get("/estoque", (req, res) => {
  const db = getDb();
  const batchId = activeBatchId(db);
  const search = str(req.query.search);

  const legacy =
    batchId === null
      ? { totalUnits: 0, groups: [], items: [] }
      : {
          totalUnits: inventoryTotalUnits(db, batchId),
          groups: listInventoryGroups(db, batchId, search),
          items: listInventoryItems(db, batchId, search),
        };

  // Estoque oficial = último stock_snapshot com status OFFICIAL (entre TODAS as
  // sessões). Antes da primeira contagem finalizada, não existe — a tela usa o legado.
  const snapshot = latestOfficialSnapshot(db);
  let official = null;
  if (snapshot) {
    const session = getSessionByIdOrThrow(db, snapshot.count_session_id);
    const items = listSnapshotItems(db, snapshot.id);
    official = {
      snapshotId: snapshot.id,
      sessionId: snapshot.count_session_id,
      createdAt: snapshot.created_at,
      createdBy: snapshot.created_by,
      totalUnits: snapshot.total_units,
      comparisonBatchId: snapshot.import_batch_id,
      responsibleName: session.responsible_name,
      groups: items.map((it) => ({
        referencia: it.reference,
        chavePeca: it.chave_peca_norm ? it.chave_peca : null,
        unidades: it.counted_quantity,
        mapeada: !!it.chave_peca_norm,
      })),
    };
  }

  // Estoque operacional (Etapa 7): base oficial (snapshot ou importação
  // inicial) + movimentações posteriores (ex.: recebimentos) = quantidade
  // atual. Fica disponível ao lado dos campos legados (compatibilidade).
  const operational = getCurrentOperationalStock(db);

  res.json({
    origin: snapshot ? "OFFICIAL" : "LEGACY",
    batchId,
    legacy,
    official,
    operational,
  });
});

dataRouter.get("/cotacoes-legado", (req, res) => {
  const db = getDb();
  const batchId = activeBatchId(db);
  if (batchId === null) {
    return res.json({ batchId: null, quotations: [] });
  }
  res.json({
    batchId,
    quotations: listQuotations(db, batchId, str(req.query.search)),
  });
});
