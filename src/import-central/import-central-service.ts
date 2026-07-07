/**
 * Central de Dados — serviços de importação por fonte.
 *
 * Sete fontes ativas: his | rel-seriais | analise-mi | pedidos | bkp | triagem-saida | sh
 * Fluxo: upload → preview (PREVIEW_READY em import_staged_files) → confirm → import record.
 * Idempotente por hash de arquivo. Staging persistente sobrevive a reinício.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import type { Db } from "../db/database.js";
import { normalizeKey, normalizeHeader } from "../domain/text.js";
import { streamHisEstoque } from "./his-stream.js";
import { syncCurrentTable, rowHash, type SyncRow } from "./sync-helper.js";

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSX = _require("xlsx") as any;

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class ImportCentralError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportCentralError";
  }
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type SourceKey =
  | "his"
  | "rel-seriais"
  | "analise-mi"
  | "pedidos"
  | "bkp"
  | "triagem-saida"
  | "sh"
  | "peacs"
  | "demonstrativo";

export type StagingStatus =
  | "UPLOADED"
  | "PREVIEW_READY"
  | "CONFIRMED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export interface ImportIssueRaw {
  row: number | null;
  severity: "ERROR" | "WARNING" | "INFO";
  code: string;
  message: string;
  rawValue?: string | null;
}

export interface StagedPreview {
  stagingId: number;
  source: SourceKey;
  filename: string;
  fileHash: string;
  fileSize: number;
  status: StagingStatus;
  alreadyImported: boolean;
  existingImportId: number | null;
  rowsFound: number;
  rowsValid: number;
  issues: ImportIssueRaw[];
  previewRows: Record<string, unknown>[];
  extra?: Record<string, unknown>;
}

export interface ImportHistoryEntry {
  id: number;
  filename: string;
  fileHash: string;
  status: string;
  rowsFound: number;
  rowsValid?: number;
  issuesCount: number;
  createdAt: string;
  finishedAt: string | null;
  createdByName?: string | null;
}

export interface SourceStatus {
  lastImportId: number | null;
  lastImportAt: string | null;
  lastStatus: string | null;
  totalImports: number;
  lastRowsFound: number;
  lastIssuesCount: number;
  pendingStaging: number;
}

export interface AllSourcesStatus {
  his: SourceStatus;
  "rel-seriais": SourceStatus;
  "analise-mi": SourceStatus;
  pedidos: SourceStatus;
  bkp: SourceStatus;
  "triagem-saida": SourceStatus;
  sh: SourceStatus;
  peacs: SourceStatus;
  demonstrativo: SourceStatus;
}

// ---------------------------------------------------------------------------
// Extensões e MIME permitidos por fonte
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS: Record<SourceKey, string[]> = {
  his:            [".xlsx", ".xls"],
  "rel-seriais":  [".csv"],
  "analise-mi":   [".xlsx", ".xls"],
  pedidos:        [".xlsx", ".xls"],
  bkp:            [".xlsx", ".xls"],
  "triagem-saida":[".xlsx", ".xls"],
  sh:             [".xlsx", ".xls"],
  peacs:          [".xlsx", ".xls"],
  demonstrativo:  [".xlsx", ".xls"],
};

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP PK header
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // OLE2/BIFF8 header

/**
 * Verifica se os primeiros bytes são uma assinatura XLS conhecida:
 * OLE2 (BIFF8/5), XLSX renomeado, ou BIFF2/3/4 legados.
 * BIFF2: 09 00 04 00, BIFF3: 09 02, BIFF4: 09 04
 */
function isValidXlsSignature(header: Buffer): boolean {
  if (header.slice(0, 4).equals(OLE2_MAGIC)) return true;  // BIFF8/5 (OLE2)
  if (header.slice(0, 4).equals(XLSX_MAGIC)) return true;  // XLSX renomeado
  // BIFF2 — byte 0 = 0x09, byte 1 = 0x00
  if (header[0] === 0x09 && header[1] === 0x00) return true;
  // BIFF3 — byte 0 = 0x09, byte 1 = 0x02
  if (header[0] === 0x09 && header[1] === 0x02) return true;
  // BIFF4 — byte 0 = 0x09, byte 1 = 0x04
  if (header[0] === 0x09 && header[1] === 0x04) return true;
  return false;
}

export function validateFileForSource(filePath: string, source: SourceKey, filename: string): void {
  const ext = path.extname(filename).toLowerCase();
  const allowed = ALLOWED_EXTENSIONS[source];
  if (!allowed.includes(ext)) {
    throw new ImportCentralError(
      "INVALID_EXTENSION",
      `Extensão "${ext}" não permitida para ${source}. Permitido: ${allowed.join(", ")}`,
    );
  }
  // Read first 8 bytes to check file signature
  let header: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);
  } catch {
    throw new ImportCentralError("FILE_READ_ERROR", "Não foi possível ler o arquivo enviado.");
  }

  if (ext === ".xlsx" && !header.slice(0, 4).equals(XLSX_MAGIC)) {
    throw new ImportCentralError(
      "INVALID_FILE_MAGIC",
      "O arquivo não parece ser um XLSX válido (assinatura ZIP não encontrada).",
    );
  }
  if (ext === ".xls" && !isValidXlsSignature(header)) {
    throw new ImportCentralError(
      "INVALID_FILE_MAGIC",
      "O arquivo não parece ser um XLS válido (assinatura OLE2, XLSX ou BIFF2/3/4 não encontrada).",
    );
  }
  if (ext === ".csv") {
    // CSV should start with printable ASCII or UTF-8/Latin1 text
    if (header[0] === 0x00 || header[0] === 0xd0) {
      throw new ImportCentralError("INVALID_FILE_MAGIC", "CSV inválido — parece ser um arquivo binário.");
    }
  }
}

// ---------------------------------------------------------------------------
// Utilitários internos
// ---------------------------------------------------------------------------

export function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Parser monetário: aceita BR (1.400,00) e US (1,400.00) sem confundir. Zero preservado. */
export function parseCostBR(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return isNaN(raw) ? null : raw;
  const s = String(raw)
    .replace(/[R$\s]/g, "")
    .trim();
  if (!s) return null;
  const hasDot   = s.includes(".");
  const hasComma = s.includes(",");
  let normalized: string;
  if (hasDot && hasComma) {
    normalized =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")  // BR: 1.400,00
        : s.replace(/,/g, "");                    // US: 1,400.00
  } else if (hasComma && !hasDot) {
    // Distinguish BR decimal (1.400,00 → but no dot here) vs US thousands (1,400).
    // Rule: if every comma-group after the first has exactly 3 digits → thousands separator.
    const parts = s.split(",");
    const allThousands = parts.length > 1 && parts.slice(1).every((p) => /^\d{3}$/.test(p));
    normalized = allThousands ? s.replace(/,/g, "") : s.replace(",", ".");
  } else {
    // Only dots: if every dot-group after the first has exactly 3 digits → thousands separator.
    const dotParts = s.split(".");
    const allThousandsDot = dotParts.length > 1 && dotParts.slice(1).every((p) => /^\d{3}$/.test(p));
    normalized = allThousandsDot ? s.replace(/\./g, "") : s;
  }
  const v = parseFloat(normalized);
  return isNaN(v) ? null : v;
}

function normalizeImei(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).replace(/'/g, "").replace(/\D/g, "").trim();
  return s.length >= 10 ? s : null;
}

function normalizeOs(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).replace(/\D/g, "").trim();
  return s.length > 0 ? s : null;
}

function colIdx(headers: string[], ...aliases: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const hn = normalizeHeader(headers[i]);
    if (aliases.some((a) => normalizeHeader(a) === hn)) return i;
  }
  return -1;
}

