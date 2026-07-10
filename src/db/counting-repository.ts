import type { Db } from "./database.js";

export interface CountSessionRow {
  id: number;
  import_batch_id: number | null;
  responsible_name: string;
  status: "OPEN" | "FINALIZED" | "CANCELLED";
  started_at: string;
  finished_at: string | null;
  notes: string | null;
  finalized_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  baseline_type: "INITIAL_IMPORT" | "OFFICIAL_SNAPSHOT" | null;
  baseline_snapshot_id: number | null;
  baseline_cutoff_movement_id: number;
  baseline_total_units: number;
  count_type: "OFICIAL" | "PARCIAL_TESTE";
}

export interface CountScanRow {
  id: number;
  session_id: number;
  reference: string;
  reference_norm: string;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  mapping_status: "RECOGNIZED" | "UNKNOWN_REFERENCE" | "MISSING_KEY" | "CONFLICT";
  source: string | null;
  scanned_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

export interface ReferenceMappingRow {
  id: number;
  reference: string;
  reference_norm: string;
  chave_peca: string;
  chave_peca_norm: string;
  active: number;
  created_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface StockSnapshotRow {
  id: number;
  count_session_id: number;
  import_batch_id: number | null;
  status: "OFFICIAL";
  total_units: number;
  created_at: string;
  created_by: string | null;
  notes: string | null;
  baseline_movement_id_max: number;
}

export interface StockSnapshotItemRow {
  id: number;
  snapshot_id: number;
  reference: string;
  reference_norm: string;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  counted_quantity: number;
}

export function createSession(
  db: Db,
  p: {
    importBatchId: number;
    responsibleName: string;
    notes: string | null;
    baselineType: "INITIAL_IMPORT" | "OFFICIAL_SNAPSHOT";
    baselineSnapshotId: number | null;
    baselineCutoffMovementId: number;
    baselineTotalUnits: number;
    countType?: "OFICIAL" | "PARCIAL_TESTE";
  },
): CountSessionRow {
  const r = db
    .prepare(
      `INSERT INTO count_sessions
        (import_batch_id, responsible_name, status, notes,
         baseline_type, baseline_snapshot_id, baseline_cutoff_movement_id, baseline_total_units,
         count_type)
       VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.importBatchId, p.responsibleName, p.notes,
      p.baselineType, p.baselineSnapshotId, p.baselineCutoffMovementId, p.baselineTotalUnits,
      p.countType ?? "OFICIAL",
    );
  return getSessionByIdOrThrow(db, Number(r.lastInsertRowid));
}

export function getSessionByIdOrThrow(db: Db, id: number): CountSessionRow {
  const row = db.prepare("SELECT * FROM count_sessions WHERE id = ?").get(id);
  if (!row) throw new Error(`Sessão de contagem ${id} não encontrada.`);
  return row as unknown as CountSessionRow;
}

export function insertScan(
  db: Db,
  p: {
    sessionId: number;
    reference: string;
    referenceNorm: string;
    chavePeca: string | null;
    chavePecaNorm: string | null;
    mappingStatus: "RECOGNIZED" | "UNKNOWN_REFERENCE" | "MISSING_KEY" | "CONFLICT";
    source: string | null;
  },
): CountScanRow {
  const r = db
    .prepare(
      `INSERT INTO count_scans
        (session_id, reference, reference_norm, chave_peca, chave_peca_norm, mapping_status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.sessionId, p.reference, p.referenceNorm, p.chavePeca, p.chavePecaNorm, p.mappingStatus, p.source);
  return db.prepare("SELECT * FROM count_scans WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as CountScanRow;
}

/** Cancelamento idempotente: se já cancelado, não sobrescreve o cancelamento original. */
export function cancelScan(
  db: Db,
  scanId: number,
  p: { cancelledBy: string; cancelReason: string },
): CountScanRow | null {
  const existing = db.prepare("SELECT * FROM count_scans WHERE id = ?").get(scanId) as
    | unknown
    | undefined;
  if (!existing) return null;
  const existingRow = existing as CountScanRow;
  if (existingRow.cancelled_at) return existingRow; // idempotente — não sobrescreve
  db.prepare(
    "UPDATE count_scans SET cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?",
  ).run(p.cancelledBy, p.cancelReason, scanId);
  return db.prepare("SELECT * FROM count_scans WHERE id = ?").get(scanId) as unknown as CountScanRow;
}

/** Cancela todos os scans ATIVOS de uma referência na sessão. Retorna quantos foram cancelados. */
export function cancelScansByReference(
  db: Db,
  p: { sessionId: number; referenceNorm: string; cancelledBy: string; cancelReason: string },
): number {
  const r = db
    .prepare(
      `UPDATE count_scans
       SET cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?
       WHERE session_id = ? AND reference_norm = ? AND cancelled_at IS NULL`,
    )
    .run(p.cancelledBy, p.cancelReason, p.sessionId, p.referenceNorm);
  return Number(r.changes);
}

export function cancelSession(
  db: Db,
  sessionId: number,
  p: { cancelledBy: string; cancelReason: string },
): CountSessionRow {
  db.prepare(
    `UPDATE count_sessions
     SET status = 'CANCELLED', cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?
     WHERE id = ?`,
  ).run(p.cancelledBy, p.cancelReason, sessionId);
  return getSessionByIdOrThrow(db, sessionId);
}

export function finalizeSessionStatus(db: Db, sessionId: number, finalizedBy: string): void {
  db.prepare(
    `UPDATE count_sessions
     SET status = 'FINALIZED', finished_at = datetime('now'), finalized_by = ?
     WHERE id = ?`,
  ).run(finalizedBy, sessionId);
}

/**
 * Cria/atualiza o mapeamento ativo da referência, preservando histórico.
 *
 * - Sem mapeamento ativo: insere um novo (ativo).
 * - Mapeamento ativo com a MESMA chave: não duplica — só atualiza
 *   responsável/observação/`updated_at` na linha existente.
 * - Mapeamento ativo com chave DIFERENTE: desativa a linha antiga (preserva
 *   chave/responsável/observação/datas originais intactas) e insere uma nova
 *   linha ativa — nunca sobrescreve o registro anterior.
 *
 * Roda em transação própria (a chamadora não está dentro de outra transação).
 */
export function upsertReferenceMapping(
  db: Db,
  p: {
    reference: string;
    referenceNorm: string;
    chavePeca: string;
    chavePecaNorm: string;
    createdBy: string;
    notes: string | null;
  },
): ReferenceMappingRow {
  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT * FROM reference_mappings WHERE reference_norm = ? AND active = 1")
      .get(p.referenceNorm) as unknown as ReferenceMappingRow | undefined;

    let resultId: number;
    if (existing && existing.chave_peca_norm === p.chavePecaNorm) {
      // Mesma chave — evita duplicação desnecessária; só atualiza metadados.
      db.prepare(
        `UPDATE reference_mappings SET created_by = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(p.createdBy, p.notes, existing.id);
      resultId = existing.id;
    } else {
      if (existing) {
        db.prepare(
          `UPDATE reference_mappings SET active = 0, updated_at = datetime('now') WHERE id = ?`,
        ).run(existing.id);
      }
      const r = db
        .prepare(
          `INSERT INTO reference_mappings (reference, reference_norm, chave_peca, chave_peca_norm, active, created_by, notes)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(p.reference, p.referenceNorm, p.chavePeca, p.chavePecaNorm, p.createdBy, p.notes);
      resultId = Number(r.lastInsertRowid);
    }
    db.exec("COMMIT");
    return db.prepare("SELECT * FROM reference_mappings WHERE id = ?").get(resultId) as unknown as ReferenceMappingRow;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Histórico completo (ativo + desativados) de mapeamentos para uma referência. */
export function getMappingHistory(db: Db, referenceNorm: string): ReferenceMappingRow[] {
  return db
    .prepare("SELECT * FROM reference_mappings WHERE reference_norm = ? ORDER BY id DESC")
    .all(referenceNorm) as unknown as ReferenceMappingRow[];
}

export function createSnapshot(
  db: Db,
  p: {
    countSessionId: number;
    importBatchId: number | null;
    totalUnits: number;
    createdBy: string;
    notes: string | null;
    baselineMovementIdMax: number;
  },
): StockSnapshotRow {
  const r = db
    .prepare(
      `INSERT INTO stock_snapshots (count_session_id, import_batch_id, status, total_units, created_by, notes, baseline_movement_id_max)
       VALUES (?, ?, 'OFFICIAL', ?, ?, ?, ?)`,
    )
    .run(p.countSessionId, p.importBatchId, p.totalUnits, p.createdBy, p.notes, p.baselineMovementIdMax);
  return db.prepare("SELECT * FROM stock_snapshots WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as StockSnapshotRow;
}

export function insertSnapshotItems(
  db: Db,
  snapshotId: number,
  items: { reference: string; referenceNorm: string; chavePeca: string | null; chavePecaNorm: string | null; countedQuantity: number }[],
): void {
  const stmt = db.prepare(
    `INSERT INTO stock_snapshot_items
      (snapshot_id, reference, reference_norm, chave_peca, chave_peca_norm, counted_quantity)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const it of items) {
    stmt.run(snapshotId, it.reference, it.referenceNorm, it.chavePeca, it.chavePecaNorm, it.countedQuantity);
  }
}
