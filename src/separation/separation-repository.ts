/**
 * Repositório de separação — SQL e persistência.
 * Sem lógica de negócio; só acesso ao banco.
 */

import type { Db } from "../db/database.js";
import type {
  SeparationBatchRow,
  SeparationItemRow,
  SeparationBatchStatus,
  ListSeparationBatchesParams,
  BatchTotals,
} from "./separation-types.js";
import { deriveBatchStatus } from "./separation-status.js";

// ---------------------------------------------------------------------------
// Geração do número do lote (SEP-AAAAMMDD-NNNN) — transacional
// ---------------------------------------------------------------------------

export function generateBatchNumber(db: Db): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `SEP-${today.slice(0, 4)}${today.slice(4, 6)}${today.slice(6, 8)}-`;
  const last = db
    .prepare(
      `SELECT batch_number FROM separation_batches
       WHERE batch_number LIKE ? ORDER BY id DESC LIMIT 1`,
    )
    .get(`${prefix}%`) as { batch_number: string } | undefined;

  let seq = 1;
  if (last) {
    const parts = last.batch_number.split("-");
    const n = parseInt(parts[parts.length - 1] ?? "0", 10);
    seq = (isNaN(n) ? 0 : n) + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

export function insertSeparationBatch(
  db: Db,
  input: {
    batchNumber: string;
    matchRunId: number;
    createdBy: string;
    notes: string | null;
    idempotencyKey: string;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO separation_batches (batch_number, match_run_id, status, idempotency_key,
         created_by, notes)
       VALUES (?, ?, 'OPEN', ?, ?, ?)`,
    )
    .run(
      input.batchNumber,
      input.matchRunId,
      input.idempotencyKey,
      input.createdBy,
      input.notes ?? null,
    );
  return r.lastInsertRowid as number;
}

export function insertSeparationItem(
  db: Db,
  input: {
    separationBatchId: number;
    matchRunId: number;
    matchResultId: number;
    matchDeviceResultId: number | null;
    sourceOrderPartId: number;
    idPedido: string;
    imei: string | null;
    os: string | null;
    description: string | null;
    chavePeca: string | null;
    chavePecaNorm: string | null;
    reference: string | null;
    referenceNorm: string | null;
    matchResultStatus: string | null;
    matchAllocationPhase: string | null;
    matchConsumptionOrder: number | null;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO separation_items
         (separation_batch_id, match_run_id, match_result_id, match_device_result_id,
          source_order_part_id, id_pedido, imei, os, description,
          chave_peca, chave_peca_norm, reference, reference_norm, quantity,
          match_result_status, match_allocation_phase, match_consumption_order,
          status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'RESERVED')`,
    )
    .run(
      input.separationBatchId,
      input.matchRunId,
      input.matchResultId,
      input.matchDeviceResultId ?? null,
      input.sourceOrderPartId,
      input.idPedido,
      input.imei ?? null,
      input.os ?? null,
      input.description ?? null,
      input.chavePeca ?? null,
      input.chavePecaNorm ?? null,
      input.reference ?? null,
      input.referenceNorm ?? null,
      input.matchResultStatus ?? null,
      input.matchAllocationPhase ?? null,
      input.matchConsumptionOrder ?? null,
    );
  return r.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export function getSeparationBatch(db: Db, id: number): SeparationBatchRow | undefined {
  return db
    .prepare("SELECT * FROM separation_batches WHERE id = ?")
    .get(id) as SeparationBatchRow | undefined;
}

export function getSeparationBatchByIdempotencyKey(
  db: Db,
  key: string,
): SeparationBatchRow | undefined {
  return db
    .prepare("SELECT * FROM separation_batches WHERE idempotency_key = ?")
    .get(key) as SeparationBatchRow | undefined;
}

export function getSeparationItem(db: Db, id: number): SeparationItemRow | undefined {
  return db
    .prepare("SELECT * FROM separation_items WHERE id = ?")
    .get(id) as SeparationItemRow | undefined;
}

export function getItemsByBatch(db: Db, batchId: number): SeparationItemRow[] {
  return db
    .prepare("SELECT * FROM separation_items WHERE separation_batch_id = ? ORDER BY id")
    .all(batchId) as unknown as SeparationItemRow[];
}

export function getReservedItemsByDevice(
  db: Db,
  batchId: number,
  deviceResultId: number,
): SeparationItemRow[] {
  return db
    .prepare(
      `SELECT * FROM separation_items
       WHERE separation_batch_id = ? AND match_device_result_id = ? AND status = 'RESERVED'
       ORDER BY id`,
    )
    .all(batchId, deviceResultId) as unknown as SeparationItemRow[];
}

export function getItemsByDevice(
  db: Db,
  batchId: number,
  deviceResultId: number,
): SeparationItemRow[] {
  return db
    .prepare(
      `SELECT * FROM separation_items
       WHERE separation_batch_id = ? AND match_device_result_id = ? ORDER BY id`,
    )
    .all(batchId, deviceResultId) as unknown as SeparationItemRow[];
}

/** Verifica se existe reserva ativa para um ID_PEDIDO (status RESERVED ou CONFIRMED). */
export function getActiveItemByIdPedido(db: Db, idPedido: string): SeparationItemRow | undefined {
  return db
    .prepare(
      `SELECT * FROM separation_items
       WHERE id_pedido = ? AND status IN ('RESERVED','CONFIRMED') LIMIT 1`,
    )
    .get(idPedido) as SeparationItemRow | undefined;
}

/** Retorna todos os match_result_ids ativamente reservados ou confirmados. */
export function getActiveReservationsByRunId(db: Db, runId: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT match_result_id FROM separation_items
       WHERE match_run_id = ? AND status IN ('RESERVED','CONFIRMED')`,
    )
    .all(runId) as { match_result_id: number }[];
  return new Set(rows.map((r) => r.match_result_id));
}

/** IDs de pedido com reserva ativa (RESERVED ou CONFIRMED). */
export function getActiveReservedIdPedidos(db: Db): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT id_pedido FROM separation_items WHERE status IN ('RESERVED','CONFIRMED')`,
    )
    .all() as { id_pedido: string }[];
  return new Set(rows.map((r) => r.id_pedido));
}

/**
 * Reservas ativas agrupadas por (reference_norm, chave_peca_norm).
 * Usado pelo stock-service para calcular reservedQuantity.
 */
export function getActiveReservationsByRef(
  db: Db,
): { reference_norm: string; chave_peca_norm: string; reserved: number }[] {
  return db
    .prepare(
      `SELECT reference_norm, chave_peca_norm, SUM(quantity) AS reserved
       FROM separation_items
       WHERE status = 'RESERVED'
         AND reference_norm IS NOT NULL AND chave_peca_norm IS NOT NULL
       GROUP BY reference_norm, chave_peca_norm`,
    )
    .all() as { reference_norm: string; chave_peca_norm: string; reserved: number }[];
}

/** Máximo id de item de separação com reserva ativa (para fingerprint). */
export function maxActiveReservationId(db: Db): number {
  const r = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS m FROM separation_items WHERE status IN ('RESERVED','CONFIRMED')`,
    )
    .get() as { m: number };
  return r.m;
}

// ---------------------------------------------------------------------------
// Atualização de status
// ---------------------------------------------------------------------------

export function confirmSeparationItem(
  db: Db,
  itemId: number,
  input: {
    confirmedBy: string;
    notes: string | null;
    idempotencyKey: string;
    stockMovementId: number;
    operationalEventId: number;
  },
): void {
  db.prepare(
    `UPDATE separation_items SET
       status = 'CONFIRMED',
       confirmed_at = datetime('now'),
       confirmed_by = ?,
       confirmation_notes = ?,
       confirmation_idempotency_key = ?,
       stock_movement_id = ?,
       operational_event_id = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.confirmedBy,
    input.notes ?? null,
    input.idempotencyKey,
    input.stockMovementId,
    input.operationalEventId,
    itemId,
  );
}