function cellStr(row: unknown[], idx: number): string | null {
  if (idx < 0 || idx >= row.length) return null;
  const v = row[idx];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function xlsxDateToISO(serial: unknown): string | null {
  if (serial === null || serial === undefined || serial === "") return null;
  const n = Number(serial);
  if (!isNaN(n) && n > 0) {
    try {
      const d = XLSX.SSF.parse_date_code(n);
      if (d) {
        const mo = String(d.m).padStart(2, "0");
        const dy = String(d.d).padStart(2, "0");
        return `${d.y}-${mo}-${dy}`;
      }
    } catch { /* fall through */ }
  }
  const s = String(serial).trim();
  return s.length > 0 ? s : null;
}

function row_get(row: unknown[], idx: number): unknown {
  return idx >= 0 && idx < row.length ? row[idx] : null;
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

function withTx<T>(db: Db, fn: () => T): T {
  db.prepare("BEGIN").run();
  try {
    const result = fn();
    db.prepare("COMMIT").run();
    return result;
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw err;
  }
}

async function withTxAsync<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  db.prepare("BEGIN").run();
  try {
    const result = await fn();
    db.prepare("COMMIT").run();
    return result;
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Persist issues to central_import_issues
// ---------------------------------------------------------------------------

export function persistIssues(
  db: Db,
  source: SourceKey,
  importId: number,
  issues: ImportIssueRaw[],
): void {
  if (issues.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO central_import_issues (source, import_id, row_number, severity, code, message, raw_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const issue of issues) {
    insert.run(source, importId, issue.row ?? null, issue.severity, issue.code, issue.message, issue.rawValue ?? null);
  }
}

// ---------------------------------------------------------------------------
// Staging — DB-backed
// ---------------------------------------------------------------------------

const SOURCE_IMPORT_TABLES: Record<SourceKey, string> = {
  his:            "his_imports",
  "rel-seriais":  "rel_seriais_imports",
  "analise-mi":   "analise_mi_imports",
  pedidos:        "pedidos_imports",
  bkp:            "bkp_imports",
  "triagem-saida":"triagem_saida_imports",
  sh:             "sh_os_imports",
  peacs:          "peacs_imports",
  demonstrativo:  "demonstrativo_imports",
};

export function createStaging(
  db: Db,
  source: SourceKey,
  filename: string,
  fileHash: string,
  stagedPath: string,
  fileSize: number,
  userId: number | null,
): number {
  const r = db
    .prepare(
      `INSERT INTO import_staged_files
         (source, filename, file_hash, staged_path, file_size, status, created_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, 'UPLOADED', ?, datetime('now','+4 hours'))`,
    )
    .run(source, filename, fileHash, stagedPath, fileSize, userId);
  return Number(r.lastInsertRowid);
}

export function setStagingPreviewReady(db: Db, stagingId: number, previewJson: string): void {
  db.prepare(
    `UPDATE import_staged_files SET status='PREVIEW_READY', preview_json=? WHERE id=?`,
  ).run(previewJson, stagingId);
}

export function setStagingFailed(db: Db, stagingId: number, error: string): void {
  db.prepare(
    `UPDATE import_staged_files SET status='FAILED', error=? WHERE id=?`,
  ).run(error, stagingId);
}

export function getStagedFile(
  db: Db,
  stagingId: number,
): {
  source: string;
  filename: string;
  fileHash: string;
  stagedPath: string;
  status: StagingStatus;
  previewJson: string | null;
} | null {
  const row = db
    .prepare(
      `SELECT source, filename, file_hash, staged_path, status, preview_json
       FROM import_staged_files WHERE id=?`,
    )
    .get(stagingId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    source:     row["source"]      as string,
    filename:   row["filename"]    as string,
    fileHash:   row["file_hash"]   as string,
    stagedPath: row["staged_path"] as string,
    status:     row["status"]      as StagingStatus,
    previewJson:(row["preview_json"] as string | null) ?? null,
  };
}

export function confirmStaging(db: Db, stagingId: number, importId: number): void {
  db.prepare(
    `UPDATE import_staged_files
     SET status='CONFIRMED', confirmed_at=datetime('now'), import_id_created=?
     WHERE id=?`,
  ).run(importId, stagingId);
}

export function cancelStaging(db: Db, stagingId: number): { stagedPath: string | null } {
  const row = db
    .prepare(`SELECT staged_path, status FROM import_staged_files WHERE id=?`)
    .get(stagingId) as { staged_path: string; status: string } | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (row.status === "CONFIRMED")
    throw new ImportCentralError("ALREADY_CONFIRMED", "Não é possível cancelar: importação já confirmada.");
  db.prepare(`UPDATE import_staged_files SET status='CANCELLED' WHERE id=?`).run(stagingId);
  return { stagedPath: row.staged_path };
}

export function expireOldStagings(db: Db): string[] {
  const expired = db
    .prepare(
      `SELECT staged_path FROM import_staged_files
       WHERE status IN ('UPLOADED','PREVIEW_READY') AND expires_at < datetime('now')`,
    )
    .all() as { staged_path: string }[];
  if (expired.length > 0) {
    db.prepare(
      `UPDATE import_staged_files SET status='EXPIRED'
       WHERE status IN ('UPLOADED','PREVIEW_READY') AND expires_at < datetime('now')`,
    ).run();
  }
  return expired.map((r) => r.staged_path);
}

export function listStagingBySource(
  db: Db,
  source: SourceKey,
): {
  id: number;
  filename: string;
  fileHash: string;
  fileSize: number;
  status: StagingStatus;
  createdAt: string;
  expiresAt: string;
  previewJson: string | null;
}[] {
  return (
    db
      .prepare(
        `SELECT id, filename, file_hash, file_size, status, created_at, expires_at, preview_json
         FROM import_staged_files WHERE source=?
         AND status IN ('UPLOADED','PREVIEW_READY','FAILED')
         ORDER BY id DESC LIMIT 20`,
      )
      .all(source) as Record<string, unknown>[]
  ).map((r) => ({
    id:          r["id"]           as number,
    filename:    r["filename"]     as string,
    fileHash:    r["file_hash"]    as string,
    fileSize:    r["file_size"]    as number,
    status:      r["status"]       as StagingStatus,
    createdAt:   r["created_at"]   as string,
    expiresAt:   r["expires_at"]   as string,
    previewJson: (r["preview_json"] as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// getAllSourcesStatus
// ---------------------------------------------------------------------------

export function getAllSourcesStatus(db: Db): AllSourcesStatus {
  function statusFor(source: SourceKey): SourceStatus {
    const table = SOURCE_IMPORT_TABLES[source];
    try {
      const row = db
        .prepare(
          `SELECT id, created_at, status,
                  COALESCE(rows_found,0) AS rows_found,
                  COALESCE(issues_count,0) AS issues_count
           FROM ${table} WHERE status NOT IN ('FAILED','CANCELLED')
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as {
        id: number; created_at: string; status: string;
        rows_found: number; issues_count: number;
      } | undefined;
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      const pending = (
        db.prepare(
          `SELECT COUNT(*) AS c FROM import_staged_files WHERE source=? AND status IN ('UPLOADED','PREVIEW_READY')`,
        ).get(source) as { c: number }
      ).c;
      if (!row)
        return { lastImportId: null, lastImportAt: null, lastStatus: null, totalImports: total, lastRowsFound: 0, lastIssuesCount: 0, pendingStaging: pending };
      return {
        lastImportId: row.id, lastImportAt: row.created_at, lastStatus: row.status,
        totalImports: total, lastRowsFound: row.rows_found, lastIssuesCount: row.issues_count, pendingStaging: pending,
      };
    } catch {
      return { lastImportId: null, lastImportAt: null, lastStatus: null, totalImports: 0, lastRowsFound: 0, lastIssuesCount: 0, pendingStaging: 0 };
    }
  }
  return {
    his:            statusFor("his"),
    "rel-seriais":  statusFor("rel-seriais"),
    "analise-mi":   statusFor("analise-mi"),
    pedidos:        statusFor("pedidos"),
    bkp:            statusFor("bkp"),
    "triagem-saida":statusFor("triagem-saida"),
    sh:             statusFor("sh"),
    peacs:          statusFor("peacs"),
    demonstrativo:  statusFor("demonstrativo"),
  };
}

// ---------------------------------------------------------------------------
// getSourceHistory
// ---------------------------------------------------------------------------

export function getSourceHistory(db: Db, source: SourceKey): ImportHistoryEntry[] {
  const table = SOURCE_IMPORT_TABLES[source];
  const rows = db
    .prepare(
      `SELECT i.*, u.display_name AS created_by_name
       FROM ${table} i
       LEFT JOIN users u ON u.id = i.created_by_user_id
       ORDER BY i.id DESC LIMIT 50`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id:           r["id"]            as number,
    filename:     r["filename"]      as string,
    fileHash:     r["file_hash"]     as string,
    status:       r["status"]        as string,
    rowsFound:    ((r["rows_found"]   as number) ?? 0),
    rowsValid:    (r["rows_valid"]    as number | undefined) ?? undefined,
    issuesCount:  ((r["issues_count"] as number) ?? 0),
    createdAt:    r["created_at"]    as string,
    finishedAt:   (r["finished_at"]  as string | null) ?? null,
    createdByName:(r["created_by_name"] as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// cancelImport
// ---------------------------------------------------------------------------

export function cancelImport(db: Db, source: SourceKey, importId: number): void {
  const table = SOURCE_IMPORT_TABLES[source];
  const row = db.prepare(`SELECT id, status FROM ${table} WHERE id=?`).get(importId) as { id: number; status: string } | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row.status === "COMPLETED") throw new ImportCentralError("ALREADY_COMPLETED", "Não é possível cancelar importação concluída.");
  if (row.status === "CANCELLED") return;
  db.prepare(`UPDATE ${table} SET status='CANCELLED', finished_at=datetime('now') WHERE id=?`).run(importId);
}

// ---------------------------------------------------------------------------
// getLegadoStatus
// ---------------------------------------------------------------------------

export function getLegadoStatus(db: Db): {
  initialized: boolean;
  lastBatchId: number | null;
  lastBatchAt: string | null;
  ordersFound: number;
  inventoryFound: number;
} {
  const row = db
    .prepare(
      `SELECT id, started_at AS created_at, orders_found, inventory_found
       FROM import_batches WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; created_at: string; orders_found: number; inventory_found: number } | undefined;
  return {
    initialized:  !!row,
    lastBatchId:  row?.id ?? null,
    lastBatchAt:  row?.created_at ?? null,
    ordersFound:  row?.orders_found ?? 0,
    inventoryFound: row?.inventory_found ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Duplicate hash check
// ---------------------------------------------------------------------------

function checkDuplicateHash(db: Db, table: string, fileHash: string): number | null {
  const row = db
    .prepare(`SELECT id FROM ${table} WHERE file_hash=? AND status NOT IN ('FAILED','CANCELLED')`)
    .get(fileHash) as { id: number } | undefined;
  return row?.id ?? null;
}

// ===========================================================================
// CARD 1 — HIS ESTOQUE
// Streaming ZIP/XML — somente cols B, R, S, U — última ocorrência por IMEI
// ===========================================================================

export async function previewHis(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "his", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "his_imports", fileHash);
  const stagingId = createStaging(db, "his", filename, fileHash, filePath, fileSize, userId);

  try {
    const result = await streamHisEstoque(filePath);

    const { lastByImei, totalDataLines, warnings, sampleRows } = result;
    const consolidated = Array.from(lastByImei.values());
    const rowsValid = consolidated.length;

    const preview: StagedPreview = {
      stagingId,
      source: "his",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: totalDataLines,
      rowsValid,
      issues: warnings.slice(0, 100),
      previewRows: sampleRows.map((r) => ({
        imei:       r.imeiNorm,
        ageDays:    r.ageDays,
        cost:       r.cost,
        reportDate: r.reportDate,
        sourceLine: r.sourceLine,
      })),
      extra: {
        imeiUnique:           rowsValid,
        discardedOccurrences: totalDataLines - rowsValid,
        ageEmpty:             consolidated.filter((r) => r.ageDays === null).length,
        costEmpty:            consolidated.filter((r) => r.cost === null).length,
        dateWarnings:         warnings.filter((w) => w.code === "DATE_OUT_OF_ORDER").length,
      },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export async function confirmHis(
  db: Db,
  stagingId: number,
  userId: number | null,
): Promise<{ rowsInserted: number; rowsUpdated: number; rowsUnchanged: number; rowsLinked: number }> {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                     throw new ImportCentralError("NOT_FOUND",       "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",  "Arquivo temporário não encontrado. Faça upload novamente.");
  if (staged.source !== "his")      throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "his_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Este arquivo já foi importado.");

  const actualHash = hashFile(staged.stagedPath);
  if (actualHash !== staged.fileHash)
    throw new ImportCentralError("HASH_MISMATCH", "Hash do arquivo mudou. Faça upload novamente.");

  const { lastByImei, totalDataLines, warnings } = await streamHisEstoque(staged.stagedPath);
  const consolidated = Array.from(lastByImei.values());
  const preview = staged.previewJson ? (JSON.parse(staged.previewJson) as StagedPreview) : null;
  const rowsFound = preview?.rowsFound ?? totalDataLines;

  let syncResult = { inserted: 0, updated: 0, unchanged: 0 };

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO his_imports (filename, file_hash, status, rows_found, rows_linked, issues_count, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, 0, 0, ?)`,
      )
      .run(staged.filename, staged.fileHash, rowsFound, userId);
    const id = Number(importRow.lastInsertRowid);

    const syncRows: SyncRow[] = consolidated.map((r) => ({
      key:  r.imeiNorm,
      hash: rowHash(r.imeiNorm, r.cost, r.ageDays, r.reportDate),
      cols: {
        his_import_id: id,
        imei_raw:      r.imeiRaw ?? null,
        audited_cost:  r.cost    ?? null,
        age_days:      r.ageDays ?? null,
        report_date:   r.reportDate ?? null,
        source_line:   r.sourceLine ?? null,
      },
    }));

    syncResult = syncCurrentTable(db, {
      table:       "his_current",
      keyCol:      "imei_norm",
      importIdCol: "his_import_id",
      rows:        syncRows,
    });

    persistIssues(db, "his", id, warnings);

    db.prepare(
      `UPDATE his_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_found=?, rows_linked=0, issues_count=?,
         rows_inserted=?, rows_updated=?, rows_unchanged=? WHERE id=?`,
    ).run(rowsFound, warnings.length, syncResult.inserted, syncResult.updated, syncResult.unchanged, id);

    confirmStaging(db, stagingId, id);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return {
    rowsInserted:  syncResult.inserted,
    rowsUpdated:   syncResult.updated,
    rowsUnchanged: syncResult.unchanged,
    rowsLinked:    0,
  };
}

// ===========================================================================
// CARD 2 — REL SERIAIS
// CSV streaming, contar todas as linhas, guardar amostra
// ===========================================================================

interface CsvResult {
  headers: string[];
  sample: string[][];   // primeiras N linhas
  totalLines: number;   // total de linhas de dados (excluindo cabeçalho)
  totalValid: number;   // linhas com Serial válido
  totalInvalid: number;
}

async function readCsvFull(
  filePath: string,
  sampleSize = 20,
  validatorColName?: string,
): Promise<CsvResult> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "latin1" }),
      crlfDelay: Infinity,
    });
    let headers: string[] = [];
    const sample: string[][] = [];
    let lineNum = 0;
    let totalLines = 0;
    let totalValid = 0;
    let totalInvalid = 0;
    let validatorIdx = -1;
    let sep = ";";

    rl.on("line", (line) => {
      if (!line.trim()) return;
      if (lineNum === 0) {
        // Auto-detect separator
        sep = line.includes(";") ? ";" : ",";
        headers = line.split(sep).map((p) => p.trim());
        // Find validator column index (e.g. "Serial")
        if (validatorColName) {
          validatorIdx = colIdx(headers, validatorColName);
        }
        lineNum++;
        return;
      }
      const parts = line.split(sep).map((p) => p.trim());
      totalLines++;

      const isValid = validatorIdx < 0
        ? parts.some((p) => p.length > 0)
        : !!normalizeImei(parts[validatorIdx] ?? "");

      if (isValid) totalValid++;
      else totalInvalid++;

      if (sample.length < sampleSize) sample.push(parts);
      lineNum++;
    });

    rl.on("close", () => resolve({ headers, sample, totalLines, totalValid, totalInvalid }));
    rl.on("error", reject);
  });
}

export async function previewRelSeriais(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "rel-seriais", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "rel_seriais_imports", fileHash);
  const stagingId = createStaging(db, "rel-seriais", filename, fileHash, filePath, fileSize, userId);

  try {
    const csv = await readCsvFull(filePath, 20, "Serial");
    const { headers, sample, totalLines, totalValid, totalInvalid } = csv;

    const colSerial   = colIdx(headers, "Serial");
    const colProduto  = colIdx(headers, "Produto");
    const colDisponivel = colIdx(headers, "Disponivel", "Disponível");
    const colDeposito = colIdx(headers, "Deposito Atual", "Depósito Atual");
    const colFilialAtual = colIdx(headers, "Filial Atual");

    const issues: ImportIssueRaw[] = [];
    if (colSerial < 0) {
      throw new ImportCentralError("MISSING_SERIAL_COL", `Coluna "Serial" não encontrada. Colunas: ${headers.join(", ")}`);
    }

    const preview: StagedPreview = {
      stagingId,
      source: "rel-seriais",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: totalLines,
      rowsValid: totalValid,
      issues,
      previewRows: sample.slice(0, 5).map((row) => ({
        serial:    row[colSerial] ?? null,
        produto:   colProduto    >= 0 ? row[colProduto]    : null,
        deposito:  colDeposito   >= 0 ? row[colDeposito]   : null,
        filial:    colFilialAtual>= 0 ? row[colFilialAtual] : null,
        disponivel:colDisponivel >= 0 ? row[colDisponivel] : null,
      })),
      extra: {
        totalValid,
        totalInvalid,
        totalLines,
        colsFound: { serial: colSerial >= 0, produto: colProduto >= 0, deposito: colDeposito >= 0, filial: colFilialAtual >= 0 },
      },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export async function confirmRelSeriais(
  db: Db,
  stagingId: number,
  userId: number | null,
): Promise<{ rowsInserted: number; rowsUpdated: number; rowsUnchanged: number; reportScope: string }> {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                     throw new ImportCentralError("NOT_FOUND",       "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",  "Arquivo temporário não encontrado.");
  if (staged.source !== "rel-seriais")   throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "rel_seriais_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const csv = await readCsvFull(staged.stagedPath, 0);
  const { headers, totalLines } = csv;

  const colSerial       = colIdx(headers, "Serial");
  if (colSerial < 0) throw new ImportCentralError("MISSING_SERIAL_COL", 'Coluna "Serial" não encontrada.');
  const colDescricao    = colIdx(headers, "Descricao", "Descrição");
  const colCodComercial = colIdx(headers, "Codigo Comercial", "Código Comercial");
  const colFabricante   = colIdx(headers, "Fabricante");
  const colDisponivel   = colIdx(headers, "Disponivel", "Disponível");
  const colDeposito     = colIdx(headers, "Deposito Atual", "Depósito Atual");
  const colFilialAtual  = colIdx(headers, "Filial Atual");

  // Consolidar por imei_norm (SIM preferencial), detectar report_scope
  type RsRow = {
    imeiNorm: string;
    serial: string;
    descricao: string | null;
    codComercial: string | null;
    fabricante: string | null;
    disponivel: string | null;
    deposito: string | null;
    filial: string | null;
  };

  const byImei = new Map<string, RsRow>();
  let hasSim = false;
  let hasNonSim = false;
  let validLines = 0;

  await new Promise<void>((res, rej) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(staged.stagedPath, { encoding: "latin1" }),
      crlfDelay: Infinity,
    });
    let first = true;
    const sep = ";";
    rl.on("line", (line) => {
      if (!line.trim()) return;
      if (first) { first = false; return; }
      const row = line.split(sep).map((p) => p.trim());
      const serial = row[colSerial] ?? "";
      const imeiNorm = normalizeImei(serial);
      if (!imeiNorm) return;
      validLines++;
      const disp = colDisponivel >= 0 ? (row[colDisponivel] ?? null) : null;
      const isSim = disp != null && disp.toUpperCase() === "SIM";
      if (isSim) hasSim = true; else hasNonSim = true;
      const candidate: RsRow = {
        imeiNorm,
        serial: String(serial).replace(/'/g, ""),
        descricao:    colDescricao    >= 0 ? row[colDescricao]    ?? null : null,
        codComercial: colCodComercial >= 0 ? row[colCodComercial] ?? null : null,
        fabricante:   colFabricante   >= 0 ? row[colFabricante]   ?? null : null,
        disponivel:   disp,
        deposito:     colDeposito     >= 0 ? row[colDeposito]     ?? null : null,
        filial:       colFilialAtual  >= 0 ? row[colFilialAtual]  ?? null : null,
      };
      const existing = byImei.get(imeiNorm);
      if (!existing || (!isSim && existing.disponivel?.toUpperCase() !== "SIM")) {
        // Substituir: preferir SIM; entre iguais, última linha vence
        if (!existing || isSim || !existing.disponivel || existing.disponivel.toUpperCase() !== "SIM") {
          byImei.set(imeiNorm, candidate);
        }
      }
    });
    rl.on("close", res);
    rl.on("error", rej);
  });

  const reportScope =
    colDisponivel < 0 ? "UNKNOWN" :
    hasSim && hasNonSim ? "ALL" :
    hasSim ? "IN_STOCK" : "UNKNOWN";

  const invalidCount = totalLines - validLines;
  let syncResult = { inserted: 0, updated: 0, unchanged: 0 };

  await withTxAsync(db, async () => {
    const importRow = db
      .prepare(
        `INSERT INTO rel_seriais_imports (filename, file_hash, status, rows_found, rows_valid, issues_count, report_scope, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, 0, 0, ?, ?)`,
      )
      .run(staged.filename, staged.fileHash, totalLines, reportScope, userId);
    const importId = Number(importRow.lastInsertRowid);

    const syncRows: SyncRow[] = Array.from(byImei.values()).map((r) => ({
      key:  r.imeiNorm,
      hash: rowHash(r.descricao, r.codComercial, r.fabricante, r.disponivel, r.deposito, r.filial),
      cols: {
        rel_seriais_import_id: importId,
        serial:           r.serial,
        descricao:        r.descricao,
        codigo_comercial: r.codComercial,
        fabricante:       r.fabricante,
        disponivel:       r.disponivel,
        deposito_atual:   r.deposito,
        filial_atual:     r.filial,
      },
    }));

    syncResult = syncCurrentTable(db, {
      table:       "rel_seriais_current",
      keyCol:      "imei_norm",
      importIdCol: "rel_seriais_import_id",
      rows:        syncRows,
    });

    const relIssues: ImportIssueRaw[] = [];
    if (invalidCount > 0) {
      relIssues.push({ row: null, severity: "WARNING", code: "INVALID_SERIAL", message: `${invalidCount} linha(s) com Serial inválido ignoradas.` });
    }
    persistIssues(db, "rel-seriais", importId, relIssues);
    db.prepare(
      `UPDATE rel_seriais_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_valid=?, issues_count=?,
         rows_inserted=?, rows_updated=?, rows_unchanged=? WHERE id=?`,
    ).run(syncResult.inserted + syncResult.updated + syncResult.unchanged, relIssues.length,
          syncResult.inserted, syncResult.updated, syncResult.unchanged, importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return {
    rowsInserted:  syncResult.inserted,
    rowsUpdated:   syncResult.updated,
    rowsUnchanged: syncResult.unchanged,
    reportScope,
  };
}

// ===========================================================================
// CARD 3 — ANALISE MI
// ===========================================================================

export async function previewAnaliseMi(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "analise-mi", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "analise_mi_imports", fileHash);
  const stagingId = createStaging(db, "analise-mi", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    const targetSheet =
      allSheets.find((n) => normalizeHeader(n) === "ANALISEMI") ??
      allSheets.find((n) => normalizeHeader(n) === "ANALISE") ??
      null;
    if (!targetSheet)
      throw new ImportCentralError("SHEET_NOT_FOUND", `Aba ANALISEMI não encontrada. Abas: ${allSheets.join(", ")}`);

    const wb = XLSX.readFile(filePath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
    const ws = wb.Sheets[targetSheet];
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (rawRows.length === 0) throw new ImportCentralError("EMPTY_SHEET", "Aba vazia.");

    const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cIdPedido = colIdx(headers, "ID PEDIDO", "IDPEDIDO");
    const cImei     = colIdx(headers, "IMEI");
    const cStatus   = colIdx(headers, "STATUS");
    const cPeca     = colIdx(headers, "PEÇASOLICITADA", "PECA SOLICITADA", "PECASOLICITADA");
    if (cIdPedido < 0)
      throw new ImportCentralError("MISSING_COL", `Coluna "ID PEDIDO" não encontrada.`);

    const issues: ImportIssueRaw[] = [];
    const statusCounts: Record<string, number> = {};
    let rowsValid = 0; let noId = 0; let noImei = 0; let duplicateIds = 0;
    const seenIds = new Set<string>();

    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i] as unknown[];
      if (!row || row.every((c) => c === null)) continue;
      const idPedido = cellStr(row, cIdPedido);
      if (!idPedido) { noId++; continue; }
      const imei = cellStr(row, cImei);
      if (!imei || !normalizeImei(imei)) noImei++;
      const status = cellStr(row, cStatus);
      if (status) statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (seenIds.has(idPedido)) duplicateIds++;
      else seenIds.add(idPedido);
      rowsValid++;
    }

    if (noId > 0)   issues.push({ row: null, severity: "WARNING", code: "NO_ID_PEDIDO", message: `${noId} linha(s) sem ID PEDIDO ignoradas.` });
    if (noImei > 0) issues.push({ row: null, severity: "INFO",    code: "NO_IMEI",      message: `${noImei} linha(s) sem IMEI válido.` });

    const preview: StagedPreview = {
      stagingId, source: "analise-mi", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: rawRows.length - 1, rowsValid, issues,
      previewRows: rawRows.slice(1, 6).map((row) => ({
        idPedido: cellStr(row as unknown[], cIdPedido),
        imei:     cImei   >= 0 ? cellStr(row as unknown[], cImei)   : null,
        status:   cStatus >= 0 ? cellStr(row as unknown[], cStatus) : null,
        peca:     cPeca   >= 0 ? cellStr(row as unknown[], cPeca)   : null,
      })),
      extra: { sheetUsed: targetSheet, statusCounts, duplicateIds, noId, noImei },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmAnaliseMi(
  db: Db,
  stagingId: number,
  userId: number | null,
): { rowsInserted: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                     throw new ImportCentralError("NOT_FOUND",        "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY",  "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",  "Arquivo temporário não encontrado.");
  if (staged.source !== "analise-mi")    throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "analise_mi_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const targetSheet =
    allSheets.find((n) => normalizeHeader(n) === "ANALISEMI") ??
    allSheets.find((n) => normalizeHeader(n) === "ANALISE") ??
    null;
  if (!targetSheet) throw new ImportCentralError("SHEET_NOT_FOUND", "Aba ANALISEMI não encontrada.");

  const wb = XLSX.readFile(staged.stagedPath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
  const ws = wb.Sheets[targetSheet];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));

  const cIdPedido   = colIdx(headers, "ID PEDIDO", "IDPEDIDO");
  const cImei       = colIdx(headers, "IMEI");
  const cOs         = colIdx(headers, "OS");
  const cMarca      = colIdx(headers, "MARCA");
  const cModelo     = colIdx(headers, "MODELO");
  const cCor        = colIdx(headers, "COR");
  const cPeca       = colIdx(headers, "PEÇASOLICITADA", "PECA SOLICITADA", "PECASOLICITADA");
  const cCorPeca    = colIdx(headers, "CORNAPEÇA", "COR NA PECA");
  const cConcat     = colIdx(headers, "CONCATPEÇA", "CONCATPECA");
  const cDataPedido = colIdx(headers, "DATAPEDIDO", "DATA PEDIDO");
  const cStatus     = colIdx(headers, "STATUS");
  const cDeposito   = colIdx(headers, "DEPÓSITO", "DEPOSITO");
  const cDescricao  = colIdx(headers, "DESCRIÇÃO", "DESCRICAO");
  const cRef        = colIdx(headers, "REF");
  const cSolicitante= colIdx(headers, "SOLICITANTE");

  if (cIdPedido < 0) throw new ImportCentralError("MISSING_COL", "Coluna ID PEDIDO não encontrada.");

  let rowsInserted = 0;

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO analise_mi_imports (filename, file_hash, status, rows_found, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, ?)`,
      )
      .run(staged.filename, staged.fileHash, rawRows.length - 1, userId);
    const importId = Number(importRow.lastInsertRowid);

    const insertRow = db.prepare(
      `INSERT INTO analise_mi_rows
         (analise_mi_import_id, id_pedido, imei, imei_norm, os,
          brand, model, color, peca_solicitada, cor_na_peca,
          concat_peca, data_pedido, status_src, deposito_src,
          descricao, ref_peca, solicitante, raw_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i] as unknown[];
      if (!row || row.every((c) => c === null)) continue;
      const idPedido = cellStr(row, cIdPedido);
      if (!idPedido) continue;
      const imeiRaw  = cImei >= 0 ? cellStr(row, cImei) : null;
      const imeiNorm = normalizeImei(imeiRaw);
      insertRow.run(
        importId, idPedido,
        imeiRaw, imeiNorm,
        cOs        >= 0 ? cellStr(row, cOs)        : null,
        cMarca     >= 0 ? cellStr(row, cMarca)     : null,
        cModelo    >= 0 ? cellStr(row, cModelo)    : null,
        cCor       >= 0 ? cellStr(row, cCor)       : null,
        cPeca      >= 0 ? cellStr(row, cPeca)      : null,
        cCorPeca   >= 0 ? cellStr(row, cCorPeca)   : null,
        cConcat    >= 0 ? cellStr(row, cConcat)    : null,
        xlsxDateToISO(cDataPedido >= 0 ? row[cDataPedido] : null),
        cStatus    >= 0 ? cellStr(row, cStatus)    : null,
        cDeposito  >= 0 ? cellStr(row, cDeposito)  : null,
        cDescricao >= 0 ? cellStr(row, cDescricao) : null,
        cRef       >= 0 ? cellStr(row, cRef)       : null,
        cSolicitante >= 0 ? cellStr(row, cSolicitante) : null,
        null,
      );
      rowsInserted++;
    }

    const amiIssues: ImportIssueRaw[] = [];
    let amiNoId = 0; let amiNoImei = 0;
    for (let i = 1; i < rawRows.length; i++) {
      const row2 = rawRows[i] as unknown[];
      if (!row2 || row2.every((c) => c === null)) continue;
      if (cIdPedido >= 0 && !cellStr(row2, cIdPedido)) { amiNoId++; continue; }
      if (cImei >= 0 && !normalizeImei(cellStr(row2, cImei))) amiNoImei++;
    }
    if (amiNoId > 0)   amiIssues.push({ row: null, severity: "WARNING", code: "NO_ID_PEDIDO", message: `${amiNoId} linha(s) sem ID PEDIDO ignoradas.` });
    if (amiNoImei > 0) amiIssues.push({ row: null, severity: "INFO",    code: "NO_IMEI",      message: `${amiNoImei} linha(s) sem IMEI válido.` });
    persistIssues(db, "analise-mi", importId, amiIssues);
    db.prepare(
      `UPDATE analise_mi_imports SET status='COMPLETED', finished_at=datetime('now'), rows_valid=?, issues_count=? WHERE id=?`,
    ).run(rowsInserted, amiIssues.length, importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return { rowsInserted };
}

// ===========================================================================
// CARD 4 — PEDIDOS (3 abas)
// ===========================================================================

export async function previewPedidos(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "pedidos", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "pedidos_imports", fileHash);
  const stagingId = createStaging(db, "pedidos", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];

    const sheetPedidos = allSheets.find((n) => normalizeHeader(n) === "PEDIDOS");
    const sheetBipagem = allSheets.find((n) => normalizeHeader(n).startsWith("BIPAGEM"));
    const sheetPeacs   = allSheets.find((n) =>
      normalizeHeader(n).includes("AVALIA") && normalizeHeader(n).includes("PEACS"),
    ) ?? allSheets.find((n) => normalizeHeader(n).includes("PEACS"));

    if (!sheetPedidos) throw new ImportCentralError("SHEET_NOT_FOUND", `Aba PEDIDOS não encontrada. Abas: ${allSheets.join(", ")}`);
    if (!sheetBipagem) throw new ImportCentralError("SHEET_NOT_FOUND", `Aba "BIPAGEM DE PEÇAS" não encontrada.`);

    const sheetsToLoad = [sheetPedidos, sheetBipagem, ...(sheetPeacs ? [sheetPeacs] : [])];
    const wb = XLSX.readFile(filePath, { sheets: sheetsToLoad, cellFormula: false, cellHTML: false });

    const wsPed = wb.Sheets[sheetPedidos];
    const rowsPed: unknown[][] = XLSX.utils.sheet_to_json(wsPed, { header: 1, defval: null });
    const hdrPed = (rowsPed[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cPedId = colIdx(hdrPed, "ID PEDIDO");
    const pedidosFound = rowsPed.length - 1;
    let pedidosValid = 0;
    for (let i = 1; i < rowsPed.length; i++) {
      const r = rowsPed[i] as unknown[];
      if (r && cPedId >= 0 && cellStr(r, cPedId)) pedidosValid++;
    }

    const wsBip = wb.Sheets[sheetBipagem];
    const rowsBip: unknown[][] = XLSX.utils.sheet_to_json(wsBip, { header: 1, defval: null });
    const hdrBip = (rowsBip[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cBipRef = colIdx(hdrBip, "REFERENCIA", "REFERÊNCIA");
    const bipRows = rowsBip.length - 1;
    const bipRefs = new Set<string>();
    for (let i = 1; i < rowsBip.length; i++) {
      const r = rowsBip[i] as unknown[];
      if (r && cBipRef >= 0) { const ref = cellStr(r, cBipRef); if (ref) bipRefs.add(ref); }
    }

    let peacsFound = 0; let peacsValid = 0; let peacsDuplicates = 0; let peacsCapMismatch = 0;
    if (sheetPeacs && wb.Sheets[sheetPeacs]) {
      const wsPeacs = wb.Sheets[sheetPeacs];
      const rowsPeacs: unknown[][] = XLSX.utils.sheet_to_json(wsPeacs, { header: 1, defval: null });
      const hdrPeacs = (rowsPeacs[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cPrice       = colIdx(hdrPeacs, "TABELA SEMINOVO PRAZO");
      const cMarcaModelo = colIdx(hdrPeacs, "MARCA/MODELO");
      const cMemoria     = colIdx(hdrPeacs, "MEMÓRIA", "MEMORIA");
      peacsFound = rowsPeacs.length - 1;
      const seenNorms = new Set<string>();
      for (let i = 1; i < rowsPeacs.length; i++) {
        const r = rowsPeacs[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const mm = cMarcaModelo >= 0 ? cellStr(r, cMarcaModelo) : null;
        if (!mm) continue;
        if (cPrice >= 0 && parseCostBR(row_get(r, cPrice)) !== null) {
          const norm = normalizeKey(mm);
          if (seenNorms.has(norm)) peacsDuplicates++;
          else { seenNorms.add(norm); peacsValid++; }
          const mem = cMemoria >= 0 ? cellStr(r, cMemoria) : null;
          if (mem && !normalizeKey(mm).includes(normalizeKey(mem))) peacsCapMismatch++;
        }
      }
    }

    const issues: ImportIssueRaw[] = [];
    if (!sheetPeacs) issues.push({ row: null, severity: "WARNING", code: "NO_PEACS_SHEET", message: "Aba PEACS não encontrada — catálogo não será importado." });

    const preview: StagedPreview = {
      stagingId, source: "pedidos", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: pedidosFound + bipRows + peacsFound,
      rowsValid: pedidosValid + bipRows + peacsValid,
      issues, previewRows: [],
      extra: {
        sheetsFound: { pedidos: sheetPedidos, bipagem: sheetBipagem, peacs: sheetPeacs ?? null },
        pedidosRows: pedidosFound, pedidosValid,
        bipagemRows: bipRows, bipagemRefsUnique: bipRefs.size,
        peacsRows: peacsFound, peacsValid, peacsDuplicates, peacsCapMismatch,
      },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmPedidos(
  db: Db,
  stagingId: number,
  userId: number | null,
): { pedidosInserted: number; bipagemInserted: number; peacsInserted: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                     throw new ImportCentralError("NOT_FOUND",        "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY",  "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",  "Arquivo temporário não encontrado.");
  if (staged.source !== "pedidos")       throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "pedidos_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const sheetPedidos = allSheets.find((n) => normalizeHeader(n) === "PEDIDOS")!;
  const sheetBipagem = allSheets.find((n) => normalizeHeader(n).startsWith("BIPAGEM"))!;
  const sheetPeacs   = allSheets.find((n) =>
    normalizeHeader(n).includes("AVALIA") && normalizeHeader(n).includes("PEACS"),
  ) ?? allSheets.find((n) => normalizeHeader(n).includes("PEACS"));

  const sheetsToLoad = [sheetPedidos, sheetBipagem, ...(sheetPeacs ? [sheetPeacs] : [])];
  const wb = XLSX.readFile(staged.stagedPath, { sheets: sheetsToLoad, cellFormula: false, cellHTML: false });

  const wsPed  = wb.Sheets[sheetPedidos];
  const rowsPed: unknown[][] = XLSX.utils.sheet_to_json(wsPed, { header: 1, defval: null });
  const wsBip  = wb.Sheets[sheetBipagem];
  const rowsBip: unknown[][] = XLSX.utils.sheet_to_json(wsBip, { header: 1, defval: null });
  let peacsRows: unknown[][] = [];
  if (sheetPeacs && wb.Sheets[sheetPeacs]) {
    peacsRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetPeacs], { header: 1, defval: null });
  }

  let pedidosInserted = 0;
  let bipagemInserted = 0;
  let peacsInserted   = 0;

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO pedidos_imports
           (filename, file_hash, status, pedidos_rows_found, bipagem_rows_found, bipagem_refs_unique, peacs_rows_found, issues_count, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, ?, 0, ?, 0, ?)`,
      )
      .run(staged.filename, staged.fileHash, rowsPed.length - 1, rowsBip.length - 1, peacsRows.length - 1, userId);
    const importId = Number(importRow.lastInsertRowid);

    // PEDIDOS
    const hdrPed  = (rowsPed[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cPedId  = colIdx(hdrPed, "ID PEDIDO");
    const cPedImei= colIdx(hdrPed, "IMEI");
    const cPedOs  = colIdx(hdrPed, "OS");
    const cPedStatus = colIdx(hdrPed, "STATUS");
    const cPedRef = colIdx(hdrPed, "REFPEÇA", "REFPECA");
    const cPedChave = colIdx(hdrPed, "CHAVEPEÇA", "CHAVEPECA");

    const insertPedRow = db.prepare(
      `INSERT INTO pedidos_reconciliation_rows
         (pedidos_import_id, id_pedido, imei, imei_norm, os, status_src, chave_peca, ref_peca)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i < rowsPed.length; i++) {
      const r = rowsPed[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const idPedido = cPedId >= 0 ? cellStr(r, cPedId) : null;
      if (!idPedido) continue;
      insertPedRow.run(
        importId, idPedido,
        cPedImei >= 0 ? cellStr(r, cPedImei) : null,
        normalizeImei(cPedImei >= 0 ? cellStr(r, cPedImei) : null),
        cPedOs   >= 0 ? cellStr(r, cPedOs)  : null,
        cPedStatus >= 0 ? cellStr(r, cPedStatus) : null,
        cPedChave  >= 0 ? cellStr(r, cPedChave)  : null,
        cPedRef    >= 0 ? cellStr(r, cPedRef)    : null,
      );
      pedidosInserted++;
    }

    // BIPAGEM
    const hdrBip  = (rowsBip[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cRef    = colIdx(hdrBip, "REFERENCIA", "REFERÊNCIA");
    const cDesc   = colIdx(hdrBip, "DESCRIÇÃO", "DESCRICAO");
    const cForn   = colIdx(hdrBip, "FORNECEDOR");
    const cChave  = colIdx(hdrBip, "CHAVEPECA", "CHAVE PECA");
    const cBipStatus = colIdx(hdrBip, "STATUS");
    const cArrumar= colIdx(hdrBip, "ARRUMAR");
    const cIdPeca = colIdx(hdrBip, "ID_PECA_ESTOQUE", "IDPECAESTOQUE");
    const bipRefs2 = new Set<string>();

    const insertBip = db.prepare(
      `INSERT INTO pedidos_bipagem_rows
         (pedidos_import_id, referencia, referencia_corr, descricao, fornecedor, chave_peca, chave_peca_norm, status_src, id_peca_estoque)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i < rowsBip.length; i++) {
      const r = rowsBip[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const ref    = cRef    >= 0 ? cellStr(r, cRef)    : null;
      const arrumar= cArrumar>= 0 ? cellStr(r, cArrumar): null;
      const chave  = cChave  >= 0 ? cellStr(r, cChave)  : null;
      if (ref) bipRefs2.add(ref);
      insertBip.run(
        importId, ref,
        arrumar && arrumar !== ref ? arrumar : ref,
        cDesc  >= 0 ? cellStr(r, cDesc) : null,
        cForn  >= 0 ? cellStr(r, cForn) : null,
        chave,
        chave ? normalizeKey(chave) : null,
        cBipStatus >= 0 ? cellStr(r, cBipStatus) : null,
        cIdPeca >= 0 ? cellStr(r, cIdPeca) : null,
      );
      bipagemInserted++;
    }
    db.prepare(`UPDATE pedidos_imports SET bipagem_refs_unique=? WHERE id=?`).run(bipRefs2.size, importId);

    // PEACS — atomic swap; chave por MARCA/MODELO normalizado
    if (sheetPeacs && peacsRows.length > 1) {
      const hdrPeacs   = (peacsRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cMarcaModelo = colIdx(hdrPeacs, "MARCA/MODELO");
      const cMarca     = colIdx(hdrPeacs, "MARCA");
      const cFamilia   = colIdx(hdrPeacs, "FAMÍLIA", "FAMILIA");
      const cMemoria   = colIdx(hdrPeacs, "MEMÓRIA", "MEMORIA");
      const cPreco     = colIdx(hdrPeacs, "TABELA SEMINOVO PRAZO");
      if (cPreco < 0) throw new ImportCentralError("MISSING_COL", `Coluna "TABELA SEMINOVO PRAZO" não encontrada.`);
      if (cMarcaModelo < 0) throw new ImportCentralError("MISSING_COL", `Coluna "MARCA/MODELO" não encontrada na aba PEACS.`);

      const peacsImportRow = db.prepare(
        `INSERT INTO peacs_imports (filename, file_hash, status, rows_found, entries_matched, entries_unmatched, issues_count, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, 0, 0, 0, ?)`,
      ).run(staged.filename, staged.fileHash + "_peacs", peacsRows.length - 1, userId);
      const peacsImportId = Number(peacsImportRow.lastInsertRowid);

      db.prepare(`UPDATE peacs_catalog SET active=0 WHERE active=1`).run();

      const insertPeacs = db.prepare(
        `INSERT INTO peacs_catalog
           (peacs_import_id, brand, brand_norm, model, model_norm, capacity, capacity_norm,
            marca_modelo, marca_modelo_norm, familia, memoria_src,
            estimated_sale, raw_data_json, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
      );

      const peacsIssues: ImportIssueRaw[] = [];
      // Dedup by marca_modelo_norm — última ocorrência física vence
      const seenMarcaModelo = new Map<string, { rowIdx: number }>();

      for (let i = 1; i < peacsRows.length; i++) {
        const r = peacsRows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const marcaModelo = cMarcaModelo >= 0 ? cellStr(r, cMarcaModelo) : null;
        if (!marcaModelo) continue;
        const preco = parseCostBR(cPreco >= 0 ? r[cPreco] : null);
        if (preco === null) continue;
        const norm = normalizeKey(marcaModelo);
        if (seenMarcaModelo.has(norm)) {
          const prev = seenMarcaModelo.get(norm)!;
          peacsIssues.push({
            row: i + 1, severity: "WARNING", code: "PEACS_DUPLICATE_MARCA_MODELO",
            message: `MARCA/MODELO duplicado "${marcaModelo}": linha ${prev.rowIdx + 1} substituída pela linha ${i + 1}.`,
          });
        }
        seenMarcaModelo.set(norm, { rowIdx: i });
      }

      for (const [norm, { rowIdx }] of seenMarcaModelo) {
        const r = peacsRows[rowIdx] as unknown[];
        const marcaModelo = cellStr(r, cMarcaModelo)!;
        const marca   = cMarca   >= 0 ? cellStr(r, cMarca)   : null;
        const familia = cFamilia >= 0 ? cellStr(r, cFamilia) : null;
        const memoria = cMemoria >= 0 ? cellStr(r, cMemoria) : null;
        const preco   = parseCostBR(r[cPreco])!;

        // Detecta divergência entre capacidade em MARCA/MODELO e coluna MEMÓRIA
        if (memoria) {
          const normMm = normalizeKey(marcaModelo);
          const normMem = normalizeKey(memoria);
          if (!normMm.includes(normMem)) {
            peacsIssues.push({
              row: rowIdx + 1, severity: "WARNING", code: "PEACS_CAPACITY_MISMATCH",
              message: `Divergência capacidade: MARCA/MODELO="${marcaModelo}" mas MEMÓRIA="${memoria}". Preservados ambos.`,
              rawValue: `mm="${marcaModelo}" mem="${memoria}"`,
            });
          }
        }

        // model auxiliar (familia + memoria) para backward compat
        const model = [familia, memoria].filter(Boolean).join(" ");
        insertPeacs.run(
          peacsImportId,
          marca ?? marcaModelo, marca ? normalizeKey(marca) : norm,
          model || marcaModelo, normalizeKey(model || marcaModelo),
          memoria, memoria ? normalizeKey(memoria) : null,
          marcaModelo, norm,
          familia, memoria,
          preco,
          JSON.stringify({ marcaModelo }),
        );
        peacsInserted++;
      }

      persistIssues(db, "pedidos", peacsImportId, peacsIssues);
      db.prepare(`UPDATE peacs_imports SET status='COMPLETED', finished_at=datetime('now'), entries_matched=?, issues_count=? WHERE id=?`)
        .run(peacsInserted, peacsIssues.length, peacsImportId);
      db.prepare(`UPDATE pedidos_imports SET peacs_rows_found=? WHERE id=?`).run(peacsRows.length - 1, importId);
    }

    // Issues gerais dos pedidos
    const pedIssues: ImportIssueRaw[] = [];
    const hdrPedCheck = (rowsPed[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cPedIdCheck = colIdx(hdrPedCheck, "ID PEDIDO");
    let pedNoId = 0; let pedNoImei = 0;
    for (let i = 1; i < rowsPed.length; i++) {
      const r2 = rowsPed[i] as unknown[];
      if (!r2 || r2.every((c) => c === null)) continue;
      if (cPedIdCheck >= 0 && !cellStr(r2, cPedIdCheck)) pedNoId++;
      const cPedImeiCheck = colIdx(hdrPedCheck, "IMEI");
      if (cPedImeiCheck >= 0 && !normalizeImei(cellStr(r2, cPedImeiCheck))) pedNoImei++;
    }
    if (pedNoId > 0)   pedIssues.push({ row: null, severity: "WARNING", code: "NO_ID_PEDIDO",   message: `${pedNoId} linha(s) sem ID PEDIDO ignoradas.` });
    if (pedNoImei > 0) pedIssues.push({ row: null, severity: "INFO",    code: "NO_IMEI",         message: `${pedNoImei} linha(s) sem IMEI válido.` });
    persistIssues(db, "pedidos", importId, pedIssues);
    db.prepare(`UPDATE pedidos_imports SET status='COMPLETED', finished_at=datetime('now'), issues_count=? WHERE id=?`).run(pedIssues.length, importId);
    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return { pedidosInserted, bipagemInserted, peacsInserted };
}

// ===========================================================================
// CARD 5 — BKP SISTÊMICO (3 abas)
// ===========================================================================

export async function previewBkp(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "bkp", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "bkp_imports", fileHash);
  const stagingId = createStaging(db, "bkp", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    const sheetReparos = allSheets.find((n) => normalizeHeader(n) === "REPAROS TECNICOS");
    const sheetBaixa   = allSheets.find((n) => normalizeHeader(n).includes("BAIXA") && normalizeHeader(n).includes("PECA"));
    const sheetTriagem = allSheets.find((n) => normalizeHeader(n) === "TRIAGEM ENTRADA");

    const issues: ImportIssueRaw[] = [];
    if (!sheetReparos) issues.push({ row: null, severity: "ERROR",   code: "NO_REPAROS", message: "Aba REPAROS TECNICOS não encontrada." });
    if (!sheetBaixa)   issues.push({ row: null, severity: "ERROR",   code: "NO_BAIXA",   message: "Aba BAIXA_DE_PEÇA não encontrada." });
    if (!sheetTriagem) issues.push({ row: null, severity: "WARNING", code: "NO_TRIAGEM", message: "Aba TRIAGEM ENTRADA não encontrada." });

    const sheetsToLoad = [sheetReparos, sheetBaixa, sheetTriagem].filter(Boolean) as string[];
    const wb = XLSX.readFile(filePath, { sheets: sheetsToLoad, cellFormula: false, cellHTML: false });

    /** Conta linhas não-vazias e linhas com chave obrigatória. */
    function countBkpSheet(
      name: string | undefined,
      keyColAliases: string[],
    ): { found: number; valid: number; invalid: number; seenKeys: Set<string> } {
      if (!name || !wb.Sheets[name]) return { found: 0, valid: 0, invalid: 0, seenKeys: new Set() };
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
      if (rows.length === 0) return { found: 0, valid: 0, invalid: 0, seenKeys: new Set() };
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const keyIdx = colIdx(hdr, ...keyColAliases);
      const seenKeys = new Set<string>();
      let valid = 0; let invalid = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const key = keyIdx >= 0 ? cellStr(r, keyIdx) : null;
        if (key) {
          seenKeys.add(key);
          valid++;
        } else {
          invalid++;
        }
      }
      return { found: valid + invalid, valid, invalid, seenKeys };
    }

    const rStat = countBkpSheet(sheetReparos, ["IMEI"]);
    const bStat = countBkpSheet(sheetBaixa,   ["REF"]);
    const tStat = countBkpSheet(sheetTriagem,  ["IMEI 1"]);

    const preview: StagedPreview = {
      stagingId, source: "bkp", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: rStat.found + bStat.found + tStat.found,
      rowsValid: rStat.valid + bStat.valid + tStat.valid,
      issues, previewRows: [],
      extra: {
        sheets: { reparos: sheetReparos ?? null, baixa: sheetBaixa ?? null, triagem: sheetTriagem ?? null },
        reparos: { found: rStat.found, valid: rStat.valid, invalid: rStat.invalid },
        baixas:  { found: bStat.found, valid: bStat.valid, invalid: bStat.invalid },
        triagem: { found: tStat.found, valid: tStat.valid, invalid: tStat.invalid },
      },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmBkp(
  db: Db,
  stagingId: number,
  userId: number | null,
): { reparosInserted: number; baixasInserted: number; triagemInserted: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                     throw new ImportCentralError("NOT_FOUND",        "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY",  "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",  "Arquivo temporário não encontrado.");
  if (staged.source !== "bkp")           throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "bkp_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const sheetReparos = allSheets.find((n) => normalizeHeader(n) === "REPAROS TECNICOS");
  const sheetBaixa   = allSheets.find((n) => normalizeHeader(n).includes("BAIXA") && normalizeHeader(n).includes("PECA"));
  const sheetTriagem = allSheets.find((n) => normalizeHeader(n) === "TRIAGEM ENTRADA");

  const sheetsToLoad = [sheetReparos, sheetBaixa, sheetTriagem].filter(Boolean) as string[];
  const wb = XLSX.readFile(staged.stagedPath, { sheets: sheetsToLoad, cellFormula: false, cellHTML: false });

  let reparosInserted = 0;
  let baixasInserted  = 0;
  let triagemInserted = 0;

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO bkp_imports (filename, file_hash, status, rows_found, events_linked, events_unlinked, issues_count, created_by_user_id)
         VALUES (?, ?, 'PENDING', 0, 0, 0, 0, ?)`,
      )
      .run(staged.filename, staged.fileHash, userId);
    const importId = Number(importRow.lastInsertRowid);

    // REPAROS TECNICOS
    if (sheetReparos && wb.Sheets[sheetReparos]) {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetReparos], { header: 1, defval: null });
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cId     = colIdx(hdr, "ID");
      const cImei   = colIdx(hdr, "IMEI");
      const cOs     = colIdx(hdr, "OS");
      const cData   = colIdx(hdr, "DATA");
      const cStatus = colIdx(hdr, "STATUS");
      const cPeca   = colIdx(hdr, "PEÇA UTILIZADA", "PECA UTILIZADA");
      const cRef    = colIdx(hdr, "REF");
      const cAssist = colIdx(hdr, "ASSISTÊNCIA", "ASSISTENCIA");
      const cTecnico= colIdx(hdr, "TÉCNICO RESPONSÁVEL", "TECNICO RESPONSAVEL");
      const cTipo   = colIdx(hdr, "TIPO DE REPARO");

      const insertReparo = db.prepare(
        `INSERT OR IGNORE INTO systemic_repair_events
           (bkp_import_id, imei, imei_norm, os, os_norm, technician_name, repair_date,
            repair_type, part_used, reference_used, executed, assistance_code, raw_data_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const idVal    = cId    >= 0 ? cellStr(r, cId)    : null;
        const imeiRaw  = cImei  >= 0 ? cellStr(r, cImei)  : null;
        const imeiNorm = normalizeImei(imeiRaw);
        const osRaw    = cOs    >= 0 ? cellStr(r, cOs)    : null;
        const osNorm   = normalizeOs(osRaw);
        const ikey = idVal ?? `${imeiNorm ?? ""}|${osNorm ?? ""}|${i}`;
        const status   = cStatus >= 0 ? cellStr(r, cStatus) : null;
        const result = insertReparo.run(
          importId, imeiRaw, imeiNorm, osRaw, osNorm,
          cTecnico >= 0 ? cellStr(r, cTecnico) : null,
          xlsxDateToISO(cData >= 0 ? r[cData] : null),
          cTipo    >= 0 ? cellStr(r, cTipo)    : null,
          cPeca    >= 0 ? cellStr(r, cPeca)    : null,
          cRef     >= 0 ? cellStr(r, cRef)     : null,
          status === "UTILIZADA" ? 1 : 0,
          cAssist  >= 0 ? cellStr(r, cAssist)  : null,
          null, ikey,
        );
        if (result.changes > 0) reparosInserted++;
      }
    }

    // BAIXA_DE_PEÇA
    if (sheetBaixa && wb.Sheets[sheetBaixa]) {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetBaixa], { header: 1, defval: null });
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cId   = colIdx(hdr, "ID");
      const cImei = colIdx(hdr, "IMEI");
      const cRef  = colIdx(hdr, "REF");
      const cStatus = colIdx(hdr, "STATUS");

      const insertBaixa = db.prepare(
        `INSERT OR IGNORE INTO systemic_part_writeoffs
           (bkp_import_id, imei, imei_norm, reference, reference_norm, writeoff_status, raw_data_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const idVal   = cId   >= 0 ? cellStr(r, cId)   : null;
        const ref     = cRef  >= 0 ? cellStr(r, cRef)  : null;
        const imeiRaw = cImei >= 0 ? cellStr(r, cImei) : null;
        const imeiNorm= normalizeImei(imeiRaw);
        const ikey = idVal && ref ? `${idVal}|${ref}` : `${imeiNorm ?? ""}|${ref ?? ""}|${i}`;
        const result = insertBaixa.run(
          importId, imeiRaw, imeiNorm, ref, ref ? normalizeKey(ref) : null,
          cStatus >= 0 ? cellStr(r, cStatus) : null, null, ikey,
        );
        if (result.changes > 0) baixasInserted++;
      }
    }

    // TRIAGEM ENTRADA
    if (sheetTriagem && wb.Sheets[sheetTriagem]) {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetTriagem], { header: 1, defval: null });
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cId     = colIdx(hdr, "ID");
      const cOsSh   = colIdx(hdr, "OS SH");
      const cImei1  = colIdx(hdr, "IMEI 1");
      const cMarca  = colIdx(hdr, "MARCA");
      const cModelo = colIdx(hdr, "MODELO");
      const cCor    = colIdx(hdr, "COR");
      const cCap    = colIdx(hdr, "CAPACIDADE");
      const cData   = colIdx(hdr, "DATA TRIAGEM");
      const cOrigem = colIdx(hdr, "ORIGEM");
      const cDestino= colIdx(hdr, "DESTINO");
      const cRef    = colIdx(hdr, "REF");
      const cTriador= colIdx(hdr, "TRIADOR");

      const insertTriagem = db.prepare(
        `INSERT OR IGNORE INTO device_location_snapshots
           (bkp_import_id, imei, imei_norm, os, os_norm, location, snapshot_date, raw_data_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const idVal   = cId    >= 0 ? cellStr(r, cId)    : null;
        const osSh    = cOsSh  >= 0 ? cellStr(r, cOsSh)  : null;
        const imei1   = cImei1 >= 0 ? cellStr(r, cImei1) : null;
        const imeiNorm= normalizeImei(imei1);
        const ikey = idVal ?? `${imeiNorm ?? ""}|${osSh ?? ""}|${i}`;
        const result = insertTriagem.run(
          importId, imei1, imeiNorm, osSh, normalizeOs(osSh),
          cDestino >= 0 ? cellStr(r, cDestino) : null,
          xlsxDateToISO(cData >= 0 ? r[cData] : null),
          JSON.stringify({
            marca: cMarca  >= 0 ? cellStr(r, cMarca)  : null,
            modelo:cModelo >= 0 ? cellStr(r, cModelo) : null,
            cor:   cCor    >= 0 ? cellStr(r, cCor)    : null,
            cap:   cCap    >= 0 ? cellStr(r, cCap)    : null,
            origem:cOrigem >= 0 ? cellStr(r, cOrigem) : null,
            ref:   cRef    >= 0 ? cellStr(r, cRef)    : null,
            triador:cTriador>= 0? cellStr(r, cTriador): null,
          }), ikey,
        );
        if (result.changes > 0) triagemInserted++;
      }
    }

    const total = reparosInserted + baixasInserted + triagemInserted;
    const totalFound = (() => {
      let n = 0;
      if (sheetReparos && wb.Sheets[sheetReparos]) n += (XLSX.utils.sheet_to_json(wb.Sheets[sheetReparos], { header: 1, defval: null }) as unknown[][]).length - 1;
      if (sheetBaixa   && wb.Sheets[sheetBaixa])   n += (XLSX.utils.sheet_to_json(wb.Sheets[sheetBaixa],   { header: 1, defval: null }) as unknown[][]).length - 1;
      if (sheetTriagem && wb.Sheets[sheetTriagem])  n += (XLSX.utils.sheet_to_json(wb.Sheets[sheetTriagem], { header: 1, defval: null }) as unknown[][]).length - 1;
      return n;
    })();
    const skippedBkp = totalFound - total;
    const bkpIssues: ImportIssueRaw[] = [];
    if (skippedBkp > 0) {
      bkpIssues.push({ row: null, severity: "INFO", code: "DUPLICATE_IKEY", message: `${skippedBkp} linha(s) ignoradas por chave de idempotência duplicada (INSERT OR IGNORE).` });
    }
    persistIssues(db, "bkp", importId, bkpIssues);
    db.prepare(
      `UPDATE bkp_imports SET status='COMPLETED', finished_at=datetime('now'), rows_found=?, events_unlinked=?, issues_count=?, sheets_processed=? WHERE id=?`,
    ).run(total, total, bkpIssues.length, JSON.stringify([sheetReparos, sheetBaixa, sheetTriagem].filter(Boolean)), importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return { reparosInserted, baixasInserted, triagemInserted };
}

// ===========================================================================
// CARD 6 — TRIAGEM DE SAÍDA
// ===========================================================================

export async function previewTriagemSaida(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "triagem-saida", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "triagem_saida_imports", fileHash);
  const stagingId = createStaging(db, "triagem-saida", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    const targetSheet = allSheets.find((n) =>
      normalizeHeader(n) === "TRIAGEM SAIDA" ||
      (normalizeHeader(n).includes("TRIAGEM") && normalizeHeader(n).includes("SAIDA")),
    );
    if (!targetSheet)
      throw new ImportCentralError("SHEET_NOT_FOUND", `Aba "triagem saida" não encontrada. Abas: ${allSheets.join(", ")}`);

    const wb = XLSX.readFile(filePath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
    const ws = wb.Sheets[targetSheet];
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));

    const cConcat     = colIdx(headers, "CONCAT");
    const cRepEfetivo = colIdx(headers, "REPARO EFETIVO");
    const cMotivo     = colIdx(headers, "MOTIVO");
    const cImei       = colIdx(headers, "IMEI");

    const issues: ImportIssueRaw[] = [];
    let sim = 0, nao = 0, semValor = 0, duplicateConcat = 0, semImei = 0, motivoAusente = 0;
    const seenConcat = new Set<string>();

    for (let i = 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const concat  = cConcat     >= 0 ? cellStr(r, cConcat)     : null;
      const efetivo = cRepEfetivo >= 0 ? cellStr(r, cRepEfetivo) : null;
      const motivo  = cMotivo     >= 0 ? cellStr(r, cMotivo)     : null;
      const imei    = cImei       >= 0 ? cellStr(r, cImei)       : null;
      if (concat && seenConcat.has(concat)) duplicateConcat++;
      if (concat) seenConcat.add(concat);
      if (!imei || !normalizeImei(imei)) semImei++;
      const efe = normalizeHeader(efetivo ?? "");
      if (efe === "SIM") sim++;
      else if (efe === "NAO") nao++;
      else semValor++;
      if (efe === "NAO" && (!motivo || !motivo.trim() || normalizeHeader(motivo) === "PREENCHER")) motivoAusente++;
    }

    if (motivoAusente > 0)
      issues.push({ row: null, severity: "WARNING", code: "MOTIVO_ABSENT", message: `${motivoAusente} linha(s) com REPARO EFETIVO=NÃO sem motivo.` });
    if (duplicateConcat > 0)
      issues.push({ row: null, severity: "INFO", code: "DUPLICATE_CONCAT", message: `${duplicateConcat} CONCAT duplicado(s).` });

    const preview: StagedPreview = {
      stagingId, source: "triagem-saida", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: rawRows.length - 1, rowsValid: rawRows.length - 1 - semImei,
      issues,
      previewRows: rawRows.slice(1, 6).map((r) => ({
        concat:  cConcat     >= 0 ? cellStr(r as unknown[], cConcat)     : null,
        imei:    cImei       >= 0 ? cellStr(r as unknown[], cImei)       : null,
        efetivo: cRepEfetivo >= 0 ? cellStr(r as unknown[], cRepEfetivo) : null,
        motivo:  cMotivo     >= 0 ? cellStr(r as unknown[], cMotivo)     : null,
      })),
      extra: { sheetUsed: targetSheet, sim, nao, semValor, duplicateConcat, semImei, motivoAusente },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmTriagemSaida(
  db: Db,
  stagingId: number,
  userId: number | null,
): { rowsInserted: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                     throw new ImportCentralError("NOT_FOUND",       "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",  "Arquivo temporário não encontrado.");
  if (staged.source !== "triagem-saida") throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "triagem_saida_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const targetSheet = allSheets.find((n) =>
    normalizeHeader(n) === "TRIAGEM SAIDA" ||
    (normalizeHeader(n).includes("TRIAGEM") && normalizeHeader(n).includes("SAIDA")),
  )!;
  if (!targetSheet) throw new ImportCentralError("SHEET_NOT_FOUND", "Aba triagem saida não encontrada.");

  const wb = XLSX.readFile(staged.stagedPath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });
  const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));

  const cConcat     = colIdx(headers, "CONCAT");
  const cOs         = colIdx(headers, "OS");
  const cImei       = colIdx(headers, "IMEI");
  const cApsn       = colIdx(headers, "APSN");
  const cMarca      = colIdx(headers, "MARCA");
  const cModelo     = colIdx(headers, "MODELO");
  const cDataReparo = colIdx(headers, "DATA REPARO");
  const cDataTriagem= colIdx(headers, "DATA TRIAGEM");
  const cManutencao = colIdx(headers, "MANUTEÇÃO EXECUTADA","MANUTENÇÃO EXECUTADA","MANUTECAO EXECUTADA","MANUTENCAO EXECUTADA");
  const cTipo       = colIdx(headers, "TIPO DE REPARO");
  const cTecnico    = colIdx(headers, "TÉCNICO RESPONSÁVEL","TECNICO RESPONSAVEL");
  const cEstDest    = colIdx(headers, "ESTOQUE DESTINO");
  const cRepEfetivo = colIdx(headers, "REPARO EFETIVO");
  const cMotivo     = colIdx(headers, "MOTIVO");
  const cAssist     = colIdx(headers, "ASSISTÊNCIA","ASSISTENCIA");
  const cTriador    = colIdx(headers, "TRIADOR");

  let rowsInserted = 0;

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO triagem_saida_imports
           (filename, file_hash, status, rows_found, rows_linked, rows_unlinked, issues_count, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, 0, 0, 0, ?)`,
      )
      .run(staged.filename, staged.fileHash, rawRows.length - 1, userId);
    const importId = Number(importRow.lastInsertRowid);

    const insertRow = db.prepare(
      `INSERT INTO triagem_saida_rows
         (triagem_saida_import_id, imei, imei_norm, os, os_norm,
          concat_key, apsn, brand, model, data_reparo, data_triagem,
          manutencao, tipo_reparo, tecnico, estoque_destino,
          repair_effective, motivo, assistencia, triador,
          destination, raw_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let i = 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const imeiRaw  = cImei >= 0 ? cellStr(r, cImei) : null;
      const imeiNorm = normalizeImei(imeiRaw);
      const osRaw    = cOs   >= 0 ? cellStr(r, cOs)   : null;
      const efetivo  = cRepEfetivo >= 0 ? cellStr(r, cRepEfetivo) : null;
      insertRow.run(
        importId, imeiRaw, imeiNorm, osRaw, normalizeOs(osRaw),
        cConcat     >= 0 ? cellStr(r, cConcat)     : null,
        cApsn       >= 0 ? cellStr(r, cApsn)       : null,
        cMarca      >= 0 ? cellStr(r, cMarca)      : null,
        cModelo     >= 0 ? cellStr(r, cModelo)     : null,
        xlsxDateToISO(cDataReparo  >= 0 ? r[cDataReparo]  : null),
        xlsxDateToISO(cDataTriagem >= 0 ? r[cDataTriagem] : null),
        cManutencao >= 0 ? cellStr(r, cManutencao) : null,
        cTipo       >= 0 ? cellStr(r, cTipo)       : null,
        cTecnico    >= 0 ? cellStr(r, cTecnico)    : null,
        cEstDest    >= 0 ? cellStr(r, cEstDest)    : null,
        efetivo,
        cMotivo  >= 0 ? cellStr(r, cMotivo)  : null,
        cAssist  >= 0 ? cellStr(r, cAssist)  : null,
        cTriador >= 0 ? cellStr(r, cTriador) : null,
        cEstDest >= 0 ? cellStr(r, cEstDest) : null,
        null,
      );
      rowsInserted++;
    }

    const tsIssues: ImportIssueRaw[] = [];
    let tsNoImei = 0; let tsMotivoAusente = 0;
    for (let i = 1; i < rawRows.length; i++) {
      const r2 = rawRows[i] as unknown[];
      if (!r2 || r2.every((c) => c === null)) continue;
      if (!normalizeImei(cImei >= 0 ? cellStr(r2, cImei) : null)) tsNoImei++;
      const efetivo2 = cRepEfetivo >= 0 ? cellStr(r2, cRepEfetivo) : null;
      const motivo2  = cMotivo     >= 0 ? cellStr(r2, cMotivo)     : null;
      if (normalizeHeader(efetivo2 ?? "") === "NAO" && (!motivo2 || !motivo2.trim() || normalizeHeader(motivo2) === "PREENCHER")) tsMotivoAusente++;
    }
    if (tsNoImei > 0)       tsIssues.push({ row: null, severity: "INFO",    code: "NO_IMEI",       message: `${tsNoImei} linha(s) sem IMEI válido.` });
    if (tsMotivoAusente > 0) tsIssues.push({ row: null, severity: "WARNING", code: "MOTIVO_ABSENT", message: `${tsMotivoAusente} linha(s) com REPARO EFETIVO=NÃO sem motivo.` });
    persistIssues(db, "triagem-saida", importId, tsIssues);
    db.prepare(
      `UPDATE triagem_saida_imports SET status='COMPLETED', finished_at=datetime('now'), rows_found=?, rows_unlinked=?, issues_count=? WHERE id=?`,
    ).run(rowsInserted, rowsInserted, tsIssues.length, importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return { rowsInserted };
}

// ===========================================================================
// CARD 7 — SH CATÁLOGO
// ===========================================================================

// ===========================================================================
// CARD 7 — SH ORDENS DE SERVIÇO
// Lê colunas fixas: B=OS, O=marca, P=modelo, Q=cor, R=IMEI
// + DEFEITO e OBS_SERVICO por nome de coluna
// Aceita XLS antigo e XLSX
// ===========================================================================

function readShOsRows(filePath: string): {
  rows: Array<{ osRaw: string | null; osNorm: string | null; imeiRaw: string | null; imeiNorm: string | null; marca: string | null; modelo: string | null; cor: string | null; defeito: string | null; obsServico: string | null }>;
  totalDataLines: number;
  sheetUsed: string;
} {
  const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  // Prefer a sheet named SH, sH, etc.; fall back to first
  const targetSheet = allSheets.find((n) => normalizeHeader(n) === "SH") ?? allSheets[0];
  if (!targetSheet) throw new ImportCentralError("EMPTY_FILE", "Arquivo SH sem abas.");

  const wb = XLSX.readFile(filePath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });
  if (rawRows.length < 2) throw new ImportCentralError("EMPTY_SHEET", "Aba SH vazia ou sem dados.");

  // Find header row — scan up to row 10
  let headerRowIdx = 0;
  const headers: string[] = [];
  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const r = rawRows[i] as unknown[];
    const strs = r.map((c) => (c === null || c === undefined ? "" : String(c)));
    // Look for OS or IMEI or SERIE in any cell
    if (strs.some((s) => /^(OS|IMEI|SERIE|SERIAL)$/i.test(s.trim()))) {
      headerRowIdx = i;
      headers.push(...strs);
      break;
    }
  }
  // If no header row found, use row 0 as header
  if (headers.length === 0) {
    headerRowIdx = 0;
    headers.push(...(rawRows[0] as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c))));
  }

  // Posições fixas obrigatórias (0-based) — nunca usar cabeçalho para estas colunas:
  // B=1: OS, O=14: marca, P=15: modelo, Q=16: cor, R=17: IMEI
  const cOs    = 1;
  const cMarca = 14;
  const cModelo = 15;
  const cCor   = 16;
  const cImei  = 17;
  // DEFEITO e OBS_SERVICO ainda localizados pelo cabeçalho
  const cDefeito    = colIdx(headers, "DEFEITO", "PROBLEMA", "DEFECT");
  const cObsServico = colIdx(headers, "OBS_SERVICO", "OBS SERVICO", "OBSERVACAO SERVICO", "OBSERVAÇÃO SERVIÇO", "COMPLEMENTO");

  const rows = [];
  let totalDataLines = 0;
  for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i] as unknown[];
    if (!r || r.every((c) => c === null)) continue;
    totalDataLines++;
    const osRaw   = cellStr(r, cOs);
    const osNorm  = osRaw ? normalizeOs(osRaw) : null;
    const imeiRaw = cellStr(r, cImei);
    const imeiNorm= imeiRaw ? normalizeImei(imeiRaw) : null;
    rows.push({
      osRaw, osNorm,
      imeiRaw, imeiNorm,
      marca:      cellStr(r, cMarca),
      modelo:     cellStr(r, cModelo),
      cor:        cellStr(r, cCor),
      defeito:    cDefeito    >= 0 ? cellStr(r, cDefeito)    : null,
      obsServico: cObsServico >= 0 ? cellStr(r, cObsServico) : null,
    });
  }
  return { rows, totalDataLines, sheetUsed: targetSheet };
}

export async function previewSh(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "sh", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "sh_os_imports", fileHash);
  const stagingId = createStaging(db, "sh", filename, fileHash, filePath, fileSize, userId);

  try {
    const { rows, totalDataLines, sheetUsed } = readShOsRows(filePath);
    const rowsValid = rows.filter((r) => r.osNorm || r.imeiNorm).length;
    const issues: ImportIssueRaw[] = [];
    const noOsOrImei = rows.filter((r) => !r.osNorm && !r.imeiNorm).length;
    if (noOsOrImei > 0) {
      issues.push({ row: null, severity: "WARNING", code: "NO_OS_OR_IMEI", message: `${noOsOrImei} linha(s) sem OS nem IMEI válido.` });
    }

    const preview: StagedPreview = {
      stagingId, source: "sh", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: totalDataLines, rowsValid, issues,
      previewRows: rows.slice(0, 5).map((r) => ({
        os: r.osRaw, imei: r.imeiRaw, marca: r.marca, modelo: r.modelo, cor: r.cor, defeito: r.defeito,
      })),
      extra: { sheetUsed, noOsOrImei },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmSh(
  db: Db,
  stagingId: number,
  userId: number | null,
): { rowsInserted: number; rowsUpdated: number; rowsUnchanged: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                          throw new ImportCentralError("NOT_FOUND",       "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY",      "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",      "Arquivo temporário não encontrado.");
  if (staged.source !== "sh")            throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "sh_os_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const { rows, totalDataLines } = readShOsRows(staged.stagedPath);
  let syncResult = { inserted: 0, updated: 0, unchanged: 0 };

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO sh_os_imports (filename, file_hash, status, rows_found, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, ?)`,
      )
      .run(staged.filename, staged.fileHash, totalDataLines, userId);
    const importId = Number(importRow.lastInsertRowid);

    let skipped = 0;
    const syncRows: SyncRow[] = [];
    for (const r of rows) {
      if (!r.osNorm && !r.imeiNorm) { skipped++; continue; }
      const lookupKey = r.osNorm ?? `I:${r.imeiNorm}`;
      syncRows.push({
        key:  lookupKey,
        hash: rowHash(r.osNorm, r.imeiNorm, r.marca, r.modelo, r.cor, r.defeito, r.obsServico),
        cols: {
          sh_os_import_id: importId,
          os_norm:     r.osNorm    ?? null,
          imei_norm:   r.imeiNorm  ?? null,
          os_raw:      r.osRaw     ?? null,
          imei_raw:    r.imeiRaw   ?? null,
          marca:       r.marca     ?? null,
          modelo:      r.modelo    ?? null,
          cor:         r.cor       ?? null,
          defeito:     r.defeito   ?? null,
          obs_servico: r.obsServico ?? null,
        },
      });
    }

    syncResult = syncCurrentTable(db, {
      table:       "sh_os_current",
      keyCol:      "lookup_key",
      importIdCol: "sh_os_import_id",
      rows:        syncRows,
    });

    const issues: ImportIssueRaw[] = [];
    if (skipped > 0) issues.push({ row: null, severity: "WARNING", code: "NO_OS_OR_IMEI", message: `${skipped} linha(s) sem OS nem IMEI ignoradas.` });
    persistIssues(db, "sh", importId, issues);
    db.prepare(
      `UPDATE sh_os_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_valid=?, issues_count=?,
         rows_inserted=?, rows_updated=?, rows_unchanged=? WHERE id=?`,
    ).run(syncResult.inserted + syncResult.updated + syncResult.unchanged, issues.length,
          syncResult.inserted, syncResult.updated, syncResult.unchanged, importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return {
    rowsInserted:  syncResult.inserted,
    rowsUpdated:   syncResult.updated,
    rowsUnchanged: syncResult.unchanged,
  };
}

// ===========================================================================
// CARD 8 — PEACS STANDALONE
// Aceita xlsx/xls com aba contendo "PEACS". Upsert em peacs_catalog.
// Col A = MARCA-MODELO, Col E = TABELA SEMINOVO PRAZO
// ===========================================================================

export async function previewPeacs(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "peacs", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "peacs_imports", fileHash);
  const stagingId = createStaging(db, "peacs", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    const targetSheet =
      allSheets.find((n) => normalizeHeader(n) === "TABELA DE AVALIACAO (PEACS)") ??
      allSheets.find((n) => normalizeHeader(n).includes("PEACS")) ??
      allSheets.find((n) => normalizeHeader(n).includes("AVALIA")) ??
      allSheets[0];
    if (!targetSheet) throw new ImportCentralError("EMPTY_FILE", "Arquivo sem abas.");

    const wb = XLSX.readFile(filePath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });
    if (rawRows.length === 0) throw new ImportCentralError("EMPTY_SHEET", "Aba vazia.");

    // Find header row (has MARCA-MODELO or MARCA or MODELO)
    let headerRowIdx = 0;
    const hdrs: string[] = [];
    for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
      const r = rawRows[i] as unknown[];
      const strs = r.map((c) => (c === null || c === undefined ? "" : String(c)));
      if (strs.some((s) => /MARCA|MODELO|PEACS/i.test(s))) {
        headerRowIdx = i;
        hdrs.push(...strs);
        break;
      }
    }
    if (hdrs.length === 0) {
      headerRowIdx = 0;
      hdrs.push(...(rawRows[0] as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c))));
    }

    const cMarcaModelo = colIdx(hdrs, "MARCA-MODELO", "MARCAMODELO", "MARCA MODELO", "MARCA/MODELO");
    const cPreco       = colIdx(hdrs, "TABELA SEMINOVO PRAZO", "TABELASEMINOVOPRAZO", "PRECO", "PREÇO", "VENDA");
    const cFamilia     = colIdx(hdrs, "FAMILIA", "FAMÍLIA");
    const cDataAtualizacao = colIdx(hdrs, "DATA ATUALIZACAO", "DATA ATUALIZAÇÃO", "DATA");

    // Col A fallback for MARCA-MODELO, col E for price
    const colMM = cMarcaModelo >= 0 ? cMarcaModelo : 0;
    const colPr = cPreco       >= 0 ? cPreco       : 4;

    const issues: ImportIssueRaw[] = [];
    let rowsValid = 0; let noMm = 0;
    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      if (!cellStr(r, colMM)) { noMm++; continue; }
      rowsValid++;
    }
    if (noMm > 0) issues.push({ row: null, severity: "WARNING", code: "NO_MARCA_MODELO", message: `${noMm} linha(s) sem MARCA-MODELO ignoradas.` });
    if (cPreco < 0) issues.push({ row: null, severity: "WARNING", code: "NO_PRICE_COL", message: "Coluna de preço não localizada; usando coluna E (índice 4)." });

    const preview: StagedPreview = {
      stagingId, source: "peacs", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: rawRows.length - 1 - headerRowIdx, rowsValid, issues,
      previewRows: rawRows.slice(headerRowIdx + 1, headerRowIdx + 6).map((r) => ({
        marcaModelo: cellStr(r as unknown[], colMM),
        preco: parseCostBR((r as unknown[])[colPr]),
        familia: cFamilia >= 0 ? cellStr(r as unknown[], cFamilia) : null,
      })),
      extra: { sheetUsed: targetSheet, noMm, colMM, colPr, hasDataAtualizacao: cDataAtualizacao >= 0 },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmPeacs(
  db: Db,
  stagingId: number,
  userId: number | null,
): { rowsInserted: number; rowsUpdated: number; rowsUnchanged: number; rowsDeactivated: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                          throw new ImportCentralError("NOT_FOUND",       "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY",      "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",      "Arquivo temporário não encontrado.");
  if (staged.source !== "peacs")         throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "peacs_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const targetSheet =
    allSheets.find((n) => normalizeHeader(n) === "TABELA DE AVALIACAO (PEACS)") ??
    allSheets.find((n) => normalizeHeader(n).includes("PEACS")) ??
    allSheets.find((n) => normalizeHeader(n).includes("AVALIA")) ??
    allSheets[0];
  if (!targetSheet) throw new ImportCentralError("EMPTY_FILE", "Arquivo sem abas.");

  const wb = XLSX.readFile(staged.stagedPath, { sheets: [targetSheet], cellFormula: false, cellHTML: false });
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });

  let headerRowIdx = 0;
  const hdrs: string[] = [];
  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const r = rawRows[i] as unknown[];
    const strs = r.map((c) => (c === null || c === undefined ? "" : String(c)));
    if (strs.some((s) => /MARCA|MODELO|PEACS/i.test(s))) { headerRowIdx = i; hdrs.push(...strs); break; }
  }
  if (hdrs.length === 0) {
    headerRowIdx = 0;
    hdrs.push(...(rawRows[0] as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c))));
  }

  const cMarca       = colIdx(hdrs, "MARCA");           // col B separada (sem MODELO)
  const cMarcaModelo = colIdx(hdrs, "MARCA-MODELO", "MARCAMODELO", "MARCA MODELO", "MARCA/MODELO");
  const cPreco       = colIdx(hdrs, "TABELA SEMINOVO PRAZO", "TABELASEMINOVOPRAZO", "PRECO", "PREÇO", "VENDA");
  const cFamilia     = colIdx(hdrs, "FAMILIA", "FAMÍLIA");
  const cMemoria     = colIdx(hdrs, "MEMORIA", "MEMÓRIA");
  const cDataAtual   = colIdx(hdrs, "DATA ATUALIZACAO", "DATA ATUALIZAÇÃO", "DATA");
  const colMM = cMarcaModelo >= 0 ? cMarcaModelo : 0;
  const colPr = cPreco       >= 0 ? cPreco       : 4;

  let rowsInserted = 0;
  let rowsUpdated  = 0;
  let rowsUnchanged = 0;
  let rowsDeactivated = 0;
  let updatedDate: string | null = null;

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO peacs_imports (filename, file_hash, status, rows_found, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, ?)`,
      )
      .run(staged.filename, staged.fileHash, rawRows.length - 1 - headerRowIdx, userId);
    const importId = Number(importRow.lastInsertRowid);

    // Carregar estado ativo atual: norm → { id, hash }
    const activeCatalog = new Map<string, { id: number; hash: string | null }>();
    const activeRows = db
      .prepare("SELECT id, marca_modelo_norm, row_hash FROM peacs_catalog WHERE active=1")
      .all() as { id: number; marca_modelo_norm: string; row_hash: string | null }[];
    for (const r of activeRows) activeCatalog.set(r.marca_modelo_norm, { id: r.id, hash: r.row_hash });

    const seenNorms = new Set<string>();
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    const insertStmt = db.prepare(
      `INSERT INTO peacs_catalog
         (peacs_import_id, brand, brand_norm, model, model_norm,
          marca_modelo, marca_modelo_norm, familia, memoria_src, estimated_sale,
          active, row_hash, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))`,
    );
    const updateStmt = db.prepare(
      `UPDATE peacs_catalog SET
         peacs_import_id=?, brand=?, brand_norm=?, model=?, model_norm=?,
         marca_modelo=?, familia=?, memoria_src=?, estimated_sale=?,
         active=1, row_hash=?, last_seen_at=?, updated_at=datetime('now')
       WHERE id=?`,
    );
    const unchangedStmt = db.prepare(
      `UPDATE peacs_catalog SET peacs_import_id=?, last_seen_at=datetime('now') WHERE id=?`,
    );

    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const mm = cellStr(r, colMM);
      if (!mm) continue;
      const mmNorm = normalizeKey(mm);
      const preco = parseCostBR(r[colPr]) ?? null;
      const familia = cFamilia >= 0 ? cellStr(r, cFamilia) : null;
      const memoria = cMemoria >= 0 ? cellStr(r, cMemoria) : null;
      if (!updatedDate && cDataAtual >= 0) updatedDate = xlsxDateToISO(r[cDataAtual]);

      // brand/model: col B (MARCA) quando disponível; caso contrário usar mm inteiro
      const marcaRaw = cMarca >= 0 ? cellStr(r, cMarca) : null;
      const brand     = marcaRaw ?? mm;
      const brandNorm = normalizeKey(brand);
      // model: mm completo quando não há col separada; ao ter MARCA separada, mm é o modelo
      const model     = mm;
      const modelNorm = mmNorm;

      const h = rowHash(mmNorm, preco, familia, memoria);
      seenNorms.add(mmNorm);

      const ex = activeCatalog.get(mmNorm);
      if (!ex) {
        insertStmt.run(importId, brand, brandNorm, model, modelNorm, mm, mmNorm, familia, memoria, preco, h, now);
        rowsInserted++;
      } else if ((ex.hash ?? "") !== h) {
        updateStmt.run(importId, brand, brandNorm, model, modelNorm, mm, familia, memoria, preco, h, now, ex.id);
        rowsUpdated++;
      } else {
        unchangedStmt.run(importId, ex.id);
        rowsUnchanged++;
      }
    }

    // Desativar chaves ausentes neste import
    for (const [norm, ex] of activeCatalog) {
      if (!seenNorms.has(norm)) {
        db.prepare("UPDATE peacs_catalog SET active=0, updated_at=datetime('now') WHERE id=?").run(ex.id);
        rowsDeactivated++;
      }
    }

    const issues: ImportIssueRaw[] = [];
    persistIssues(db, "peacs", importId, issues);
    db.prepare(
      `UPDATE peacs_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_valid=?, updated_date=?, issues_count=0,
         rows_inserted=?, rows_updated=?, rows_unchanged=?, rows_deactivated=? WHERE id=?`,
    ).run(rowsInserted + rowsUpdated + rowsUnchanged, updatedDate,
          rowsInserted, rowsUpdated, rowsUnchanged, rowsDeactivated, importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return { rowsInserted, rowsUpdated, rowsUnchanged, rowsDeactivated };
}

// ===========================================================================
// CARD 9 — DEMONSTRATIVO DE SALDOS
// XLS do Datasys — referência, descrição, código comercial, fabricante, saldo
// ===========================================================================

export async function previewDemonstrativo(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  validateFileForSource(filePath, "demonstrativo", filename);

  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "demonstrativo_imports", fileHash);
  const stagingId = createStaging(db, "demonstrativo", filename, fileHash, filePath, fileSize, userId);

  try {
    const wb = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false });
    const allSheets: string[] = wb.SheetNames ?? [];
    const targetSheet =
      allSheets.find((n) => normalizeHeader(n).includes("SALDO")) ??
      allSheets.find((n) => normalizeHeader(n).includes("DEMONSTRAT")) ??
      allSheets[0];
    if (!targetSheet) throw new ImportCentralError("EMPTY_FILE", "Arquivo sem abas.");

    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });
    if (rawRows.length === 0) throw new ImportCentralError("EMPTY_SHEET", "Aba vazia.");

    // Find header row (look for REFERENCIA, PRODUTO, SALDO)
    let headerRowIdx = 0;
    const hdrs: string[] = [];
    for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
      const r = rawRows[i] as unknown[];
      const strs = r.map((c) => (c === null || c === undefined ? "" : String(c)));
      if (strs.some((s) => /REFER[EÊ]NCIA|PRODUTO|SALDO|DESCRI/i.test(s))) {
        headerRowIdx = i; hdrs.push(...strs); break;
      }
    }
    if (hdrs.length === 0) {
      headerRowIdx = 0;
      hdrs.push(...(rawRows[0] as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c))));
    }

    const cRef      = colIdx(hdrs, "REFERENCIA", "REFERÊNCIA", "PRODUTO", "REF");
    const cDesc     = colIdx(hdrs, "DESCRICAO", "DESCRIÇÃO", "DESCR");
    const cCodCom   = colIdx(hdrs, "CODIGO COMERCIAL", "CÓDIGO COMERCIAL", "COD COMERCIAL");
    const cSaldo     = colIdx(hdrs, "SALDO", "SALDO ATUAL", "SALDO INFORMADO", "QTD");

    const issues: ImportIssueRaw[] = [];
    if (cRef < 0) issues.push({ row: null, severity: "WARNING", code: "NO_REF_COL", message: "Coluna de referência não localizada." });

    let rowsValid = 0;
    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      if (cRef >= 0 && !cellStr(r, cRef)) continue;
      rowsValid++;
    }

    const preview: StagedPreview = {
      stagingId, source: "demonstrativo", filename, fileHash, fileSize,
      status: "PREVIEW_READY", alreadyImported: !!existingId, existingImportId: existingId,
      rowsFound: rawRows.length - 1 - headerRowIdx, rowsValid, issues,
      previewRows: rawRows.slice(headerRowIdx + 1, headerRowIdx + 6).map((r) => ({
        referencia:   cRef    >= 0 ? cellStr(r as unknown[], cRef)    : null,
        descricao:    cDesc   >= 0 ? cellStr(r as unknown[], cDesc)   : null,
        codComercial: cCodCom >= 0 ? cellStr(r as unknown[], cCodCom) : null,
        saldo:        cSaldo  >= 0 ? parseCostBR((r as unknown[])[cSaldo]) : null,
      })),
      extra: { sheetUsed: targetSheet, colsFound: { ref: cRef >= 0, desc: cDesc >= 0, codComercial: cCodCom >= 0, saldo: cSaldo >= 0 } },
    };

    setStagingPreviewReady(db, stagingId, JSON.stringify(preview));
    return preview;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStagingFailed(db, stagingId, msg);
    if (err instanceof ImportCentralError) throw err;
    throw new ImportCentralError("PARSE_ERROR", msg);
  }
}

export function confirmDemonstrativo(
  db: Db,
  stagingId: number,
  userId: number | null,
): { rowsInserted: number; rowsUpdated: number; rowsUnchanged: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged)                          throw new ImportCentralError("NOT_FOUND",       "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY") throw new ImportCentralError("NOT_READY",      "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath)) throw new ImportCentralError("FILE_GONE",      "Arquivo temporário não encontrado.");
  if (staged.source !== "demonstrativo") throw new ImportCentralError("SOURCE_MISMATCH","Staging pertence a outra fonte.");

  const existingId = checkDuplicateHash(db, "demonstrativo_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wb = XLSX.readFile(staged.stagedPath, { cellFormula: false, cellHTML: false });
  const allSheets: string[] = wb.SheetNames ?? [];
  const targetSheet =
    allSheets.find((n) => normalizeHeader(n).includes("SALDO")) ??
    allSheets.find((n) => normalizeHeader(n).includes("DEMONSTRAT")) ??
    allSheets[0];
  if (!targetSheet) throw new ImportCentralError("EMPTY_FILE", "Arquivo sem abas.");

  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });

  let headerRowIdx = 0;
  const hdrs: string[] = [];
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const r = rawRows[i] as unknown[];
    const strs = r.map((c) => (c === null || c === undefined ? "" : String(c)));
    if (strs.some((s) => /REFER[EÊ]NCIA|PRODUTO|SALDO|DESCRI/i.test(s))) { headerRowIdx = i; hdrs.push(...strs); break; }
  }
  if (hdrs.length === 0) {
    headerRowIdx = 0;
    hdrs.push(...(rawRows[0] as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c))));
  }

  const cRef      = colIdx(hdrs, "REFERENCIA", "REFERÊNCIA", "PRODUTO", "REF");
  const cDesc     = colIdx(hdrs, "DESCRICAO", "DESCRIÇÃO", "DESCR");
  const cCodCom   = colIdx(hdrs, "CODIGO COMERCIAL", "CÓDIGO COMERCIAL", "COD COMERCIAL");
  const cFab      = colIdx(hdrs, "FABRICANTE");
  const cGrupo    = colIdx(hdrs, "GRUPO");
  const cSubgrupo = colIdx(hdrs, "SUBGRUPO");
  const cFamilia  = colIdx(hdrs, "FAMILIA", "FAMÍLIA");
  const cSaldo    = colIdx(hdrs, "SALDO", "SALDO ATUAL", "SALDO INFORMADO", "QTD");

  let syncResult = { inserted: 0, updated: 0, unchanged: 0 };

  withTx(db, () => {
    const importRow = db
      .prepare(
        `INSERT INTO demonstrativo_imports (filename, file_hash, status, rows_found, created_by_user_id)
         VALUES (?, ?, 'PENDING', ?, ?)`,
      )
      .run(staged.filename, staged.fileHash, rawRows.length - 1 - headerRowIdx, userId);
    const importId = Number(importRow.lastInsertRowid);

    // Consolidar por referencia_norm (última ocorrência física vence, saldo não soma)
    const byRef = new Map<string, SyncRow>();
    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const ref = cRef >= 0 ? cellStr(r, cRef) : null;
      if (cRef >= 0 && !ref) continue;
      const refNorm = ref ? normalizeKey(ref) : null;
      if (!refNorm) continue;
      const desc       = cDesc     >= 0 ? cellStr(r, cDesc)     : null;
      const codCom     = cCodCom   >= 0 ? cellStr(r, cCodCom)   : null;
      const fab        = cFab      >= 0 ? cellStr(r, cFab)       : null;
      const grupo      = cGrupo    >= 0 ? cellStr(r, cGrupo)     : null;
      const subgrupo   = cSubgrupo >= 0 ? cellStr(r, cSubgrupo)  : null;
      const familia    = cFamilia  >= 0 ? cellStr(r, cFamilia)   : null;
      const saldo      = cSaldo    >= 0 ? parseCostBR(r[cSaldo]) ?? null : null;
      byRef.set(refNorm, {
        key:  refNorm,
        hash: rowHash(desc, codCom, fab, grupo, subgrupo, familia, saldo),
        cols: {
          demonstrativo_import_id: importId,
          referencia: ref,
          descricao:        desc,
          codigo_comercial: codCom,
          fabricante:       fab,
          grupo,
          subgrupo,
          familia,
          saldo,
        },
      });
    }
    const syncRows: SyncRow[] = Array.from(byRef.values());

    syncResult = syncCurrentTable(db, {
      table:       "demonstrativo_current",
      keyCol:      "referencia_norm",
      importIdCol: "demonstrativo_import_id",
      rows:        syncRows,
    });

    db.prepare(
      `UPDATE demonstrativo_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_valid=?, issues_count=0,
         rows_inserted=?, rows_updated=?, rows_unchanged=? WHERE id=?`,
    ).run(syncResult.inserted + syncResult.updated + syncResult.unchanged,
          syncResult.inserted, syncResult.updated, syncResult.unchanged, importId);

    confirmStaging(db, stagingId, importId);
  });

  try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }
  return {
    rowsInserted:  syncResult.inserted,
    rowsUpdated:   syncResult.updated,
    rowsUnchanged: syncResult.unchanged,
  };
}
