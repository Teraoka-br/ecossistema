import type { Db } from "./database.js";
import type {
  CatalogLookup,
  ChaveOption,
  ManualMapping,
} from "../domain/reference-catalog.js";
import type {
  CountScanRow,
  CountSessionRow,
  ReferenceMappingRow,
  StockSnapshotItemRow,
  StockSnapshotRow,
} from "./counting-repository.js";

export function getOpenSession(db: Db): CountSessionRow | null {
  const row = db.prepare("SELECT * FROM count_sessions WHERE status = 'OPEN' LIMIT 1").get();
  return (row as unknown as CountSessionRow | undefined) ?? null;
}

export function getSessionById(db: Db, id: number): CountSessionRow | null {
  return (
    (db.prepare("SELECT * FROM count_sessions WHERE id = ?").get(id) as unknown as CountSessionRow | undefined) ?? null
  );
}

export function listScansBySession(
  db: Db,
  sessionId: number,
  opts: { onlyActive?: boolean; limit?: number } = {},
): CountScanRow[] {
  const where = opts.onlyActive ? "AND cancelled_at IS NULL" : "";
  return db
    .prepare(
      `SELECT * FROM count_scans WHERE session_id = ? ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionId, opts.limit ?? 5000) as unknown as CountScanRow[];
}

export function activeScanCountForReference(db: Db, sessionId: number, referenceNorm: string): number {
  const r = db
    .prepare(
      "SELECT COUNT(*) AS c FROM count_scans WHERE session_id = ? AND reference_norm = ? AND cancelled_at IS NULL",
    )
    .get(sessionId, referenceNorm) as { c: number };
  return r.c;
}

export function getScanById(db: Db, scanId: number): CountScanRow | null {
  return (
    (db.prepare("SELECT * FROM count_scans WHERE id = ?").get(scanId) as unknown as CountScanRow | undefined) ?? null
  );
}

export interface ReferenceTotalRow {
  reference_norm: string;
  reference: string;
  active_count: number;
}

/**
 * Total de beeps ATIVOS por `reference_norm` (ignorando a chave histórica
 * gravada em cada scan) — base correta para recalcular a chave efetiva uma
 * única vez por referência e somar todos os beeps daquela referência, em vez
 * de fragmentar por variações de `chave_peca_norm` registradas ao longo do
 * tempo (essa fragmentação era a causa da perda de unidades após resolução
 * manual de uma referência que tinha beeps antes e depois da resolução).
 */
export function activeScanCountsByReference(db: Db, sessionId: number): ReferenceTotalRow[] {
  return db
    .prepare(
      `SELECT reference_norm,
              (SELECT reference FROM count_scans s2
                WHERE s2.session_id = count_scans.session_id AND s2.reference_norm = count_scans.reference_norm
                  AND s2.cancelled_at IS NULL ORDER BY s2.id DESC LIMIT 1) AS reference,
              COUNT(*) AS active_count
       FROM count_scans
       WHERE session_id = ? AND cancelled_at IS NULL
       GROUP BY reference_norm`,
    )
    .all(sessionId) as unknown as ReferenceTotalRow[];
}

/** A CHAVEPECA normalizada existe no catálogo do lote, em part_requests ativos ou em custom_part_keys? */
export function catalogHasKey(db: Db, importBatchId: number, chavePecaNorm: string): boolean {
  // Catálogo legado (source_inventory_items)
  const inLegacy = db
    .prepare("SELECT 1 FROM source_inventory_items WHERE import_batch_id = ? AND chave_peca_norm = ? LIMIT 1")
    .get(importBatchId, chavePecaNorm);
  if (inLegacy !== undefined) return true;
  // Chaves criadas manualmente via bipagem ou tela de referências
  const inCustom = db
    .prepare("SELECT 1 FROM custom_part_keys WHERE chave_peca_norm = ? LIMIT 1")
    .get(chavePecaNorm);
  if (inCustom !== undefined) return true;
  // Fallback: part_requests ativos
  const inParts = db
    .prepare("SELECT 1 FROM part_requests WHERE chave_peca_norm = ? AND status != 'CANCELADO' LIMIT 1")
    .get(chavePecaNorm);
  return inParts !== undefined;
}

export function getActiveMapping(db: Db, referenceNorm: string): ManualMapping | null {
  const row = db
    .prepare("SELECT chave_peca, chave_peca_norm FROM reference_mappings WHERE reference_norm = ? AND active = 1")
    .get(referenceNorm) as { chave_peca: string; chave_peca_norm: string } | undefined;
  if (!row) return null;
  return { chavePeca: row.chave_peca, chavePecaNorm: row.chave_peca_norm };
}

export function getActiveMappingRow(db: Db, referenceNorm: string): ReferenceMappingRow | null {
  return (
    (db
      .prepare("SELECT * FROM reference_mappings WHERE reference_norm = ? AND active = 1")
      .get(referenceNorm) as unknown as ReferenceMappingRow | undefined) ?? null
  );
}

/** Catálogo (estoque importado) para uma referência normalizada, dentro de um lote. */
export function catalogLookup(db: Db, importBatchId: number, referenceNorm: string): CatalogLookup {
  const rows = db
    .prepare(
      `SELECT DISTINCT chave_peca, chave_peca_norm
       FROM source_inventory_items
       WHERE import_batch_id = ? AND referencia_norm = ? AND chave_peca_norm IS NOT NULL AND chave_peca_norm != ''`,
    )
    .all(importBatchId, referenceNorm) as { chave_peca: string; chave_peca_norm: string }[];

  const existsRow = db
    .prepare("SELECT 1 FROM source_inventory_items WHERE import_batch_id = ? AND referencia_norm = ? LIMIT 1")
    .get(importBatchId, referenceNorm);

  const distinctKeys: ChaveOption[] = rows.map((r) => ({ chavePeca: r.chave_peca, chavePecaNorm: r.chave_peca_norm }));
  return { foundInCatalog: existsRow !== undefined, distinctKeys };
}

/** Chaves distintas do catálogo: legado + custom_part_keys + part_requests ativos. */
export function distinctCatalogKeys(db: Db, importBatchId: number, search?: string): { chavePeca: string; referencia: string }[] {
  const like = search?.trim();
  const likeParam = like ? [`%${like}%`] : [];

  const legacyRows = db.prepare(
    `SELECT chave_peca, MIN(referencia) AS referencia
     FROM source_inventory_items
     WHERE import_batch_id = ? AND chave_peca_norm IS NOT NULL AND chave_peca_norm != ''
       ${like ? "AND chave_peca LIKE ?" : ""}
     GROUP BY chave_peca_norm ORDER BY chave_peca LIMIT 200`,
  ).all(importBatchId, ...likeParam) as { chave_peca: string; referencia: string }[];

  const customRows = db.prepare(
    `SELECT chave_peca, COALESCE(descricao, '') AS referencia
     FROM custom_part_keys
     WHERE chave_peca_norm IS NOT NULL
       ${like ? "AND chave_peca LIKE ?" : ""}
     ORDER BY chave_peca LIMIT 200`,
  ).all(...likeParam) as { chave_peca: string; referencia: string }[];

  const partRows = db.prepare(
    `SELECT chave_peca, '' AS referencia
     FROM part_requests
     WHERE chave_peca_norm IS NOT NULL AND chave_peca_norm != ''
       AND status != 'CANCELADO'
       ${like ? "AND chave_peca LIKE ?" : ""}
     GROUP BY chave_peca_norm ORDER BY chave_peca LIMIT 200`,
  ).all(...likeParam) as { chave_peca: string; referencia: string }[];

  const seen = new Set(legacyRows.map((r) => r.chave_peca?.toLowerCase()));
  const merged = [...legacyRows];
  for (const r of [...customRows, ...partRows]) {
    if (!seen.has(r.chave_peca?.toLowerCase())) {
      merged.push(r);
      seen.add(r.chave_peca?.toLowerCase());
    }
  }
  merged.sort((a, b) => (a.chave_peca ?? "").localeCompare(b.chave_peca ?? ""));
  return merged.slice(0, 200).map((r) => ({ chavePeca: r.chave_peca, referencia: r.referencia }));
}

export interface PendingRow {
  reference_norm: string;
  reference: string;
  mapping_status: "UNKNOWN_REFERENCE" | "MISSING_KEY" | "CONFLICT";
  active_count: number;
  first_scanned_at: string;
  last_scanned_at: string;
}

/** Agrupa pendências (UNKNOWN_REFERENCE/MISSING_KEY/CONFLICT) ativas da sessão. */
export function pendingGroups(db: Db, sessionId: number): PendingRow[] {
  return db
    .prepare(
      `SELECT reference_norm,
              (SELECT reference FROM count_scans s2
                WHERE s2.session_id = count_scans.session_id
                  AND s2.reference_norm = count_scans.reference_norm
                  AND s2.cancelled_at IS NULL
                ORDER BY s2.id DESC LIMIT 1) AS reference,
              mapping_status,
              COUNT(*) AS active_count,
              MIN(scanned_at) AS first_scanned_at,
              MAX(scanned_at) AS last_scanned_at
       FROM count_scans
       WHERE session_id = ? AND cancelled_at IS NULL AND mapping_status != 'RECOGNIZED'
       GROUP BY reference_norm, mapping_status
       ORDER BY last_scanned_at DESC`,
    )
    .all(sessionId) as unknown as PendingRow[];
}

export function activeMappingStatusCounts(db: Db, sessionId: number): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT mapping_status, COUNT(*) AS c FROM count_scans
       WHERE session_id = ? AND cancelled_at IS NULL
       GROUP BY mapping_status`,
    )
    .all(sessionId) as { mapping_status: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.mapping_status] = r.c;
  return out;
}

