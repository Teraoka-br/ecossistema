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

dataRouter.get("/cotacoes", (req, res) => {
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
