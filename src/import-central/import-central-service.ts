/**
 * Central de Dados — serviços de importação por fonte.
 *
 * Sete fontes ativas: his | rel-seriais | analise-mi | pedidos | bkp | triagem-saida | sh
 * Fluxo: upload → preview (PREVIEW_READY em import_staged_files) → confirm → import record.
 * Idempotente por hash de arquivo. Staging persistente sobrevive a reinício.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { createRequire } from "node:module";
import type { Db } from "../db/database.js";
import { normalizeKey, normalizeHeader } from "../domain/text.js";

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
  | "sh";

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
}

// ---------------------------------------------------------------------------
// Utilitários internos
// ---------------------------------------------------------------------------

export function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Parser monetário: aceita BR (1.400,00) e US (1,400.00) sem confundir. */
export function parseCostBR(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw)
    .replace(/[R$ \s]/g, "")
    .trim();
  if (!s) return null;
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let normalized: string;
  if (hasDot && hasComma) {
    // Ambos separadores presentes — o último é o decimal
    normalized =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".") // BR: 1.400,00
        : s.replace(/,/g, ""); // US: 1,400.00
  } else if (hasComma && !hasDot) {
    normalized = s.replace(",", "."); // 1400,00
  } else {
    normalized = s; // 1400.00 ou 1400
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

/** Encontra o índice de uma coluna por aliases normalizados. Retorna -1 se não encontrar. */
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

function cellNum(row: unknown[], idx: number): number | null {
  const s = cellStr(row, idx);
  if (s === null) return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
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
    } catch {
      /* fall through */
    }
  }
  // Already a string date
  const s = String(serial).trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// Staging — DB-backed, substitui o Map em memória
// ---------------------------------------------------------------------------

const SOURCE_IMPORT_TABLES: Record<SourceKey, string> = {
  his: "his_imports",
  "rel-seriais": "rel_seriais_imports",
  "analise-mi": "analise_mi_imports",
  pedidos: "pedidos_imports",
  bkp: "bkp_imports",
  "triagem-saida": "triagem_saida_imports",
  sh: "sh_catalog_imports",
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

export function setStagingPreviewReady(
  db: Db,
  stagingId: number,
  previewJson: string,
): void {
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
    source: row["source"] as string,
    filename: row["filename"] as string,
    fileHash: row["file_hash"] as string,
    stagedPath: row["staged_path"] as string,
    status: row["status"] as StagingStatus,
    previewJson: (row["preview_json"] as string | null) ?? null,
  };
}

export function confirmStaging(
  db: Db,
  stagingId: number,
  importId: number,
): void {
  db.prepare(
    `UPDATE import_staged_files
     SET status='CONFIRMED', confirmed_at=datetime('now'), import_id_created=?
     WHERE id=?`,
  ).run(importId, stagingId);
}

export function cancelStaging(
  db: Db,
  stagingId: number,
): { stagedPath: string | null } {
  const row = db
    .prepare(`SELECT staged_path, status FROM import_staged_files WHERE id=?`)
    .get(stagingId) as { staged_path: string; status: string } | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (row.status === "CONFIRMED")
    throw new ImportCentralError(
      "ALREADY_CONFIRMED",
      "Não é possível cancelar: importação já confirmada.",
    );
  db.prepare(
    `UPDATE import_staged_files SET status='CANCELLED' WHERE id=?`,
  ).run(stagingId);
  return { stagedPath: row.staged_path };
}