export function cancelSeparationItem(
  db: Db,
  itemId: number,
  input: { cancelledBy: string; cancelReason: string },
): void {
  db.prepare(
    `UPDATE separation_items SET
       status = 'CANCELLED',
       cancelled_at = datetime('now'),
       cancelled_by = ?,
       cancel_reason = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(input.cancelledBy, input.cancelReason, itemId);
}

export function updateBatchStatus(
  db: Db,
  batchId: number,
  status: SeparationBatchStatus,
  extra?: {
    completedAt?: string | null;
    completedBy?: string | null;
    cancelledAt?: string | null;
    cancelledBy?: string | null;
    cancelReason?: string | null;
  },
): void {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    `UPDATE separation_batches SET
       status = ?,
       completed_at = COALESCE(?, completed_at),
       completed_by = COALESCE(?, completed_by),
       cancelled_at = COALESCE(?, cancelled_at),
       cancelled_by = COALESCE(?, cancelled_by),
       cancel_reason = COALESCE(?, cancel_reason),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    extra?.completedAt ?? null,
    extra?.completedBy ?? null,
    extra?.cancelledAt ?? null,
    extra?.cancelledBy ?? null,
    extra?.cancelReason ?? null,
    now,
    batchId,
  );
}

// ---------------------------------------------------------------------------
// Totais
// ---------------------------------------------------------------------------