export interface ConsolidatedRow {
  reference: string;
  reference_norm: string;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  quantity: number;
}

/** Consolida os scans ATIVOS por (referencia_norm, chave_peca_norm efetiva). */
export function consolidateActiveScans(db: Db, sessionId: number): ConsolidatedRow[] {
  return db
    .prepare(
      `SELECT reference_norm,
              (SELECT reference FROM count_scans s2
                WHERE s2.session_id = count_scans.session_id AND s2.reference_norm = count_scans.reference_norm
                  AND s2.cancelled_at IS NULL ORDER BY s2.id DESC LIMIT 1) AS reference,
              chave_peca, chave_peca_norm, COUNT(*) AS quantity
       FROM count_scans
       WHERE session_id = ? AND cancelled_at IS NULL
       GROUP BY reference_norm, chave_peca_norm`,
    )
    .all(sessionId) as unknown as ConsolidatedRow[];
}

export function legacyTotalUnits(db: Db, importBatchId: number): number {
  const r = db
    .prepare("SELECT COUNT(*) AS c FROM source_inventory_items WHERE import_batch_id = ?")
    .get(importBatchId) as { c: number };
  return r.c;
}

/** Total legado de unidades por referencia_norm, para comparação na finalização. */
export function legacyUnitsByReference(db: Db, importBatchId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT referencia_norm, COUNT(*) AS c FROM source_inventory_items
       WHERE import_batch_id = ? GROUP BY referencia_norm`,
    )
    .all(importBatchId) as { referencia_norm: string; c: number }[];
  return new Map(rows.map((r) => [r.referencia_norm, r.c]));
}

export function latestOfficialSnapshot(db: Db): StockSnapshotRow | null {
  return (
    (db
      .prepare("SELECT * FROM stock_snapshots WHERE status = 'OFFICIAL' ORDER BY id DESC LIMIT 1")
      .get() as unknown as StockSnapshotRow | undefined) ?? null
  );
}

export function getSnapshotById(db: Db, id: number): StockSnapshotRow | null {
  return (
    (db.prepare("SELECT * FROM stock_snapshots WHERE id = ?").get(id) as unknown as StockSnapshotRow | undefined) ?? null
  );
}

export function getSnapshotBySession(db: Db, sessionId: number): StockSnapshotRow | null {
  return (
    (db
      .prepare("SELECT * FROM stock_snapshots WHERE count_session_id = ?")
      .get(sessionId) as unknown as StockSnapshotRow | undefined) ?? null
  );
}

export function listSnapshotItems(db: Db, snapshotId: number): StockSnapshotItemRow[] {
  return db
    .prepare("SELECT * FROM stock_snapshot_items WHERE snapshot_id = ? ORDER BY reference")
    .all(snapshotId) as unknown as StockSnapshotItemRow[];
}

/** Conta quantos match_runs/match_results existem — usado só por testes (garantir que nenhum foi criado). */
export function countMatchRunsAndResults(db: Db): { runs: number; results: number } {
  const runs = (db.prepare("SELECT COUNT(*) AS c FROM match_runs").get() as { c: number }).c;
  const results = (db.prepare("SELECT COUNT(*) AS c FROM match_results").get() as { c: number }).c;
  return { runs, results };
}