/** Expira previews passados do TTL e retorna caminhos de arquivos a remover. */
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
  status: StagingStatus;
  createdAt: string;
  expiresAt: string;
}[] {
  return (
    db
      .prepare(
        `SELECT id, filename, file_hash, status, created_at, expires_at
       FROM import_staged_files WHERE source=? ORDER BY id DESC LIMIT 10`,
      )
      .all(source) as Record<string, unknown>[]
  ).map((r) => ({
    id: r["id"] as number,
    filename: r["filename"] as string,
    fileHash: r["file_hash"] as string,
    status: r["status"] as StagingStatus,
    createdAt: r["created_at"] as string,
    expiresAt: r["expires_at"] as string,
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
        id: number;
        created_at: string;
        status: string;
        rows_found: number;
        issues_count: number;
      } | undefined;
      const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
          c: number;
        }
      ).c;
      const pending = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM import_staged_files WHERE source=? AND status IN ('UPLOADED','PREVIEW_READY')`,
          )
          .get(source) as { c: number }
      ).c;
      if (!row)
        return {
          lastImportId: null,
          lastImportAt: null,
          lastStatus: null,
          totalImports: total,
          lastRowsFound: 0,
          lastIssuesCount: 0,
          pendingStaging: pending,
        };
      return {
        lastImportId: row.id,
        lastImportAt: row.created_at,
        lastStatus: row.status,
        totalImports: total,
        lastRowsFound: row.rows_found,
        lastIssuesCount: row.issues_count,
        pendingStaging: pending,
      };
    } catch {
      return {
        lastImportId: null,
        lastImportAt: null,
        lastStatus: null,
        totalImports: 0,
        lastRowsFound: 0,
        lastIssuesCount: 0,
        pendingStaging: 0,
      };
    }
  }
  return {
    his: statusFor("his"),
    "rel-seriais": statusFor("rel-seriais"),
    "analise-mi": statusFor("analise-mi"),
    pedidos: statusFor("pedidos"),
    bkp: statusFor("bkp"),
    "triagem-saida": statusFor("triagem-saida"),
    sh: statusFor("sh"),
  };
}

// ---------------------------------------------------------------------------
// getSourceHistory
// ---------------------------------------------------------------------------

export function getSourceHistory(
  db: Db,
  source: SourceKey,
): ImportHistoryEntry[] {
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
    id: r["id"] as number,
    filename: r["filename"] as string,
    fileHash: r["file_hash"] as string,
    status: r["status"] as string,
    rowsFound: ((r["rows_found"] as number) ?? 0),
    rowsValid: (r["rows_valid"] as number | undefined) ?? undefined,
    issuesCount: ((r["issues_count"] as number) ?? 0),
    createdAt: r["created_at"] as string,
    finishedAt: (r["finished_at"] as string | null) ?? null,
    createdByName: (r["created_by_name"] as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// cancelImport (import record, not staging)
// ---------------------------------------------------------------------------

export function cancelImport(
  db: Db,
  source: SourceKey,
  importId: number,
): void {
  const table = SOURCE_IMPORT_TABLES[source];
  const row = db
    .prepare(`SELECT id, status FROM ${table} WHERE id=?`)
    .get(importId) as { id: number; status: string } | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row.status === "COMPLETED")
    throw new ImportCentralError(
      "ALREADY_COMPLETED",
      "Não é possível cancelar importação concluída.",
    );
  if (row.status === "CANCELLED") return;
  db.prepare(
    `UPDATE ${table} SET status='CANCELLED', finished_at=datetime('now') WHERE id=?`,
  ).run(importId);
}

// ---------------------------------------------------------------------------
// getLegadoStatus (importações legado originais via import_batches)
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
      `SELECT id, created_at, orders_found, inventory_found
       FROM import_batches WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as {
    id: number;
    created_at: string;
    orders_found: number;
    inventory_found: number;
  } | undefined;
  return {
    initialized: !!row,
    lastBatchId: row?.id ?? null,
    lastBatchAt: row?.created_at ?? null,
    ordersFound: row?.orders_found ?? 0,
    inventoryFound: row?.inventory_found ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Verifica duplicidade de hash no import table (não no staging)
// ---------------------------------------------------------------------------

function checkDuplicateHash(
  db: Db,
  table: string,
  fileHash: string,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM ${table} WHERE file_hash=? AND status NOT IN ('FAILED','CANCELLED')`,
    )
    .get(fileHash) as { id: number } | undefined;
  return row?.id ?? null;
}

// ===========================================================================
// CARD 1 — HIS ESTOQUE (aging e custo auditado)
// Arquivo: qualquer .xlsx com aba "His Estoque" (tipicamente PEDIDOS.xlsx)
// Cols: B=Serial/IMEI, R=Dias em Estoque, S=Custo estoque, U=Data Relatorio
// Regra: ÚLTIMA ocorrência física por IMEI
// ===========================================================================

interface HisRow {
  imeiRaw: string;
  imeiNorm: string;
  ageDays: number | null;
  cost: number | null;
  reportDate: string | null;
  sourceLine: number;
  rawAge: unknown;
  rawCost: unknown;
  rawDate: unknown;
}

export async function previewHis(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "his_imports", fileHash);
  const stagingId = createStaging(db, "his", filename, fileHash, filePath, fileSize, userId);

  const issues: ImportIssueRaw[] = [];

  try {
    // Leitura seletiva — somente aba "His Estoque"
    const wb = XLSX.readFile(filePath, {
      sheets: ["His Estoque"],
      cellFormula: false,
      cellHTML: false,
    });
    const ws = wb.Sheets["His Estoque"];
    if (!ws) {
      const allSheets: string[] = wb.SheetNames ?? [];
      throw new ImportCentralError(
        "SHEET_NOT_FOUND",
        `Aba "His Estoque" não encontrada. Abas presentes: ${allSheets.join(", ")}`,
      );
    }

    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
    });

    // Encontra a linha de cabeçalho (contém "Serial" na coluna B=idx1)
    let headerIdx = rawRows.findIndex(
      (r) => r[1] !== null && normalizeHeader(String(r[1] ?? "")) === "SERIAL",
    );
    if (headerIdx < 0) headerIdx = 0; // assume primeira linha

    const dataRows = rawRows.slice(headerIdx + 1);

    // Coleta última ocorrência por IMEI (processa de cima para baixo, sobrescreve)
    const lastByImei = new Map<string, HisRow>();
    let totalLines = 0;
    let skippedNoImei = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      if (!row || row.every((c) => c === null || c === undefined || c === ""))
        continue;
      totalLines++;
      const lineNum = headerIdx + 1 + i + 1; // 1-based

      const imeiRaw = cellStr(row, 1); // col B
      const imeiNorm = normalizeImei(imeiRaw);
      if (!imeiNorm) {
        skippedNoImei++;
        continue;
      }

      const rawAge = row[17]; // col R
      const rawCost = row[18]; // col S
      const rawDate = row[20]; // col U

      const ageDays = rawAge !== null && rawAge !== undefined ? cellNum(row, 17) : null;
      const cost = parseCostBR(rawCost);
      const reportDate = xlsxDateToISO(rawDate);

      const prev = lastByImei.get(imeiNorm);
      if (prev && prev.reportDate && reportDate && reportDate < prev.reportDate) {
        issues.push({
          row: lineNum,
          severity: "WARNING",
          code: "DATE_OUT_OF_ORDER",
          message: `IMEI ${imeiNorm}: data ${reportDate} menor que ocorrência anterior ${prev.reportDate}. Usando última linha física (regra PROCX -1).`,
          rawValue: String(rawDate),
        });
      }

      lastByImei.set(imeiNorm, {
        imeiRaw: imeiRaw ?? imeiNorm,
        imeiNorm,
        ageDays: ageDays !== null ? ageDays : null,
        cost,
        reportDate,
        sourceLine: lineNum,
        rawAge,
        rawCost,
        rawDate,
      });
    }

    const consolidated = Array.from(lastByImei.values());
    const rowsValid = consolidated.length;
    const discarded = totalLines - skippedNoImei - rowsValid;

    const preview = {
      stagingId,
      source: "his" as SourceKey,
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY" as StagingStatus,
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: totalLines,
      rowsValid,
      issues,
      previewRows: consolidated.slice(0, 20).map((r) => ({
        imei: r.imeiNorm,
        ageDays: r.ageDays,
        cost: r.cost,
        reportDate: r.reportDate,
        sourceLine: r.sourceLine,
      })),
      extra: {
        imeiUnique: rowsValid,
        discardedOcurrences: discarded,
        skippedNoImei,
        ageEmpty: consolidated.filter((r) => r.ageDays === null).length,
        costEmpty: consolidated.filter((r) => r.cost === null).length,
        dateWarnings: issues.filter((i) => i.code === "DATE_OUT_OF_ORDER").length,
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

export function confirmHis(
  db: Db,
  stagingId: number,
  userId: number | null,
): { rowsInserted: number; rowsLinked: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não está pronto ou já foi confirmado.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado. Faça upload novamente.");

  const preview = staged.previewJson ? (JSON.parse(staged.previewJson) as StagedPreview) : null;
  const existingId = checkDuplicateHash(db, "his_imports", staged.fileHash);
  if (existingId)
    throw new ImportCentralError("ALREADY_IMPORTED", "Este arquivo já foi importado.");

  // Reler para garantir consistência do hash
  const actualHash = hashFile(staged.stagedPath);
  if (actualHash !== staged.fileHash)
    throw new ImportCentralError("HASH_MISMATCH", "Hash do arquivo mudou. Faça upload novamente.");

  const wb = XLSX.readFile(staged.stagedPath, {
    sheets: ["His Estoque"],
    cellFormula: false,
    cellHTML: false,
  });
  const ws = wb.Sheets["His Estoque"];
  if (!ws) throw new ImportCentralError("SHEET_NOT_FOUND", 'Aba "His Estoque" não encontrada.');

  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  let headerIdx = rawRows.findIndex(
    (r) => r[1] !== null && normalizeHeader(String(r[1] ?? "")) === "SERIAL",
  );
  if (headerIdx < 0) headerIdx = 0;

  // Última ocorrência por IMEI
  const lastByImei = new Map<string, HisRow>();
  for (let i = 0; i < rawRows.length - headerIdx - 1; i++) {
    const row = rawRows[headerIdx + 1 + i];
    if (!row || row.every((c) => c === null || c === undefined || c === "")) continue;
    const imeiNorm = normalizeImei(cellStr(row, 1));
    if (!imeiNorm) continue;
    lastByImei.set(imeiNorm, {
      imeiRaw: cellStr(row, 1) ?? imeiNorm,
      imeiNorm,
      ageDays: row[17] !== null ? cellNum(row, 17) : null,
      cost: parseCostBR(row[18]),
      reportDate: xlsxDateToISO(row[20]),
      sourceLine: headerIdx + 1 + i + 1,
      rawAge: row[17],
      rawCost: row[18],
      rawDate: row[20],
    });
  }

  const consolidated = Array.from(lastByImei.values());
  const rowsFound = (preview?.rowsFound ?? consolidated.length);

  const importRow = db
    .prepare(
      `INSERT INTO his_imports (filename, file_hash, status, rows_found, rows_linked, issues_count, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, 0, 0, ?)`,
    )
    .run(staged.filename, staged.fileHash, rowsFound, userId);
  const importId = Number(importRow.lastInsertRowid);

  let rowsInserted = 0;
  let rowsLinked = 0;

  try {
    const insertRow = db.prepare(
      `INSERT INTO his_import_rows
         (his_import_id, imei, imei_norm, audited_cost, age_days, report_date, source_line, raw_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findCase = db.prepare(
      `SELECT id FROM repair_cases WHERE imei_norm=? LIMIT 1`,
    );
    const linkCase = db.prepare(
      `UPDATE his_import_rows SET repair_case_id=?, link_method='IMEI' WHERE id=?`,
    );

    for (const r of consolidated) {
      const result = insertRow.run(
        importId,
        r.imeiRaw,
        r.imeiNorm,
        r.cost,
        r.ageDays,
        r.reportDate,
        r.sourceLine,
        JSON.stringify({ rawAge: r.rawAge, rawCost: r.rawCost, rawDate: r.rawDate }),
      );
      rowsInserted++;
      const rowId = Number(result.lastInsertRowid);
      const caseRow = findCase.get(r.imeiNorm) as { id: number } | undefined;
      if (caseRow) {
        linkCase.run(caseRow.id, rowId);
        rowsLinked++;
      }
    }

    db.prepare(
      `UPDATE his_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_found=?, rows_linked=?, issues_count=? WHERE id=?`,
    ).run(rowsFound, rowsLinked, 0, importId);

    confirmStaging(db, stagingId, importId);
    try {
      fs.unlinkSync(staged.stagedPath);
    } catch { /* ignore */ }

    return { rowsInserted, rowsLinked };
  } catch (err) {
    db.prepare(
      `UPDATE his_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);
    throw err;
  }
}

// ===========================================================================
// CARD 2 — REL SERIAIS (localização dos aparelhos)
// Arquivo: Rel_Estoque_de_Seriais (...).csv, sep=;
// Chave: Serial (não IMEI)
// ===========================================================================

export async function previewRelSeriais(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "rel_seriais_imports", fileHash);
  const stagingId = createStaging(db, "rel-seriais", filename, fileHash, filePath, fileSize, userId);

  const issues: ImportIssueRaw[] = [];

  try {
    // Streaming de CSV para performance em arquivo grande
    const { headers, rows, totalLines } = await readCsvStreaming(filePath, 200);

    const colSerial = colIdx(headers, "Serial");
    const colProduto = colIdx(headers, "Produto");
    const colDisponivel = colIdx(headers, "Disponivel", "Disponível");
    const colDeposito = colIdx(headers, "Deposito Atual", "Depósito Atual");
    const colFilialAtual = colIdx(headers, "Filial Atual");

    if (colSerial < 0) {
      throw new ImportCentralError(
        "MISSING_SERIAL_COL",
        `Coluna "Serial" não encontrada. Colunas presentes: ${headers.join(", ")}`,
      );
    }

    let rowsValid = 0;
    let skippedNoSerial = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const serialRaw = row[colSerial];
      const imeiNorm = normalizeImei(serialRaw);
      if (!imeiNorm) {
        skippedNoSerial++;
        continue;
      }
      rowsValid++;
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
      rowsValid,
      issues,
      previewRows: rows.slice(0, 5).map((row) => ({
        serial: row[colSerial],
        produto: colProduto >= 0 ? row[colProduto] : null,
        deposito: colDeposito >= 0 ? row[colDeposito] : null,
        filial: colFilialAtual >= 0 ? row[colFilialAtual] : null,
        disponivel: colDisponivel >= 0 ? row[colDisponivel] : null,
      })),
      extra: {
        colsFound: { serial: colSerial >= 0, produto: colProduto >= 0, deposito: colDeposito >= 0, filial: colFilialAtual >= 0 },
        skippedNoSerial,
        totalLines,
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
): Promise<{ rowsInserted: number }> {
  const staged = getStagedFile(db, stagingId);
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado.");

  const existingId = checkDuplicateHash(db, "rel_seriais_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const { headers, rows, totalLines } = await readCsvStreaming(staged.stagedPath, 0);

  const colSerial = colIdx(headers, "Serial");
  if (colSerial < 0)
    throw new ImportCentralError("MISSING_SERIAL_COL", 'Coluna "Serial" não encontrada.');

  const colProduto = colIdx(headers, "Produto");
  const colDescricao = colIdx(headers, "Descricao", "Descrição");
  const colCodComercial = colIdx(headers, "Codigo Comercial", "Código Comercial");
  const colFabricante = colIdx(headers, "Fabricante");
  const colDisponivel = colIdx(headers, "Disponivel", "Disponível");
  const colDeposito = colIdx(headers, "Deposito Atual", "Depósito Atual");
  const colFilialAtual = colIdx(headers, "Filial Atual");
  const colFilialEntrada = colIdx(headers, "Filial Entrada");
  const colRfid = colIdx(headers, "RFID");
  const colEan = colIdx(headers, "EAN");
  const colDias = colIdx(headers, "Dias em Estoque");

  const importRow = db
    .prepare(
      `INSERT INTO rel_seriais_imports (filename, file_hash, status, rows_found, rows_valid, issues_count, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, 0, 0, ?)`,
    )
    .run(staged.filename, staged.fileHash, totalLines, userId);
  const importId = Number(importRow.lastInsertRowid);

  let rowsInserted = 0;

  try {
    const insertRow = db.prepare(
      `INSERT INTO rel_seriais_rows
         (rel_seriais_import_id, imei_norm, serial, produto, descricao, codigo_comercial,
          fabricante, disponivel, deposito_atual, filial_atual, filial_entrada, rfid, ean, dias_estoque, raw_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const row of rows) {
      const serial = row[colSerial];
      const imeiNorm = normalizeImei(serial);
      if (!imeiNorm) continue;
      const diasRaw = colDias >= 0 ? row[colDias] : null;
      const dias = diasRaw ? parseInt(String(diasRaw), 10) : null;
      insertRow.run(
        importId,
        imeiNorm,
        String(serial).replace(/'/g, ""),
        colProduto >= 0 ? row[colProduto] : null,
        colDescricao >= 0 ? row[colDescricao] : null,
        colCodComercial >= 0 ? row[colCodComercial] : null,
        colFabricante >= 0 ? row[colFabricante] : null,
        colDisponivel >= 0 ? row[colDisponivel] : null,
        colDeposito >= 0 ? row[colDeposito] : null,
        colFilialAtual >= 0 ? row[colFilialAtual] : null,
        colFilialEntrada >= 0 ? row[colFilialEntrada] : null,
        colRfid >= 0 ? row[colRfid] : null,
        colEan >= 0 ? row[colEan] : null,
        isNaN(dias ?? NaN) ? null : dias,
        null, // raw_data_json omitted for performance
      );
      rowsInserted++;
    }

    db.prepare(
      `UPDATE rel_seriais_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_valid=? WHERE id=?`,
    ).run(rowsInserted, importId);

    confirmStaging(db, stagingId, importId);
    try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }

    return { rowsInserted };
  } catch (err) {
    db.prepare(
      `UPDATE rel_seriais_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helper: lê CSV em streaming (semioclon-separated, latin1)
// ---------------------------------------------------------------------------

async function readCsvStreaming(
  filePath: string,
  maxRows: number,
): Promise<{ headers: string[]; rows: string[][]; totalLines: number }> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "latin1" }),
      crlfDelay: Infinity,
    });
    let headers: string[] = [];
    const rows: string[][] = [];
    let lineNum = 0;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      const sep = headers.length === 0 && line.includes(";") ? ";" : headers.length === 0 ? "," : line.includes(";") ? ";" : ",";
      const parts = line.split(sep).map((p) => p.trim());
      if (lineNum === 0) {
        headers = parts;
      } else {
        if (maxRows === 0 || rows.length < maxRows) {
          rows.push(parts);
        }
      }
      lineNum++;
    });

    rl.on("close", () => resolve({ headers, rows, totalLines: lineNum - 1 }));
    rl.on("error", reject);
  });
}

// ===========================================================================
// CARD 3 — ANALISE MI (demandas de peças)
// Arquivo: ANALISE MI.xlsx, aba ANALISEMI (fallback: ANALISE)
// Chave: ID PEDIDO
// ===========================================================================

export async function previewAnaliseMi(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "analise_mi_imports", fileHash);
  const stagingId = createStaging(db, "analise-mi", filename, fileHash, filePath, fileSize, userId);

  try {
    // Descobre quais abas existem sem carregar dados
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    const targetSheet =
      allSheets.find((n) => normalizeHeader(n) === "ANALISEMI") ??
      allSheets.find((n) => normalizeHeader(n) === "ANALISE") ??
      null;

    if (!targetSheet)
      throw new ImportCentralError(
        "SHEET_NOT_FOUND",
        `Aba ANALISEMI não encontrada. Abas: ${allSheets.join(", ")}`,
      );

    const wb = XLSX.readFile(filePath, {
      sheets: [targetSheet],
      cellFormula: false,
      cellHTML: false,
    });
    const ws = wb.Sheets[targetSheet];
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (rawRows.length === 0)
      throw new ImportCentralError("EMPTY_SHEET", "Aba vazia.");

    const headers = (rawRows[0] as unknown[]).map((h) =>
      h === null ? "" : String(h),
    );

    const cIdPedido = colIdx(headers, "ID PEDIDO", "IDPEDIDO");
    const cImei = colIdx(headers, "IMEI");
    const cStatus = colIdx(headers, "STATUS");
    const cPeca = colIdx(headers, "PEÇASOLICITADA", "PECA SOLICITADA", "PECASOLICITADA");

    if (cIdPedido < 0)
      throw new ImportCentralError("MISSING_COL", `Coluna "ID PEDIDO" não encontrada.`);

    const issues: ImportIssueRaw[] = [];
    const statusCounts: Record<string, number> = {};
    let rowsValid = 0;
    let noId = 0;
    let noImei = 0;
    let duplicateIds = 0;
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

    if (noId > 0)
      issues.push({ row: null, severity: "WARNING", code: "NO_ID_PEDIDO", message: `${noId} linha(s) sem ID PEDIDO ignoradas.` });
    if (noImei > 0)
      issues.push({ row: null, severity: "INFO", code: "NO_IMEI", message: `${noImei} linha(s) sem IMEI válido (sem vínculo a aparelho).` });

    const preview: StagedPreview = {
      stagingId,
      source: "analise-mi",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: rawRows.length - 1,
      rowsValid,
      issues,
      previewRows: rawRows.slice(1, 6).map((row) => ({
        idPedido: cellStr(row as unknown[], cIdPedido),
        imei: cImei >= 0 ? cellStr(row as unknown[], cImei) : null,
        status: cStatus >= 0 ? cellStr(row as unknown[], cStatus) : null,
        peca: cPeca >= 0 ? cellStr(row as unknown[], cPeca) : null,
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
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado.");

  const existingId = checkDuplicateHash(db, "analise_mi_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const targetSheet =
    allSheets.find((n) => normalizeHeader(n) === "ANALISEMI") ??
    allSheets.find((n) => normalizeHeader(n) === "ANALISE") ??
    null;
  if (!targetSheet)
    throw new ImportCentralError("SHEET_NOT_FOUND", "Aba ANALISEMI não encontrada.");

  const wb = XLSX.readFile(staged.stagedPath, {
    sheets: [targetSheet],
    cellFormula: false,
    cellHTML: false,
  });
  const ws = wb.Sheets[targetSheet];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
  const cIdPedido = colIdx(headers, "ID PEDIDO", "IDPEDIDO");
  const cImei = colIdx(headers, "IMEI");
  const cOs = colIdx(headers, "OS");
  const cMarca = colIdx(headers, "MARCA");
  const cModelo = colIdx(headers, "MODELO");
  const cCor = colIdx(headers, "COR");
  const cPeca = colIdx(headers, "PEÇASOLICITADA", "PECA SOLICITADA", "PECASOLICITADA");
  const cCorPeca = colIdx(headers, "CORNAPEÇA", "COR NA PECA");
  const cConcat = colIdx(headers, "CONCATPEÇA", "CONCATPECA");
  const cDataPedido = colIdx(headers, "DATAPEDIDO", "DATA PEDIDO");
  const cStatus = colIdx(headers, "STATUS");
  const cDeposito = colIdx(headers, "DEPÓSITO", "DEPOSITO");
  const cDescricao = colIdx(headers, "DESCRIÇÃO", "DESCRICAO");
  const cRef = colIdx(headers, "REF");
  const cSolicitante = colIdx(headers, "SOLICITANTE");

  if (cIdPedido < 0)
    throw new ImportCentralError("MISSING_COL", "Coluna ID PEDIDO não encontrada.");

  const rowsFound = rawRows.length - 1;
  const importRow = db
    .prepare(
      `INSERT INTO analise_mi_imports (filename, file_hash, status, rows_found, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, ?)`,
    )
    .run(staged.filename, staged.fileHash, rowsFound, userId);
  const importId = Number(importRow.lastInsertRowid);

  let rowsInserted = 0;

  try {
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
      const imeiRaw = cImei >= 0 ? cellStr(row, cImei) : null;
      const imeiNorm = normalizeImei(imeiRaw);
      const datePedido = xlsxDateToISO(cDataPedido >= 0 ? row[cDataPedido] : null);

      insertRow.run(
        importId, idPedido,
        imeiRaw, imeiNorm,
        cOs >= 0 ? cellStr(row, cOs) : null,
        cMarca >= 0 ? cellStr(row, cMarca) : null,
        cModelo >= 0 ? cellStr(row, cModelo) : null,
        cCor >= 0 ? cellStr(row, cCor) : null,
        cPeca >= 0 ? cellStr(row, cPeca) : null,
        cCorPeca >= 0 ? cellStr(row, cCorPeca) : null,
        cConcat >= 0 ? cellStr(row, cConcat) : null,
        datePedido,
        cStatus >= 0 ? cellStr(row, cStatus) : null,
        cDeposito >= 0 ? cellStr(row, cDeposito) : null,
        cDescricao >= 0 ? cellStr(row, cDescricao) : null,
        cRef >= 0 ? cellStr(row, cRef) : null,
        cSolicitante >= 0 ? cellStr(row, cSolicitante) : null,
        null,
      );
      rowsInserted++;
    }

    db.prepare(
      `UPDATE analise_mi_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_valid=? WHERE id=?`,
    ).run(rowsInserted, importId);

    confirmStaging(db, stagingId, importId);
    try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }

    return { rowsInserted };
  } catch (err) {
    db.prepare(
      `UPDATE analise_mi_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);
    throw err;
  }
}

// ===========================================================================
// CARD 4 — PEDIDOS (reconciliação + BIPAGEM snapshot + PEACS catálogo)
// Arquivo: PEDIDOS.xlsx
// Abas: PEDIDOS | BIPAGEM DE PEÇAS | TABELA DE AVALIAÇÃO (PEACS)
// ===========================================================================

export async function previewPedidos(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "pedidos_imports", fileHash);
  const stagingId = createStaging(db, "pedidos", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];

    const sheetPedidos = allSheets.find((n) => normalizeHeader(n) === "PEDIDOS");
    const sheetBipagem = allSheets.find((n) => normalizeHeader(n).startsWith("BIPAGEM"));
    const sheetPeacs = allSheets.find((n) =>
      normalizeHeader(n).includes("AVALIA") && normalizeHeader(n).includes("PEACS"),
    ) ?? allSheets.find((n) => normalizeHeader(n).includes("PEACS"));

    if (!sheetPedidos)
      throw new ImportCentralError("SHEET_NOT_FOUND", `Aba PEDIDOS não encontrada. Abas: ${allSheets.join(", ")}`);
    if (!sheetBipagem)
      throw new ImportCentralError("SHEET_NOT_FOUND", `Aba "BIPAGEM DE PEÇAS" não encontrada.`);

    const sheetsToLoad = [sheetPedidos, sheetBipagem, ...(sheetPeacs ? [sheetPeacs] : [])];
    const wb = XLSX.readFile(filePath, {
      sheets: sheetsToLoad,
      cellFormula: false,
      cellHTML: false,
    });

    // Aba PEDIDOS
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

    // Aba BIPAGEM
    const wsBip = wb.Sheets[sheetBipagem];
    const rowsBip: unknown[][] = XLSX.utils.sheet_to_json(wsBip, { header: 1, defval: null });
    const hdrBip = (rowsBip[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cBipRef = colIdx(hdrBip, "REFERENCIA", "REFERÊNCIA");
    const bipRows = rowsBip.length - 1;
    // Refs únicas na BIPAGEM
    const bipRefs = new Set<string>();
    for (let i = 1; i < rowsBip.length; i++) {
      const r = rowsBip[i] as unknown[];
      if (r && cBipRef >= 0) {
        const ref = cellStr(r, cBipRef);
        if (ref) bipRefs.add(ref);
      }
    }

    // Aba PEACS
    let peacsFound = 0;
    let peacsValid = 0;
    if (sheetPeacs && wb.Sheets[sheetPeacs]) {
      const wsPeacs = wb.Sheets[sheetPeacs];
      const rowsPeacs: unknown[][] = XLSX.utils.sheet_to_json(wsPeacs, { header: 1, defval: null });
      const hdrPeacs = (rowsPeacs[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cPrice = colIdx(hdrPeacs, "TABELA SEMINOVO PRAZO");
      if (cPrice < 0) {
        // Warn: coluna TABELA SEMINOVO PRAZO não encontrada
      }
      peacsFound = rowsPeacs.length - 1;
      for (let i = 1; i < rowsPeacs.length; i++) {
        const r = rowsPeacs[i] as unknown[];
        if (r && cPrice >= 0 && parseCostBR(row_get(r, cPrice)) !== null) peacsValid++;
      }
    }

    const issues: ImportIssueRaw[] = [];
    if (!sheetPeacs)
      issues.push({ row: null, severity: "WARNING", code: "NO_PEACS_SHEET", message: "Aba PEACS não encontrada — catálogo não será importado." });

    const preview: StagedPreview = {
      stagingId,
      source: "pedidos",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: pedidosFound + bipRows + peacsFound,
      rowsValid: pedidosValid + bipRows + peacsValid,
      issues,
      previewRows: [],
      extra: {
        sheetsFound: { pedidos: sheetPedidos, bipagem: sheetBipagem, peacs: sheetPeacs ?? null },
        pedidosRows: pedidosFound,
        pedidosValid,
        bipagemRows: bipRows,
        bipagemRefsUnique: bipRefs.size,
        peacsRows: peacsFound,
        peacsValid,
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

function row_get(row: unknown[], idx: number): unknown {
  return idx >= 0 && idx < row.length ? row[idx] : null;
}

export function confirmPedidos(
  db: Db,
  stagingId: number,
  userId: number | null,
): { pedidosInserted: number; bipagemInserted: number; peacsInserted: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado.");

  const existingId = checkDuplicateHash(db, "pedidos_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const sheetPedidos = allSheets.find((n) => normalizeHeader(n) === "PEDIDOS")!;
  const sheetBipagem = allSheets.find((n) => normalizeHeader(n).startsWith("BIPAGEM"))!;
  const sheetPeacs = allSheets.find((n) =>
    normalizeHeader(n).includes("AVALIA") && normalizeHeader(n).includes("PEACS"),
  ) ?? allSheets.find((n) => normalizeHeader(n).includes("PEACS"));

  const sheetsToLoad = [sheetPedidos, sheetBipagem, ...(sheetPeacs ? [sheetPeacs] : [])];
  const wb = XLSX.readFile(staged.stagedPath, {
    sheets: sheetsToLoad,
    cellFormula: false,
    cellHTML: false,
  });

  // Conta linhas para o registro de importação
  const wsPed = wb.Sheets[sheetPedidos];
  const rowsPed: unknown[][] = XLSX.utils.sheet_to_json(wsPed, { header: 1, defval: null });
  const wsBip = wb.Sheets[sheetBipagem];
  const rowsBip: unknown[][] = XLSX.utils.sheet_to_json(wsBip, { header: 1, defval: null });

  let peacsRows: unknown[][] = [];
  if (sheetPeacs && wb.Sheets[sheetPeacs]) {
    peacsRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetPeacs], { header: 1, defval: null });
  }

  const importRow = db
    .prepare(
      `INSERT INTO pedidos_imports
         (filename, file_hash, status,
          pedidos_rows_found, bipagem_rows_found, bipagem_refs_unique, peacs_rows_found,
          issues_count, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, ?, 0, ?, 0, ?)`,
    )
    .run(
      staged.filename, staged.fileHash,
      rowsPed.length - 1,
      rowsBip.length - 1,
      peacsRows.length - 1,
      userId,
    );
  const importId = Number(importRow.lastInsertRowid);

  let pedidosInserted = 0;
  let bipagemInserted = 0;
  let peacsInserted = 0;

  try {
    // --- Aba PEDIDOS ---
    const hdrPed = (rowsPed[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cPedId = colIdx(hdrPed, "ID PEDIDO");
    const cPedImei = colIdx(hdrPed, "IMEI");
    const cPedOs = colIdx(hdrPed, "OS");
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
        cPedOs >= 0 ? cellStr(r, cPedOs) : null,
        cPedStatus >= 0 ? cellStr(r, cPedStatus) : null,
        cPedChave >= 0 ? cellStr(r, cPedChave) : null,
        cPedRef >= 0 ? cellStr(r, cPedRef) : null,
      );
      pedidosInserted++;
    }

    // --- Aba BIPAGEM ---
    const hdrBip = (rowsBip[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cRef = colIdx(hdrBip, "REFERENCIA", "REFERÊNCIA");
    const cDesc = colIdx(hdrBip, "DESCRIÇÃO", "DESCRICAO");
    const cForn = colIdx(hdrBip, "FORNECEDOR");
    const cChave = colIdx(hdrBip, "CHAVEPECA", "CHAVE PECA");
    const cBipStatus = colIdx(hdrBip, "STATUS");
    const cArrumar = colIdx(hdrBip, "ARRUMAR");
    const cIdPeca = colIdx(hdrBip, "ID_PECA_ESTOQUE", "IDPECAESTOQUE");
    const bipRefs = new Set<string>();

    const insertBip = db.prepare(
      `INSERT INTO pedidos_bipagem_rows
         (pedidos_import_id, referencia, referencia_corr, descricao, fornecedor,
          chave_peca, chave_peca_norm, status_src, id_peca_estoque)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i < rowsBip.length; i++) {
      const r = rowsBip[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const ref = cRef >= 0 ? cellStr(r, cRef) : null;
      const arrumar = cArrumar >= 0 ? cellStr(r, cArrumar) : null;
      const chave = cChave >= 0 ? cellStr(r, cChave) : null;
      if (ref) bipRefs.add(ref);
      insertBip.run(
        importId, ref,
        arrumar && arrumar !== ref ? arrumar : ref,
        cDesc >= 0 ? cellStr(r, cDesc) : null,
        cForn >= 0 ? cellStr(r, cForn) : null,
        chave,
        chave ? normalizeKey(chave) : null,
        cBipStatus >= 0 ? cellStr(r, cBipStatus) : null,
        cIdPeca >= 0 ? cellStr(r, cIdPeca) : null,
      );
      bipagemInserted++;
    }
    // Atualiza contagem de refs únicas
    db.prepare(`UPDATE pedidos_imports SET bipagem_refs_unique=? WHERE id=?`).run(bipRefs.size, importId);

    // --- Aba PEACS ---
    if (sheetPeacs && peacsRows.length > 1) {
      const hdrPeacs = (peacsRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cMarcaModelo = colIdx(hdrPeacs, "MARCA/MODELO");
      const cMarca = colIdx(hdrPeacs, "MARCA");
      const cFamilia = colIdx(hdrPeacs, "FAMÍLIA", "FAMILIA");
      const cMemoria = colIdx(hdrPeacs, "MEMÓRIA", "MEMORIA");
      const cPreco = colIdx(hdrPeacs, "TABELA SEMINOVO PRAZO");
      if (cPreco < 0)
        throw new ImportCentralError("MISSING_COL", `Coluna "TABELA SEMINOVO PRAZO" não encontrada.`);

      // Criar peacs_import vinculado a esta importação de pedidos
      const peacsImportRow = db
        .prepare(
          `INSERT INTO peacs_imports (filename, file_hash, status, rows_found, entries_matched, entries_unmatched, issues_count, created_by_user_id)
           VALUES (?, ?, 'PENDING', ?, 0, 0, 0, ?)`,
        )
        .run(staged.filename, staged.fileHash + "_peacs", peacsRows.length - 1, userId);
      const peacsImportId = Number(peacsImportRow.lastInsertRowid);

      // Transação atômica: desativa catálogo antigo E insere novo juntos
      const deactivate = db.prepare(`UPDATE peacs_catalog SET active=0 WHERE active=1`);
      const insertPeacs = db.prepare(
        `INSERT INTO peacs_catalog
           (peacs_import_id, brand, brand_norm, model, model_norm, capacity, capacity_norm, estimated_sale, raw_data_json, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );

      try {
        db.prepare("BEGIN").run();
        deactivate.run();
        for (let i = 1; i < peacsRows.length; i++) {
          const r = peacsRows[i] as unknown[];
          if (!r || r.every((c) => c === null)) continue;
          const marca = cMarca >= 0 ? cellStr(r, cMarca) : null;
          const familia = cFamilia >= 0 ? cellStr(r, cFamilia) : null;
          const memoria = cMemoria >= 0 ? cellStr(r, cMemoria) : null;
          const preco = parseCostBR(cPreco >= 0 ? r[cPreco] : null);
          if (!marca || preco === null) continue;
          const model = [familia, memoria].filter(Boolean).join(" ");
          insertPeacs.run(
            peacsImportId,
            marca, normalizeKey(marca),
            model, normalizeKey(model),
            memoria, memoria ? normalizeKey(memoria) : null,
            preco,
            JSON.stringify({ marcaModelo: cMarcaModelo >= 0 ? cellStr(r, cMarcaModelo) : null }),
          );
          peacsInserted++;
        }
        db.prepare(`UPDATE peacs_imports SET status='COMPLETED', finished_at=datetime('now'), entries_matched=? WHERE id=?`).run(peacsInserted, peacsImportId);
        db.prepare("COMMIT").run();
      } catch (e) {
        db.prepare("ROLLBACK").run();
        // catálogo anterior permanece ativo
        throw e;
      }
      db.prepare(`UPDATE pedidos_imports SET peacs_rows_found=? WHERE id=?`).run(peacsRows.length - 1, importId);
    }

    db.prepare(
      `UPDATE pedidos_imports SET status='COMPLETED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);

    confirmStaging(db, stagingId, importId);
    try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }

    return { pedidosInserted, bipagemInserted, peacsInserted };
  } catch (err) {
    db.prepare(
      `UPDATE pedidos_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);
    throw err;
  }
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
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "bkp_imports", fileHash);
  const stagingId = createStaging(db, "bkp", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];

    const sheetReparos = allSheets.find((n) => normalizeHeader(n) === "REPAROS TECNICOS");
    const sheetBaixa = allSheets.find((n) =>
      normalizeHeader(n).includes("BAIXA") && normalizeHeader(n).includes("PECA"),
    );
    const sheetTriagem = allSheets.find((n) => normalizeHeader(n) === "TRIAGEM ENTRADA");

    const issues: ImportIssueRaw[] = [];
    if (!sheetReparos) issues.push({ row: null, severity: "ERROR", code: "NO_REPAROS", message: "Aba REPAROS TECNICOS não encontrada." });
    if (!sheetBaixa) issues.push({ row: null, severity: "ERROR", code: "NO_BAIXA", message: "Aba BAIXA_DE_PEÇA não encontrada." });
    if (!sheetTriagem) issues.push({ row: null, severity: "WARNING", code: "NO_TRIAGEM", message: "Aba TRIAGEM ENTRADA não encontrada." });

    const sheetsToLoad = [sheetReparos, sheetBaixa, sheetTriagem].filter(Boolean) as string[];
    const wb = XLSX.readFile(filePath, {
      sheets: sheetsToLoad,
      cellFormula: false,
      cellHTML: false,
    });

    const countSheet = (name: string | undefined) => {
      if (!name || !wb.Sheets[name]) return 0;
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
      return Math.max(0, rows.length - 1);
    };

    const reparosCount = countSheet(sheetReparos);
    const baixaCount = countSheet(sheetBaixa);
    const triagemCount = countSheet(sheetTriagem);

    const preview: StagedPreview = {
      stagingId,
      source: "bkp",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: reparosCount + baixaCount + triagemCount,
      rowsValid: reparosCount + baixaCount + triagemCount,
      issues,
      previewRows: [],
      extra: {
        sheets: { reparos: sheetReparos ?? null, baixa: sheetBaixa ?? null, triagem: sheetTriagem ?? null },
        reparosCount,
        baixaCount,
        triagemCount,
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
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado.");

  const existingId = checkDuplicateHash(db, "bkp_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const sheetReparos = allSheets.find((n) => normalizeHeader(n) === "REPAROS TECNICOS");
  const sheetBaixa = allSheets.find((n) =>
    normalizeHeader(n).includes("BAIXA") && normalizeHeader(n).includes("PECA"),
  );
  const sheetTriagem = allSheets.find((n) => normalizeHeader(n) === "TRIAGEM ENTRADA");

  const sheetsToLoad = [sheetReparos, sheetBaixa, sheetTriagem].filter(Boolean) as string[];
  const wb = XLSX.readFile(staged.stagedPath, {
    sheets: sheetsToLoad,
    cellFormula: false,
    cellHTML: false,
  });

  const importRow = db
    .prepare(
      `INSERT INTO bkp_imports (filename, file_hash, status, rows_found, events_linked, events_unlinked, issues_count, created_by_user_id)
       VALUES (?, ?, 'PENDING', 0, 0, 0, 0, ?)`,
    )
    .run(staged.filename, staged.fileHash, userId);
  const importId = Number(importRow.lastInsertRowid);

  let reparosInserted = 0;
  let baixasInserted = 0;
  let triagemInserted = 0;

  try {
    // --- REPAROS TECNICOS ---
    if (sheetReparos && wb.Sheets[sheetReparos]) {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetReparos], { header: 1, defval: null });
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cId = colIdx(hdr, "ID");
      const cImei = colIdx(hdr, "IMEI");
      const cOs = colIdx(hdr, "OS");
      const cData = colIdx(hdr, "DATA");
      const cStatus = colIdx(hdr, "STATUS");
      const cPeca = colIdx(hdr, "PEÇA UTILIZADA", "PECA UTILIZADA");
      const cRef = colIdx(hdr, "REF");
      const cAssist = colIdx(hdr, "ASSISTÊNCIA", "ASSISTENCIA");
      const cTecnico = colIdx(hdr, "TÉCNICO RESPONSÁVEL", "TECNICO RESPONSAVEL");
      const cTipo = colIdx(hdr, "TIPO DE REPARO");

      const insertReparo = db.prepare(
        `INSERT OR IGNORE INTO systemic_repair_events
           (bkp_import_id, imei, imei_norm, os, os_norm, technician_name, repair_date,
            repair_type, part_used, reference_used, executed, assistance_code, raw_data_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const idVal = cId >= 0 ? cellStr(r, cId) : null;
        const imeiRaw = cImei >= 0 ? cellStr(r, cImei) : null;
        const imeiNorm = normalizeImei(imeiRaw);
        const osRaw = cOs >= 0 ? cellStr(r, cOs) : null;
        const osNorm = normalizeOs(osRaw);
        const ikey = idVal ?? `${imeiNorm ?? ""}|${osNorm ?? ""}|${i}`;
        const status = cStatus >= 0 ? cellStr(r, cStatus) : null;
        const result = insertReparo.run(
          importId, imeiRaw, imeiNorm, osRaw, osNorm,
          cTecnico >= 0 ? cellStr(r, cTecnico) : null,
          xlsxDateToISO(cData >= 0 ? r[cData] : null),
          cTipo >= 0 ? cellStr(r, cTipo) : null,
          cPeca >= 0 ? cellStr(r, cPeca) : null,
          cRef >= 0 ? cellStr(r, cRef) : null,
          status === "UTILIZADA" ? 1 : 0,
          cAssist >= 0 ? cellStr(r, cAssist) : null,
          null,
          ikey,
        );
        if (result.changes > 0) reparosInserted++;
      }
    }

    // --- BAIXA_DE_PEÇA ---
    if (sheetBaixa && wb.Sheets[sheetBaixa]) {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetBaixa], { header: 1, defval: null });
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cId = colIdx(hdr, "ID");
      const cImei = colIdx(hdr, "IMEI");
      const cRef = colIdx(hdr, "REF");
      const cStatus = colIdx(hdr, "STATUS");

      const insertBaixa = db.prepare(
        `INSERT OR IGNORE INTO systemic_part_writeoffs
           (bkp_import_id, imei, imei_norm, reference, reference_norm, writeoff_status, raw_data_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const idVal = cId >= 0 ? cellStr(r, cId) : null;
        const ref = cRef >= 0 ? cellStr(r, cRef) : null;
        const imeiRaw = cImei >= 0 ? cellStr(r, cImei) : null;
        const imeiNorm = normalizeImei(imeiRaw);
        const ikey = idVal && ref ? `${idVal}|${ref}` : `${imeiNorm ?? ""}|${ref ?? ""}|${i}`;
        const result = insertBaixa.run(
          importId, imeiRaw, imeiNorm, ref, ref ? normalizeKey(ref) : null,
          cStatus >= 0 ? cellStr(r, cStatus) : null,
          null,
          ikey,
        );
        if (result.changes > 0) baixasInserted++;
      }
    }

    // --- TRIAGEM ENTRADA ---
    if (sheetTriagem && wb.Sheets[sheetTriagem]) {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetTriagem], { header: 1, defval: null });
      const hdr = (rows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
      const cId = colIdx(hdr, "ID");
      const cOsSh = colIdx(hdr, "OS SH");
      const cImei1 = colIdx(hdr, "IMEI 1");
      const cMarca = colIdx(hdr, "MARCA");
      const cModelo = colIdx(hdr, "MODELO");
      const cCor = colIdx(hdr, "COR");
      const cCap = colIdx(hdr, "CAPACIDADE");
      const cData = colIdx(hdr, "DATA TRIAGEM");
      const cOrigem = colIdx(hdr, "ORIGEM");
      const cDestino = colIdx(hdr, "DESTINO");
      const cRef = colIdx(hdr, "REF");
      const cTriador = colIdx(hdr, "TRIADOR");

      const insertTriagem = db.prepare(
        `INSERT OR IGNORE INTO device_location_snapshots
           (bkp_import_id, imei, imei_norm, os, os_norm, location, snapshot_date, raw_data_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.every((c) => c === null)) continue;
        const idVal = cId >= 0 ? cellStr(r, cId) : null;
        const osSh = cOsSh >= 0 ? cellStr(r, cOsSh) : null;
        const imei1 = cImei1 >= 0 ? cellStr(r, cImei1) : null;
        const imeiNorm = normalizeImei(imei1);
        const ikey = idVal ?? `${imeiNorm ?? ""}|${osSh ?? ""}|${i}`;
        const result = insertTriagem.run(
          importId, imei1, imeiNorm,
          osSh, normalizeOs(osSh),
          cDestino >= 0 ? cellStr(r, cDestino) : null,
          xlsxDateToISO(cData >= 0 ? r[cData] : null),
          JSON.stringify({
            marca: cMarca >= 0 ? cellStr(r, cMarca) : null,
            modelo: cModelo >= 0 ? cellStr(r, cModelo) : null,
            cor: cCor >= 0 ? cellStr(r, cCor) : null,
            capacidade: cCap >= 0 ? cellStr(r, cCap) : null,
            origem: cOrigem >= 0 ? cellStr(r, cOrigem) : null,
            ref: cRef >= 0 ? cellStr(r, cRef) : null,
            triador: cTriador >= 0 ? cellStr(r, cTriador) : null,
          }),
          ikey,
        );
        if (result.changes > 0) triagemInserted++;
      }
    }

    const totalRows = reparosInserted + baixasInserted + triagemInserted;
    db.prepare(
      `UPDATE bkp_imports SET status='COMPLETED', finished_at=datetime('now'), rows_found=?,
         events_linked=0, events_unlinked=?, sheets_processed=? WHERE id=?`,
    ).run(
      totalRows, totalRows,
      JSON.stringify([sheetReparos, sheetBaixa, sheetTriagem].filter(Boolean)),
      importId,
    );

    confirmStaging(db, stagingId, importId);
    try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }

    return { reparosInserted, baixasInserted, triagemInserted };
  } catch (err) {
    db.prepare(`UPDATE bkp_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`).run(importId);
    throw err;
  }
}

// ===========================================================================
// CARD 6 — TRIAGEM DE SAÍDA
// Arquivo: TRIAGEM SAIDA.xlsx, aba "triagem saida"
// Chave: CONCAT
// ===========================================================================

export async function previewTriagemSaida(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "triagem_saida_imports", fileHash);
  const stagingId = createStaging(db, "triagem-saida", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    const targetSheet = allSheets.find((n) =>
      normalizeHeader(n) === "TRIAGEM SAIDA" || normalizeHeader(n).includes("TRIAGEM") && normalizeHeader(n).includes("SAIDA"),
    );

    if (!targetSheet)
      throw new ImportCentralError(
        "SHEET_NOT_FOUND",
        `Aba "triagem saida" não encontrada. Abas: ${allSheets.join(", ")}`,
      );

    const wb = XLSX.readFile(filePath, {
      sheets: [targetSheet],
      cellFormula: false,
      cellHTML: false,
    });
    const ws = wb.Sheets[targetSheet];
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));

    const cConcat = colIdx(headers, "CONCAT");
    const cRepEfetivo = colIdx(headers, "REPARO EFETIVO");
    const cMotivo = colIdx(headers, "MOTIVO");
    const cImei = colIdx(headers, "IMEI");

    const issues: ImportIssueRaw[] = [];
    let sim = 0, nao = 0, semValor = 0, duplicateConcat = 0, semImei = 0, motivoAusente = 0;
    const seenConcat = new Set<string>();

    for (let i = 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const concat = cConcat >= 0 ? cellStr(r, cConcat) : null;
      const efetivo = cRepEfetivo >= 0 ? cellStr(r, cRepEfetivo) : null;
      const motivo = cMotivo >= 0 ? cellStr(r, cMotivo) : null;
      const imei = cImei >= 0 ? cellStr(r, cImei) : null;
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
      issues.push({ row: null, severity: "WARNING", code: "MOTIVO_ABSENT", message: `${motivoAusente} linha(s) com REPARO EFETIVO=NÃO sem motivo preenchido.` });
    if (duplicateConcat > 0)
      issues.push({ row: null, severity: "INFO", code: "DUPLICATE_CONCAT", message: `${duplicateConcat} CONCAT duplicado(s).` });

    const preview: StagedPreview = {
      stagingId,
      source: "triagem-saida",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: rawRows.length - 1,
      rowsValid: rawRows.length - 1 - semImei,
      issues,
      previewRows: rawRows.slice(1, 6).map((r) => ({
        concat: cConcat >= 0 ? cellStr(r as unknown[], cConcat) : null,
        imei: cImei >= 0 ? cellStr(r as unknown[], cImei) : null,
        efetivo: cRepEfetivo >= 0 ? cellStr(r as unknown[], cRepEfetivo) : null,
        motivo: cMotivo >= 0 ? cellStr(r as unknown[], cMotivo) : null,
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
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado.");

  const existingId = checkDuplicateHash(db, "triagem_saida_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const targetSheet = allSheets.find((n) =>
    normalizeHeader(n) === "TRIAGEM SAIDA" || (normalizeHeader(n).includes("TRIAGEM") && normalizeHeader(n).includes("SAIDA")),
  )!;
  if (!targetSheet)
    throw new ImportCentralError("SHEET_NOT_FOUND", "Aba triagem saida não encontrada.");

  const wb = XLSX.readFile(staged.stagedPath, {
    sheets: [targetSheet],
    cellFormula: false,
    cellHTML: false,
  });
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });
  const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));

  const cConcat = colIdx(headers, "CONCAT");
  const cOs = colIdx(headers, "OS");
  const cImei = colIdx(headers, "IMEI");
  const cApsn = colIdx(headers, "APSN");
  const cMarca = colIdx(headers, "MARCA");
  const cModelo = colIdx(headers, "MODELO");
  const cDataReparo = colIdx(headers, "DATA REPARO");
  const cDataTriagem = colIdx(headers, "DATA TRIAGEM");
  const cManutencao = colIdx(headers, "MANUTEÇÃO EXECUTADA", "MANUTENÇÃO EXECUTADA", "MANUTECAO EXECUTADA", "MANUTENCAO EXECUTADA");
  const cTipo = colIdx(headers, "TIPO DE REPARO");
  const cTecnico = colIdx(headers, "TÉCNICO RESPONSÁVEL", "TECNICO RESPONSAVEL");
  const cEstDest = colIdx(headers, "ESTOQUE DESTINO");
  const cRepEfetivo = colIdx(headers, "REPARO EFETIVO");
  const cMotivo = colIdx(headers, "MOTIVO");
  const cAssist = colIdx(headers, "ASSISTÊNCIA", "ASSISTENCIA");
  const cTriador = colIdx(headers, "TRIADOR");

  const importRow = db
    .prepare(
      `INSERT INTO triagem_saida_imports
         (filename, file_hash, status, rows_found, rows_linked, rows_unlinked, issues_count, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, 0, 0, 0, ?)`,
    )
    .run(staged.filename, staged.fileHash, rawRows.length - 1, userId);
  const importId = Number(importRow.lastInsertRowid);

  let rowsInserted = 0;

  try {
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
      const imeiRaw = cImei >= 0 ? cellStr(r, cImei) : null;
      const imeiNorm = normalizeImei(imeiRaw);
      const osRaw = cOs >= 0 ? cellStr(r, cOs) : null;
      const efetivo = cRepEfetivo >= 0 ? cellStr(r, cRepEfetivo) : null;
      insertRow.run(
        importId, imeiRaw, imeiNorm,
        osRaw, normalizeOs(osRaw),
        cConcat >= 0 ? cellStr(r, cConcat) : null,
        cApsn >= 0 ? cellStr(r, cApsn) : null,
        cMarca >= 0 ? cellStr(r, cMarca) : null,
        cModelo >= 0 ? cellStr(r, cModelo) : null,
        xlsxDateToISO(cDataReparo >= 0 ? r[cDataReparo] : null),
        xlsxDateToISO(cDataTriagem >= 0 ? r[cDataTriagem] : null),
        cManutencao >= 0 ? cellStr(r, cManutencao) : null,
        cTipo >= 0 ? cellStr(r, cTipo) : null,
        cTecnico >= 0 ? cellStr(r, cTecnico) : null,
        cEstDest >= 0 ? cellStr(r, cEstDest) : null,
        efetivo,
        cMotivo >= 0 ? cellStr(r, cMotivo) : null,
        cAssist >= 0 ? cellStr(r, cAssist) : null,
        cTriador >= 0 ? cellStr(r, cTriador) : null,
        cEstDest >= 0 ? cellStr(r, cEstDest) : null,
        null,
      );
      rowsInserted++;
    }

    db.prepare(
      `UPDATE triagem_saida_imports SET status='COMPLETED', finished_at=datetime('now'),
         rows_found=?, rows_unlinked=? WHERE id=?`,
    ).run(rowsInserted, rowsInserted, importId);

    confirmStaging(db, stagingId, importId);
    try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }

    return { rowsInserted };
  } catch (err) {
    db.prepare(
      `UPDATE triagem_saida_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);
    throw err;
  }
}

// ===========================================================================
// CARD 7 — SH CATÁLOGO (itens de peças)
// Arquivo: sH.xlsx, aba "sH"
// Chave: CODIGO
// ===========================================================================

export async function previewSh(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<StagedPreview> {
  const fileHash = hashFile(filePath);
  const fileSize = fs.statSync(filePath).size;
  const existingId = checkDuplicateHash(db, "sh_catalog_imports", fileHash);
  const stagingId = createStaging(db, "sh", filename, fileHash, filePath, fileSize, userId);

  try {
    const wbMeta = XLSX.readFile(filePath, { bookSheets: true });
    const allSheets: string[] = wbMeta.SheetNames ?? [];
    // Aceita qualquer aba que tenha o arquivo, preferencialmente "sH"
    const targetSheet = allSheets.find((n) => normalizeHeader(n) === "SH") ?? allSheets[0];

    if (!targetSheet)
      throw new ImportCentralError("EMPTY_FILE", "Arquivo sem abas.");

    const wb = XLSX.readFile(filePath, {
      sheets: [targetSheet],
      cellFormula: false,
      cellHTML: false,
    });
    const ws = wb.Sheets[targetSheet];
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (rawRows.length === 0)
      throw new ImportCentralError("EMPTY_SHEET", "Aba vazia.");

    const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));
    const cCodigo = colIdx(headers, "CODIGO", "CÓDIGO");
    const cNome = colIdx(headers, "NOME");
    const cGrupo = colIdx(headers, "GRUPO");
    const cEstoque = colIdx(headers, "ESTOQUE_DISP", "ESTOQUE DISP");

    const issues: ImportIssueRaw[] = [];

    // Detecta se é catálogo de peças (tem NOME/GRUPO) ou ordens de serviço (tem DEFEITO/SERIE)
    const hasNome = cNome >= 0;
    const hasGrupo = cGrupo >= 0;
    const hasDefect = headers.some((h) => normalizeHeader(h) === "DEFEITO");
    const hasSerie = headers.some((h) => normalizeHeader(h) === "SERIE");

    if (!hasNome && (hasDefect || hasSerie)) {
      issues.push({
        row: null, severity: "WARNING", code: "FORMAT_OS",
        message: `Arquivo parece ser de ordens de serviço (tem DEFEITO/SERIE), não catálogo de peças (esperado: NOME, GRUPO). Colunas encontradas: ${headers.filter(h => h).join(", ")}`,
      });
    }

    if (cCodigo < 0) {
      throw new ImportCentralError(
        "MISSING_COL",
        `Coluna CODIGO não encontrada. Colunas: ${headers.filter(h => h).join(", ")}`,
      );
    }

    let rowsValid = 0;
    let noCodigo = 0;
    for (let i = 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      if (!cellStr(r, cCodigo)) { noCodigo++; continue; }
      rowsValid++;
    }

    const preview: StagedPreview = {
      stagingId,
      source: "sh",
      filename,
      fileHash,
      fileSize,
      status: "PREVIEW_READY",
      alreadyImported: !!existingId,
      existingImportId: existingId,
      rowsFound: rawRows.length - 1,
      rowsValid,
      issues,
      previewRows: rawRows.slice(1, 6).map((r) => ({
        codigo: cellStr(r as unknown[], cCodigo),
        nome: cNome >= 0 ? cellStr(r as unknown[], cNome) : null,
        grupo: cGrupo >= 0 ? cellStr(r as unknown[], cGrupo) : null,
        estoque: cEstoque >= 0 ? cellStr(r as unknown[], cEstoque) : null,
      })),
      extra: { sheetUsed: targetSheet, noCodigo, hasNome, hasGrupo, formatWarning: !hasNome },
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
): { rowsInserted: number } {
  const staged = getStagedFile(db, stagingId);
  if (!staged) throw new ImportCentralError("NOT_FOUND", "Staging não encontrado.");
  if (staged.status !== "PREVIEW_READY")
    throw new ImportCentralError("NOT_READY", "Preview não pronto.");
  if (!fs.existsSync(staged.stagedPath))
    throw new ImportCentralError("FILE_GONE", "Arquivo temporário não encontrado.");

  const existingId = checkDuplicateHash(db, "sh_catalog_imports", staged.fileHash);
  if (existingId) throw new ImportCentralError("ALREADY_IMPORTED", "Arquivo já importado.");

  const wbMeta = XLSX.readFile(staged.stagedPath, { bookSheets: true });
  const allSheets: string[] = wbMeta.SheetNames ?? [];
  const targetSheet = allSheets.find((n) => normalizeHeader(n) === "SH") ?? allSheets[0];
  if (!targetSheet)
    throw new ImportCentralError("EMPTY_FILE", "Arquivo sem abas.");

  const wb = XLSX.readFile(staged.stagedPath, {
    sheets: [targetSheet],
    cellFormula: false,
    cellHTML: false,
  });
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { header: 1, defval: null });
  const headers = (rawRows[0] as unknown[]).map((h) => (h === null ? "" : String(h)));

  const cCodigo = colIdx(headers, "CODIGO", "CÓDIGO");
  const cNumero = colIdx(headers, "NUMERO", "NÚMERO");
  const cNome = colIdx(headers, "NOME");
  const cNomecurto = colIdx(headers, "NOMECURTO", "NOME CURTO");
  const cGrupo = colIdx(headers, "GRUPO");
  const cSubgrupo = colIdx(headers, "SUBGRUPO");
  const cFabricante = colIdx(headers, "FABRICANTE");
  const cEstoque = colIdx(headers, "ESTOQUE_DISP", "ESTOQUE DISP");
  const cCusto = colIdx(headers, "CUSTO");
  const cVenda = colIdx(headers, "VENDA");
  const cFornecedor = colIdx(headers, "FORNECEDOR");
  const cLocal = colIdx(headers, "LOCAL");
  const cGaveta = colIdx(headers, "GAVETA");
  const cArquivado = colIdx(headers, "ARQUIVADO");
  const cGtin = colIdx(headers, "GTIN");
  const cUsaSerial = colIdx(headers, "USA_SERIAL", "USA SERIAL");

  if (cCodigo < 0)
    throw new ImportCentralError("MISSING_COL", "Coluna CODIGO não encontrada.");

  const rowsFound = rawRows.length - 1;
  const importRow = db
    .prepare(
      `INSERT INTO sh_catalog_imports (filename, file_hash, status, rows_found, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, ?)`,
    )
    .run(staged.filename, staged.fileHash, rowsFound, userId);
  const importId = Number(importRow.lastInsertRowid);

  let rowsInserted = 0;

  try {
    const insertRow = db.prepare(
      `INSERT INTO sh_catalog_rows
         (sh_catalog_import_id, codigo, numero, nome, nomecurto, grupo, subgrupo,
          fabricante, estoque_disp, custo, venda, fornecedor, local, gaveta,
          arquivado, gtin, usa_serial, raw_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let i = 1; i < rawRows.length; i++) {
      const r = rawRows[i] as unknown[];
      if (!r || r.every((c) => c === null)) continue;
      const codigo = cellStr(r, cCodigo);
      if (!codigo) continue;
      insertRow.run(
        importId, codigo,
        cNumero >= 0 ? cellStr(r, cNumero) : null,
        cNome >= 0 ? cellStr(r, cNome) : null,
        cNomecurto >= 0 ? cellStr(r, cNomecurto) : null,
        cGrupo >= 0 ? cellStr(r, cGrupo) : null,
        cSubgrupo >= 0 ? cellStr(r, cSubgrupo) : null,
        cFabricante >= 0 ? cellStr(r, cFabricante) : null,
        cEstoque >= 0 ? parseCostBR(r[cEstoque]) : null,
        cCusto >= 0 ? parseCostBR(r[cCusto]) : null,
        cVenda >= 0 ? parseCostBR(r[cVenda]) : null,
        cFornecedor >= 0 ? cellStr(r, cFornecedor) : null,
        cLocal >= 0 ? cellStr(r, cLocal) : null,
        cGaveta >= 0 ? cellStr(r, cGaveta) : null,
        cArquivado >= 0 ? cellStr(r, cArquivado) : null,
        cGtin >= 0 ? cellStr(r, cGtin) : null,
        cUsaSerial >= 0 ? cellStr(r, cUsaSerial) : null,
        null,
      );
      rowsInserted++;
    }

    db.prepare(
      `UPDATE sh_catalog_imports SET status='COMPLETED', finished_at=datetime('now'), rows_valid=? WHERE id=?`,
    ).run(rowsInserted, importId);

    confirmStaging(db, stagingId, importId);
    try { fs.unlinkSync(staged.stagedPath); } catch { /* ignore */ }

    return { rowsInserted };
  } catch (err) {
    db.prepare(
      `UPDATE sh_catalog_imports SET status='FAILED', finished_at=datetime('now') WHERE id=?`,
    ).run(importId);
    throw err;
  }
}