export function getBatchTotals(db: Db, batchId: number): BatchTotals {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
         SUM(CASE WHEN status='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) AS cancelled
       FROM separation_items WHERE separation_batch_id = ?`,
    )
    .get(batchId) as { total: number; reserved: number; confirmed: number; cancelled: number };

  const devRows = db
    .prepare(
      `SELECT match_device_result_id,
         SUM(CASE WHEN status='CONFIRMED' THEN 1 ELSE 0 END) AS conf,
         COUNT(*) AS total
       FROM separation_items WHERE separation_batch_id = ? AND match_device_result_id IS NOT NULL
       GROUP BY match_device_result_id`,
    )
    .all(batchId) as { match_device_result_id: number; conf: number; total: number }[];

  const totalDevices = devRows.length;
  const completedDevices = devRows.filter((d) => d.conf === d.total && d.total > 0).length;

  return {
    totalItems: row.total ?? 0,
    reservedItems: row.reserved ?? 0,
    confirmedItems: row.confirmed ?? 0,
    cancelledItems: row.cancelled ?? 0,
    totalDevices,
    completedDevices,
  };
}

// ---------------------------------------------------------------------------
// Listagem com filtros
// ---------------------------------------------------------------------------

export function listSeparationBatches(
  db: Db,
  params: ListSeparationBatchesParams,
): { batches: SeparationBatchRow[]; total: number } {
  const where: string[] = [];
  const p: (string | number | null)[] = [];

  if (params.status) { where.push("b.status = ?"); p.push(params.status); }
  if (params.batchNumber) { where.push("b.batch_number LIKE ?"); p.push(`%${params.batchNumber}%`); }
  if (params.createdBy) { where.push("b.created_by LIKE ?"); p.push(`%${params.createdBy}%`); }
  if (params.matchRunId) { where.push("b.match_run_id = ?"); p.push(params.matchRunId); }
  if (params.dateFrom) { where.push("b.created_at >= ?"); p.push(params.dateFrom); }
  if (params.dateTo) { where.push("b.created_at <= ?"); p.push(params.dateTo); }

  // Filtros que requerem JOIN em items
  if (params.imei || params.os || params.idPedido) {
    where.push(
      `EXISTS (SELECT 1 FROM separation_items si WHERE si.separation_batch_id = b.id` +
        (params.imei ? " AND si.imei LIKE ?" : "") +
        (params.os ? " AND si.os LIKE ?" : "") +
        (params.idPedido ? " AND si.id_pedido = ?" : "") +
        ")",
    );
    if (params.imei) p.push(`%${params.imei}%`);
    if (params.os) p.push(`%${params.os}%`);
    if (params.idPedido) p.push(params.idPedido);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM separation_batches b ${whereClause}`).get(...p) as {
      c: number;
    }
  ).c;
  const batches = db
    .prepare(
      `SELECT b.* FROM separation_batches b ${whereClause} ORDER BY b.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...p, limit, offset) as unknown as SeparationBatchRow[];

  return { batches, total };
}

// ---------------------------------------------------------------------------
// Recalcular e persistir status do lote baseado nos itens atuais
// ---------------------------------------------------------------------------

export function recalculateAndPersistBatchStatus(
  db: Db,
  batchId: number,
  extra?: {
    completedBy?: string;
    cancelledBy?: string;
    cancelReason?: string;
  },
): SeparationBatchStatus {
  const items = getItemsByBatch(db, batchId);
  const statuses = items.map((i) => i.status);
  const newStatus = deriveBatchStatus(statuses);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  updateBatchStatus(db, batchId, newStatus, {
    completedAt: newStatus === "COMPLETED" ? now : undefined,
    completedBy: newStatus === "COMPLETED" ? extra?.completedBy : undefined,
    cancelledAt: newStatus === "CANCELLED" ? now : undefined,
    cancelledBy: newStatus === "CANCELLED" ? extra?.cancelledBy : undefined,
    cancelReason:
      newStatus === "CANCELLED" || newStatus === "PARTIALLY_COMPLETED"
        ? extra?.cancelReason
        : undefined,
  });
  return newStatus;
}
