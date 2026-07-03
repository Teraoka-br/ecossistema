/**
 * Central de Dados — serviços de importação por fonte.
 *
 * Cada fonte tem um fluxo preview → confirm (idempotente por hash de arquivo).
 * As fontes legado (ANALISE MI, PEDIDOS) são somente leitura via import_batches.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSX = _require("xlsx") as any;

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class ImportCentralError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ImportCentralError";
  }
}

// ---------------------------------------------------------------------------
// Tipos compartilhados
// ---------------------------------------------------------------------------

export type SourceKey =
  | "rel-seriais"
  | "sh"
  | "his"
  | "bkp"
  | "triagem-saida"
  | "peacs";

export interface ImportIssueRaw {
  row: number | null;
  severity: "ERROR" | "WARNING" | "INFO";
  code: string;
  message: string;
  rawValue?: string | null;
}

export interface SourcePreviewResult {
  importId: number;
  source: SourceKey;
  filename: string;
  fileHash: string;
  rowsFound: number;
  rowsValid: number;
  issues: ImportIssueRaw[];
  alreadyImported: boolean;
  existingImportId: number | null;
  previewRows: Record<string, unknown>[];
}

export interface ImportHistoryEntry {
  id: number;
  filename: string;
  fileHash: string;
  status: string;
  rowsFound: number;
  rowsLinked?: number;
  rowsUnlinked?: number;
  rowsValid?: number;
  issuesCount: number;
  createdAt: string;
  finishedAt: string | null;
  createdByName?: string | null;
}

export interface AllSourcesStatus {
  "rel-seriais": SourceStatus;
  sh: SourceStatus;
  his: SourceStatus;
  bkp: SourceStatus;
  "triagem-saida": SourceStatus;
  peacs: SourceStatus;
  legado: SourceStatus;
}

export interface SourceStatus {
  lastImportId: number | null;
  lastImportAt: string | null;
  lastStatus: string | null;
  totalImports: number;
  lastRowsFound: number;
  lastIssuesCount: number;
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

export function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function parseCostBR(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[R$\s]/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function normalizeImei(imei: unknown): string | null {
  if (!imei) return null;
  const s = String(imei).replace(/\D/g, "").trim();
  return s.length >= 10 ? s : null;
}

function findColumn(header: string[], candidates: string[]): string | null {
  const norm = (s: string) => s.trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const c of candidates) {
    const found = header.find(h => norm(h) === norm(c));
    if (found !== undefined) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status geral de todas as fontes
// ---------------------------------------------------------------------------

export function getAllSourcesStatus(db: Db): AllSourcesStatus {
  function statusFor(table: string): SourceStatus {
    try {
      const row = db.prepare(`
        SELECT id, created_at, status,
               COALESCE(rows_found, 0) AS rows_found,
               COALESCE(issues_count, 0) AS issues_count
        FROM ${table}
        WHERE status NOT IN ('FAILED','CANCELLED')
        ORDER BY id DESC LIMIT 1
      `).get() as { id: number; created_at: string; status: string; rows_found: number; issues_count: number } | undefined;

      const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

      if (!row) return { lastImportId: null, lastImportAt: null, lastStatus: null, totalImports: total, lastRowsFound: 0, lastIssuesCount: 0 };

      return {
        lastImportId: row.id,
        lastImportAt: row.created_at,
        lastStatus: row.status,
        totalImports: total,
        lastRowsFound: row.rows_found,
        lastIssuesCount: row.issues_count,
      };
    } catch {
      return { lastImportId: null, lastImportAt: null, lastStatus: null, totalImports: 0, lastRowsFound: 0, lastIssuesCount: 0 };
    }
  }

  // Legado: usa import_batches (inicialização única)
  const legadoRow = db.prepare(`
    SELECT id, created_at, status, orders_found, inventory_found, warnings_count
    FROM import_batches WHERE status = 'COMPLETED_WITH_WARNINGS' OR status = 'COMPLETED'
    ORDER BY id DESC LIMIT 1
  `).get() as { id: number; created_at: string; status: string; orders_found: number; inventory_found: number; warnings_count: number } | undefined;

  const legadoTotal = (db.prepare("SELECT COUNT(*) AS c FROM import_batches").get() as { c: number }).c;
  const legadoStatus: SourceStatus = legadoRow
    ? {
        lastImportId: legadoRow.id,
        lastImportAt: legadoRow.created_at,
        lastStatus: legadoRow.status,
        totalImports: legadoTotal,
        lastRowsFound: (legadoRow.orders_found ?? 0) + (legadoRow.inventory_found ?? 0),
        lastIssuesCount: legadoRow.warnings_count ?? 0,
      }
    : { lastImportId: null, lastImportAt: null, lastStatus: null, totalImports: legadoTotal, lastRowsFound: 0, lastIssuesCount: 0 };

  return {
    "rel-seriais": statusFor("rel_seriais_imports"),
    sh: statusFor("sh_imports"),
    his: statusFor("his_imports"),
    bkp: statusFor("bkp_imports"),
    "triagem-saida": statusFor("triagem_saida_imports"),
    peacs: statusFor("peacs_imports"),
    legado: legadoStatus,
  };
}

// ---------------------------------------------------------------------------
// History per source
// ---------------------------------------------------------------------------

export function getSourceHistory(db: Db, source: SourceKey): ImportHistoryEntry[] {
  const tables: Record<SourceKey, string> = {
    "rel-seriais": "rel_seriais_imports",
    sh: "sh_imports",
    his: "his_imports",
    bkp: "bkp_imports",
    "triagem-saida": "triagem_saida_imports",
    peacs: "peacs_imports",
  };
  const table = tables[source];

  const rows = db.prepare(`
    SELECT i.*, u.display_name AS created_by_name
    FROM ${table} i
    LEFT JOIN users u ON u.id = i.created_by_user_id
    ORDER BY i.id DESC LIMIT 50
  `).all() as Record<string, unknown>[];

  return rows.map(r => ({
    id: r["id"] as number,
    filename: r["filename"] as string,
    fileHash: r["file_hash"] as string,
    status: r["status"] as string,
    rowsFound: (r["rows_found"] as number) ?? 0,
    rowsLinked: (r["rows_linked"] as number | undefined) ?? undefined,
    rowsUnlinked: (r["rows_unlinked"] as number | undefined) ?? undefined,
    rowsValid: (r["rows_valid"] as number | undefined) ?? undefined,
    issuesCount: (r["issues_count"] as number) ?? 0,
    createdAt: r["created_at"] as string,
    finishedAt: (r["finished_at"] as string | null) ?? null,
    createdByName: (r["created_by_name"] as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Cancel / delete a pending import
// ---------------------------------------------------------------------------

export function cancelImport(db: Db, source: SourceKey, importId: number, _userId: number): void {
  const tables: Record<SourceKey, string> = {
    "rel-seriais": "rel_seriais_imports",
    sh: "sh_imports",
    his: "his_imports",
    bkp: "bkp_imports",
    "triagem-saida": "triagem_saida_imports",
    peacs: "peacs_imports",
  };
  const table = tables[source];

  const row = db.prepare(`SELECT id, status FROM ${table} WHERE id = ?`).get(importId) as { id: number; status: string } | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row.status === "COMPLETED") throw new ImportCentralError("ALREADY_COMPLETED", "Não é possível cancelar uma importação já concluída.");
  if (row.status === "CANCELLED") return; // idempotente

  db.prepare(`UPDATE ${table} SET status = 'CANCELLED', finished_at = datetime('now') WHERE id = ?`).run(importId);
}

// ---------------------------------------------------------------------------
// REL SERIAIS — CSV: IMEI;TÉCNICO;IDADE;CUSTO
// ---------------------------------------------------------------------------

export async function previewRelSeriais(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<SourcePreviewResult> {
  const fileHash = hashFile(filePath);

  // Idempotência: mesmo hash já importado?
  const existing = db.prepare(
    "SELECT id FROM rel_seriais_imports WHERE file_hash = ? AND status NOT IN ('FAILED','CANCELLED')"
  ).get(fileHash) as { id: number } | undefined;

  if (existing) {
    return {
      importId: existing.id,
      source: "rel-seriais",
      filename,
      fileHash,
      rowsFound: 0,
      rowsValid: 0,
      issues: [{ row: null, severity: "WARNING", code: "ALREADY_IMPORTED", message: "Este arquivo já foi importado anteriormente." }],
      alreadyImported: true,
      existingImportId: existing.id,
      previewRows: [],
    };
  }

  const content = fs.readFileSync(filePath, "latin1");
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    throw new ImportCentralError("EMPTY_FILE", "Arquivo CSV vazio ou sem dados.");
  }

  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep).map(h => h.trim().replace(/^﻿/, ""));

  const imeiCol = findColumn(header, ["IMEI", "Imei", "imei"]);
  const tecCol  = findColumn(header, ["TÉCNICO", "TECNICO", "Técnico", "Tecnico"]);
  const idadeCol = findColumn(header, ["IDADE", "Idade", "idade", "AGE"]);
  const custoCol = findColumn(header, ["CUSTO", "Custo", "custo", "COST"]);

  const issues: ImportIssueRaw[] = [];
  if (!imeiCol) issues.push({ row: null, severity: "ERROR", code: "COL_IMEI_MISSING", message: "Coluna IMEI não encontrada." });
  if (!tecCol)  issues.push({ row: null, severity: "WARNING", code: "COL_TEC_MISSING", message: "Coluna TÉCNICO não encontrada." });
  if (!idadeCol) issues.push({ row: null, severity: "WARNING", code: "COL_IDADE_MISSING", message: "Coluna IDADE não encontrada." });
  if (!custoCol) issues.push({ row: null, severity: "WARNING", code: "COL_CUSTO_MISSING", message: "Coluna CUSTO não encontrada." });

  if (!imeiCol) {
    throw new ImportCentralError("MISSING_COLUMNS", "Coluna obrigatória IMEI não encontrada. Verifique se o arquivo é Rel_Estoque_de_Seriais.");
  }

  const previewRows: Record<string, unknown>[] = [];
  let rowsValid = 0;

  for (let i = 1; i < Math.min(lines.length, 6); i++) {
    const cols = lines[i].split(sep);
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = (cols[idx] ?? "").trim(); });
    previewRows.push(obj);
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = (cols[idx] ?? "").trim(); });
    const imeiRaw = imeiCol ? obj[imeiCol] : null;
    const imeiNorm = normalizeImei(imeiRaw);
    if (!imeiNorm) {
      issues.push({ row: i + 1, severity: "WARNING", code: "IMEI_INVALID", message: `IMEI inválido: "${imeiRaw}"`, rawValue: imeiRaw ?? undefined });
    } else {
      rowsValid++;
    }
  }

  const importRow = db.prepare(`
    INSERT INTO rel_seriais_imports (filename, file_hash, status, rows_found, rows_valid, issues_count, created_by_user_id)
    VALUES (?, ?, 'PENDING', ?, ?, ?, ?)
  `).run(filename, fileHash, lines.length - 1, rowsValid, issues.length, userId);

  return {
    importId: importRow.lastInsertRowid as number,
    source: "rel-seriais",
    filename,
    fileHash,
    rowsFound: lines.length - 1,
    rowsValid,
    issues,
    alreadyImported: false,
    existingImportId: null,
    previewRows,
  };
}

export function confirmRelSeriais(db: Db, importId: number, filePath: string, _userId: number | null): { rowsInserted: number } {
  const row = db.prepare("SELECT * FROM rel_seriais_imports WHERE id = ?").get(importId) as Record<string, unknown> | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row["status"] === "COMPLETED") throw new ImportCentralError("ALREADY_IMPORTED", "Importação já concluída.");
  if (row["status"] === "CANCELLED") throw new ImportCentralError("CANCELLED", "Importação cancelada.");

  const content = fs.readFileSync(filePath, "latin1");
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep).map(h => h.trim());

  const imeiCol  = findColumn(header, ["IMEI", "Imei", "imei"]);
  const tecCol   = findColumn(header, ["TÉCNICO", "TECNICO", "Técnico", "Tecnico"]);
  const idadeCol = findColumn(header, ["IDADE", "Idade", "idade"]);
  const custoCol = findColumn(header, ["CUSTO", "Custo", "custo"]);

  const insert = db.prepare(`
    INSERT INTO rel_seriais_rows (rel_seriais_import_id, imei, imei_norm, technician_name, age_days, cost, raw_data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const linkCase = db.prepare("SELECT id FROM repair_cases WHERE imei_norm = ? LIMIT 1");
  const updateLink = db.prepare("UPDATE rel_seriais_rows SET repair_case_id = ? WHERE id = ?");

  let rowsInserted = 0;

  db.prepare("BEGIN").run();
  try {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep);
      const obj: Record<string, string> = {};
      header.forEach((h, idx) => { obj[h] = (cols[idx] ?? "").trim(); });

      const imeiRaw  = imeiCol  ? obj[imeiCol]  : null;
      const imeiNorm = normalizeImei(imeiRaw);
      if (!imeiNorm) continue;

      const tecName  = tecCol   ? obj[tecCol]   || null : null;
      const ageDays  = idadeCol ? parseInt(obj[idadeCol]) || null : null;
      const cost     = custoCol ? parseCostBR(obj[custoCol]) : null;

      const result = insert.run(importId, imeiRaw, imeiNorm, tecName, ageDays, cost, JSON.stringify(obj));
      const rowId = result.lastInsertRowid as number;

      const rc = linkCase.get(imeiNorm) as { id: number } | undefined;
      if (rc) updateLink.run(rc.id, rowId);

      rowsInserted++;
    }

    db.prepare("UPDATE rel_seriais_imports SET status = 'COMPLETED', finished_at = datetime('now'), rows_valid = ? WHERE id = ?")
      .run(rowsInserted, importId);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    db.prepare("UPDATE rel_seriais_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(importId);
    throw err;
  }

  return { rowsInserted };
}

// ---------------------------------------------------------------------------
// SH — sH.xls/.xlsx (catálogo SH Oficina: IMEI, OS, marca, modelo, etc.)
// ---------------------------------------------------------------------------

const SH_COLS = {
  imei:       ["IMEI", "Imei", "imei", "SERIAL", "N SERIE"],
  os:         ["OS", "Os", "os", "O.S.", "N OS", "NUM OS", "NÚM. OS"],
  brand:      ["MARCA", "Marca", "marca", "FABRICANTE"],
  model:      ["MODELO", "Modelo", "modelo"],
  capacity:   ["CAPACIDADE", "ARMAZENAMENTO", "GB", "CAP"],
  color:      ["COR", "Cor", "cor", "COLOR"],
  defect:     ["DEFEITO", "Defeito", "defeito", "PROBLEMA", "DESCRIÇÃO"],
  os_status:  ["STATUS", "Status", "status", "SITUAÇÃO"],
  repairDate: ["DATA REPARO", "DATA DE REPARO", "DATA", "DT REPARO"],
};

export async function previewSh(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<SourcePreviewResult> {
  const fileHash = hashFile(filePath);

  const existing = db.prepare(
    "SELECT id FROM sh_imports WHERE file_hash = ? AND status NOT IN ('FAILED','CANCELLED')"
  ).get(fileHash) as { id: number } | undefined;

  if (existing) {
    return { importId: existing.id, source: "sh", filename, fileHash, rowsFound: 0, rowsValid: 0,
      issues: [{ row: null, severity: "WARNING", code: "ALREADY_IMPORTED", message: "Arquivo já importado." }],
      alreadyImported: true, existingImportId: existing.id, previewRows: [] };
  }

  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];

  if (rawRows.length === 0) throw new ImportCentralError("EMPTY_FILE", "Planilha vazia ou sem dados.");

  const header = Object.keys(rawRows[0]);
  const imeiCol = findColumn(header, SH_COLS.imei);
  const issues: ImportIssueRaw[] = [];
  if (!imeiCol) issues.push({ row: null, severity: "ERROR", code: "COL_IMEI_MISSING", message: "Coluna IMEI não encontrada." });

  let rowsValid = 0;
  for (const r of rawRows) {
    const imeiNorm = normalizeImei(imeiCol ? r[imeiCol] : null);
    if (imeiNorm) rowsValid++;
  }

  const importRow = db.prepare(`
    INSERT INTO sh_imports (filename, file_hash, status, rows_found, rows_linked, rows_unlinked, issues_count, created_by_user_id)
    VALUES (?, ?, 'PENDING', ?, 0, 0, ?, ?)
  `).run(filename, fileHash, rawRows.length, issues.length, userId);

  return {
    importId: importRow.lastInsertRowid as number,
    source: "sh",
    filename,
    fileHash,
    rowsFound: rawRows.length,
    rowsValid,
    issues,
    alreadyImported: false,
    existingImportId: null,
    previewRows: rawRows.slice(0, 5),
  };
}

export function confirmSh(db: Db, importId: number, filePath: string, _userId: number | null): { rowsInserted: number; rowsLinked: number } {
  const row = db.prepare("SELECT * FROM sh_imports WHERE id = ?").get(importId) as Record<string, unknown> | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row["status"] === "COMPLETED") throw new ImportCentralError("ALREADY_IMPORTED", "Importação já concluída.");
  if (row["status"] === "CANCELLED") throw new ImportCentralError("CANCELLED", "Importação cancelada.");

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];

  const header = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
  const imeiCol    = findColumn(header, SH_COLS.imei);
  const osCol      = findColumn(header, SH_COLS.os);
  const brandCol   = findColumn(header, SH_COLS.brand);
  const modelCol   = findColumn(header, SH_COLS.model);
  const capCol     = findColumn(header, SH_COLS.capacity);
  const colorCol   = findColumn(header, SH_COLS.color);
  const defectCol  = findColumn(header, SH_COLS.defect);
  const statusCol  = findColumn(header, SH_COLS.os_status);
  const dateCol    = findColumn(header, SH_COLS.repairDate);

  const insert = db.prepare(`
    INSERT INTO sh_import_rows (sh_import_id, imei, imei_norm, os, os_norm, brand, model, capacity, color, defect, os_status, repair_date, raw_data_json, repair_case_id, link_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findCase = db.prepare("SELECT id FROM repair_cases WHERE imei_norm = ? LIMIT 1");

  let rowsInserted = 0, rowsLinked = 0;

  db.prepare("BEGIN").run();
  try {
    for (const r of rawRows) {
      const imeiRaw  = imeiCol  ? String(r[imeiCol]  ?? "") : "";
      const imeiNorm = normalizeImei(imeiRaw);
      if (!imeiNorm) continue;

      const osRaw   = osCol    ? String(r[osCol]    ?? "") : null;
      const osNorm  = osRaw    ? normalizeKey(osRaw)       : null;

      const rc = findCase.get(imeiNorm) as { id: number } | undefined;

      insert.run(
        importId,
        imeiRaw || null, imeiNorm,
        osRaw || null, osNorm || null,
        brandCol  ? String(r[brandCol]  ?? "") || null : null,
        modelCol  ? String(r[modelCol]  ?? "") || null : null,
        capCol    ? String(r[capCol]    ?? "") || null : null,
        colorCol  ? String(r[colorCol]  ?? "") || null : null,
        defectCol ? String(r[defectCol] ?? "") || null : null,
        statusCol ? String(r[statusCol] ?? "") || null : null,
        dateCol   ? String(r[dateCol]   ?? "") || null : null,
        JSON.stringify(r),
        rc?.id ?? null,
        rc ? "IMEI" : null,
      );

      rowsInserted++;
      if (rc) rowsLinked++;
    }

    db.prepare("UPDATE sh_imports SET status = 'COMPLETED', finished_at = datetime('now'), rows_linked = ?, rows_unlinked = ? WHERE id = ?")
      .run(rowsLinked, rowsInserted - rowsLinked, importId);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    db.prepare("UPDATE sh_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(importId);
    throw err;
  }

  return { rowsInserted, rowsLinked };
}

// ---------------------------------------------------------------------------
// HIS — CONTROLE DE ENTRADA TRADE-IN.xlsx
// ---------------------------------------------------------------------------

const HIS_COLS = {
  imei:       ["IMEI", "Imei", "imei", "N SERIAL", "SERIAL"],
  os:         ["OS", "Os", "O.S.", "NUM OS"],
  cost:       ["CUSTO", "CUSTO AUDITADO", "VALOR", "PREÇO COMPRA"],
  entryDate:  ["DATA ENTRADA", "DATA DE ENTRADA", "ENTRADA", "DT ENTRADA"],
  reportDate: ["DATA RELATÓRIO", "DATA RELATORIO", "DT RELATORIO", "DATA"],
};

export async function previewHis(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<SourcePreviewResult> {
  const fileHash = hashFile(filePath);

  const existing = db.prepare(
    "SELECT id FROM his_imports WHERE file_hash = ? AND status NOT IN ('FAILED','CANCELLED')"
  ).get(fileHash) as { id: number } | undefined;

  if (existing) {
    return { importId: existing.id, source: "his", filename, fileHash, rowsFound: 0, rowsValid: 0,
      issues: [{ row: null, severity: "WARNING", code: "ALREADY_IMPORTED", message: "Arquivo já importado." }],
      alreadyImported: true, existingImportId: existing.id, previewRows: [] };
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];

  if (rawRows.length === 0) throw new ImportCentralError("EMPTY_FILE", "Planilha vazia.");

  const header = Object.keys(rawRows[0]);
  const imeiCol = findColumn(header, HIS_COLS.imei);
  const issues: ImportIssueRaw[] = [];
  if (!imeiCol) issues.push({ row: null, severity: "ERROR", code: "COL_IMEI_MISSING", message: "Coluna IMEI não encontrada." });

  let rowsValid = 0;
  for (const r of rawRows) {
    if (normalizeImei(imeiCol ? r[imeiCol] : null)) rowsValid++;
  }

  const importRow = db.prepare(`
    INSERT INTO his_imports (filename, file_hash, status, rows_found, rows_linked, rows_unlinked, issues_count, created_by_user_id)
    VALUES (?, ?, 'PENDING', ?, 0, 0, ?, ?)
  `).run(filename, fileHash, rawRows.length, issues.length, userId);

  return {
    importId: importRow.lastInsertRowid as number,
    source: "his",
    filename,
    fileHash,
    rowsFound: rawRows.length,
    rowsValid,
    issues,
    alreadyImported: false,
    existingImportId: null,
    previewRows: rawRows.slice(0, 5),
  };
}

export function confirmHis(db: Db, importId: number, filePath: string, _userId: number | null): { rowsInserted: number; rowsLinked: number } {
  const row = db.prepare("SELECT * FROM his_imports WHERE id = ?").get(importId) as Record<string, unknown> | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row["status"] === "COMPLETED") throw new ImportCentralError("ALREADY_IMPORTED", "Importação já concluída.");
  if (row["status"] === "CANCELLED") throw new ImportCentralError("CANCELLED", "Importação cancelada.");

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];
  const header = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

  const imeiCol   = findColumn(header, HIS_COLS.imei);
  const osCol     = findColumn(header, HIS_COLS.os);
  const costCol   = findColumn(header, HIS_COLS.cost);
  const entryCol  = findColumn(header, HIS_COLS.entryDate);
  const reportCol = findColumn(header, HIS_COLS.reportDate);

  const insert = db.prepare(`
    INSERT INTO his_import_rows (his_import_id, imei, imei_norm, os, os_norm, audited_cost, entry_date, report_date, raw_data_json, repair_case_id, link_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findCase = db.prepare("SELECT id FROM repair_cases WHERE imei_norm = ? LIMIT 1");

  let rowsInserted = 0, rowsLinked = 0;

  db.prepare("BEGIN").run();
  try {
    for (const r of rawRows) {
      const imeiRaw  = imeiCol ? String(r[imeiCol] ?? "") : "";
      const imeiNorm = normalizeImei(imeiRaw);
      if (!imeiNorm) continue;

      const osRaw  = osCol  ? String(r[osCol]  ?? "") || null : null;
      const rc = findCase.get(imeiNorm) as { id: number } | undefined;

      insert.run(
        importId,
        imeiRaw || null, imeiNorm,
        osRaw, osRaw ? normalizeKey(osRaw) : null,
        costCol   ? parseCostBR(String(r[costCol]   ?? "")) : null,
        entryCol  ? String(r[entryCol]  ?? "") || null : null,
        reportCol ? String(r[reportCol] ?? "") || null : null,
        JSON.stringify(r),
        rc?.id ?? null,
        rc ? "IMEI" : null,
      );
      rowsInserted++;
      if (rc) rowsLinked++;
    }

    db.prepare("UPDATE his_imports SET status = 'COMPLETED', finished_at = datetime('now'), rows_linked = ?, rows_unlinked = ? WHERE id = ?")
      .run(rowsLinked, rowsInserted - rowsLinked, importId);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    db.prepare("UPDATE his_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(importId);
    throw err;
  }

  return { rowsInserted, rowsLinked };
}

// ---------------------------------------------------------------------------
// BKP SISTEMICO — BKP SISTEMICO.xlsx (3 abas)
// ---------------------------------------------------------------------------

const BKP_REPAROS_COLS = {
  imei:      ["IMEI", "imei"],
  os:        ["OS", "O.S.", "NUM OS"],
  tech:      ["TÉCNICO", "TECNICO", "RESPONSÁVEL"],
  date:      ["DATA REPARO", "DATA", "DT REPARO"],
  type:      ["TIPO REPARO", "TIPO", "SERVIÇO"],
  part:      ["PEÇA USADA", "PEÇA", "COMPONENTE"],
  ref:       ["REFERÊNCIA", "REFERENCIA", "REF"],
  executed:  ["EXECUTADO", "STATUS", "REALIZADO"],
  code:      ["COD ASSISTENCIA", "CÓDIGO ASSIST", "ASSIST"],
};

const BKP_BAIXA_COLS = {
  imei:      ["IMEI", "imei"],
  ref:       ["REFERÊNCIA", "REFERENCIA", "REF", "PEÇA"],
  status:    ["STATUS BAIXA", "STATUS", "BAIXA", "SITUAÇÃO"],
};

const BKP_TRIAGEM_COLS = {
  imei:      ["IMEI", "imei"],
  os:        ["OS", "O.S."],
  location:  ["LOCAL", "LOCALIZAÇÃO", "DEPÓSITO", "SETOR"],
  date:      ["DATA", "DT"],
};

function detectBkpSheet(wb: Record<string, unknown>, candidates: string[]): string | null {
  const names = (wb["SheetNames"] as string[]);
  for (const c of candidates) {
    const found = names.find(n => n.trim().toUpperCase().includes(c.toUpperCase()));
    if (found) return found;
  }
  return null;
}

export async function previewBkp(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<SourcePreviewResult> {
  const fileHash = hashFile(filePath);

  const existing = db.prepare(
    "SELECT id FROM bkp_imports WHERE file_hash = ? AND status NOT IN ('FAILED','CANCELLED')"
  ).get(fileHash) as { id: number } | undefined;

  if (existing) {
    return { importId: existing.id, source: "bkp", filename, fileHash, rowsFound: 0, rowsValid: 0,
      issues: [{ row: null, severity: "WARNING", code: "ALREADY_IMPORTED", message: "Arquivo já importado." }],
      alreadyImported: true, existingImportId: existing.id, previewRows: [] };
  }

  const wb = XLSX.readFile(filePath);
  const issues: ImportIssueRaw[] = [];

  const reparosSheet = detectBkpSheet(wb, ["REPAROS", "REPARO TECNICO", "TECNICOS"]);
  const baixaSheet   = detectBkpSheet(wb, ["BAIXA_DE_PECA", "BAIXA DE PECA", "BAIXA"]);
  const triagemSheet = detectBkpSheet(wb, ["TRIAGEM ENTRADA", "TRIAGEM"]);

  if (!reparosSheet) issues.push({ row: null, severity: "WARNING", code: "SHEET_REPAROS_MISSING", message: "Aba REPAROS TECNICOS não encontrada." });
  if (!baixaSheet)   issues.push({ row: null, severity: "WARNING", code: "SHEET_BAIXA_MISSING", message: "Aba BAIXA_DE_PEÇA não encontrada." });
  if (!triagemSheet) issues.push({ row: null, severity: "WARNING", code: "SHEET_TRIAGEM_MISSING", message: "Aba TRIAGEM ENTRADA não encontrada." });

  let totalRows = 0;
  const previewRows: Record<string, unknown>[] = [];

  if (reparosSheet) {
    const rows = XLSX.utils.sheet_to_json(wb["Sheets"][reparosSheet as string], { defval: null }) as Record<string, unknown>[];
    totalRows += rows.length;
    previewRows.push(...rows.slice(0, 3));
  }

  const importRow = db.prepare(`
    INSERT INTO bkp_imports (filename, file_hash, status, rows_found, events_linked, events_unlinked, issues_count, created_by_user_id)
    VALUES (?, ?, 'PENDING', ?, 0, 0, ?, ?)
  `).run(filename, fileHash, totalRows, issues.length, userId);

  return {
    importId: importRow.lastInsertRowid as number,
    source: "bkp",
    filename,
    fileHash,
    rowsFound: totalRows,
    rowsValid: totalRows,
    issues,
    alreadyImported: false,
    existingImportId: null,
    previewRows,
  };
}

export function confirmBkp(db: Db, importId: number, filePath: string, _userId: number | null): { rowsInserted: number; rowsLinked: number } {
  const row = db.prepare("SELECT * FROM bkp_imports WHERE id = ?").get(importId) as Record<string, unknown> | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row["status"] === "COMPLETED") throw new ImportCentralError("ALREADY_IMPORTED", "Importação já concluída.");
  if (row["status"] === "CANCELLED") throw new ImportCentralError("CANCELLED", "Importação cancelada.");

  const wb = XLSX.readFile(filePath);
  const findCase = db.prepare("SELECT id FROM repair_cases WHERE imei_norm = ? LIMIT 1");

  let rowsInserted = 0, rowsLinked = 0;

  db.prepare("BEGIN").run();
  try {
    // REPAROS TECNICOS
    const reparosSheet = detectBkpSheet(wb, ["REPAROS", "REPARO TECNICO", "TECNICOS"]);
    if (reparosSheet) {
      const rrows = XLSX.utils.sheet_to_json(wb["Sheets"][reparosSheet], { defval: null }) as Record<string, unknown>[];
      const h = rrows.length > 0 ? Object.keys(rrows[0]) : [];
      const imeiCol = findColumn(h, BKP_REPAROS_COLS.imei);
      const ins = db.prepare(`
        INSERT OR IGNORE INTO systemic_repair_events
          (bkp_import_id, imei, imei_norm, os, os_norm, technician_name, repair_date, repair_type, part_used, reference_used, executed, assistance_code, raw_data_json, repair_case_id, link_method, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of rrows) {
        const imeiRaw  = imeiCol ? String(r[imeiCol] ?? "") : "";
        const imeiNorm = normalizeImei(imeiRaw);
        if (!imeiNorm) continue;
        const osRaw  = findColumn(h, BKP_REPAROS_COLS.os)  ? String(r[findColumn(h, BKP_REPAROS_COLS.os)!]  ?? "") || null : null;
        const idKey  = crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 32);
        const rc = findCase.get(imeiNorm) as { id: number } | undefined;
        ins.run(importId, imeiRaw || null, imeiNorm, osRaw, osRaw ? normalizeKey(osRaw) : null,
          findColumn(h, BKP_REPAROS_COLS.tech)     ? String(r[findColumn(h, BKP_REPAROS_COLS.tech)!]     ?? "") || null : null,
          findColumn(h, BKP_REPAROS_COLS.date)     ? String(r[findColumn(h, BKP_REPAROS_COLS.date)!]     ?? "") || null : null,
          findColumn(h, BKP_REPAROS_COLS.type)     ? String(r[findColumn(h, BKP_REPAROS_COLS.type)!]     ?? "") || null : null,
          findColumn(h, BKP_REPAROS_COLS.part)     ? String(r[findColumn(h, BKP_REPAROS_COLS.part)!]     ?? "") || null : null,
          findColumn(h, BKP_REPAROS_COLS.ref)      ? String(r[findColumn(h, BKP_REPAROS_COLS.ref)!]      ?? "") || null : null,
          findColumn(h, BKP_REPAROS_COLS.executed) ? String(r[findColumn(h, BKP_REPAROS_COLS.executed)!] ?? "") || null : null,
          findColumn(h, BKP_REPAROS_COLS.code)     ? String(r[findColumn(h, BKP_REPAROS_COLS.code)!]     ?? "") || null : null,
          JSON.stringify(r), rc?.id ?? null, rc ? "IMEI" : null, idKey);
        rowsInserted++;
        if (rc) rowsLinked++;
      }
    }

    // BAIXA_DE_PEÇA
    const baixaSheet = detectBkpSheet(wb, ["BAIXA_DE_PECA", "BAIXA DE PECA", "BAIXA"]);
    if (baixaSheet) {
      const brows = XLSX.utils.sheet_to_json(wb["Sheets"][baixaSheet], { defval: null }) as Record<string, unknown>[];
      const h = brows.length > 0 ? Object.keys(brows[0]) : [];
      const imeiCol = findColumn(h, BKP_BAIXA_COLS.imei);
      const refCol  = findColumn(h, BKP_BAIXA_COLS.ref);
      const stCol   = findColumn(h, BKP_BAIXA_COLS.status);
      const ins = db.prepare(`
        INSERT OR IGNORE INTO systemic_part_writeoffs
          (bkp_import_id, imei, imei_norm, reference, reference_norm, writeoff_status, raw_data_json, repair_case_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of brows) {
        const imeiRaw  = imeiCol ? String(r[imeiCol] ?? "") : "";
        const imeiNorm = normalizeImei(imeiRaw);
        if (!imeiNorm) continue;
        const refRaw = refCol ? String(r[refCol] ?? "") || null : null;
        const idKey  = crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 32);
        const rc = findCase.get(imeiNorm) as { id: number } | undefined;
        ins.run(importId, imeiRaw || null, imeiNorm, refRaw, refRaw ? normalizeKey(refRaw) : null,
          stCol ? String(r[stCol] ?? "") || null : null, JSON.stringify(r), rc?.id ?? null, idKey);
        rowsInserted++;
        if (rc) rowsLinked++;
      }
    }

    // TRIAGEM ENTRADA → device_location_snapshots
    const triagemSheet = detectBkpSheet(wb, ["TRIAGEM ENTRADA", "TRIAGEM"]);
    if (triagemSheet) {
      const trows = XLSX.utils.sheet_to_json(wb["Sheets"][triagemSheet], { defval: null }) as Record<string, unknown>[];
      const h = trows.length > 0 ? Object.keys(trows[0]) : [];
      const imeiCol  = findColumn(h, BKP_TRIAGEM_COLS.imei);
      const osCol    = findColumn(h, BKP_TRIAGEM_COLS.os);
      const locCol   = findColumn(h, BKP_TRIAGEM_COLS.location);
      const dateCol  = findColumn(h, BKP_TRIAGEM_COLS.date);
      const ins = db.prepare(`
        INSERT OR IGNORE INTO device_location_snapshots
          (bkp_import_id, imei, imei_norm, os, os_norm, location, snapshot_date, raw_data_json, repair_case_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of trows) {
        const imeiRaw  = imeiCol ? String(r[imeiCol] ?? "") : "";
        const imeiNorm = normalizeImei(imeiRaw);
        if (!imeiNorm) continue;
        const osRaw = osCol ? String(r[osCol] ?? "") || null : null;
        const idKey = crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 32);
        const rc = findCase.get(imeiNorm) as { id: number } | undefined;
        ins.run(importId, imeiRaw || null, imeiNorm, osRaw, osRaw ? normalizeKey(osRaw) : null,
          locCol  ? String(r[locCol]  ?? "") || null : null,
          dateCol ? String(r[dateCol] ?? "") || null : null,
          JSON.stringify(r), rc?.id ?? null, idKey);
        rowsInserted++;
        if (rc) rowsLinked++;
      }
    }

    db.prepare("UPDATE bkp_imports SET status = 'COMPLETED', finished_at = datetime('now'), events_linked = ?, events_unlinked = ?, rows_found = ? WHERE id = ?")
      .run(rowsLinked, rowsInserted - rowsLinked, rowsInserted, importId);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    db.prepare("UPDATE bkp_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(importId);
    throw err;
  }

  return { rowsInserted, rowsLinked };
}

// ---------------------------------------------------------------------------
// TRIAGEM SAIDA — TRIAGEM SAIDA.xlsx
// ---------------------------------------------------------------------------

const TRIAGEM_SAIDA_COLS = {
  imei:        ["IMEI", "imei", "N SERIAL"],
  os:          ["OS", "O.S.", "NUM OS"],
  brand:       ["MARCA", "FABRICANTE"],
  model:       ["MODELO"],
  destination: ["DESTINO", "STATUS", "SAÍDA", "SAIDA", "TIPO SAÍDA"],
  grade:       ["GRADE", "CLASSIFICAÇÃO", "CLASS"],
  date:        ["DATA", "DT SAIDA", "DATA SAÍDA", "DATA SAIDA"],
};

export async function previewTriagemSaida(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<SourcePreviewResult> {
  const fileHash = hashFile(filePath);

  const existing = db.prepare(
    "SELECT id FROM triagem_saida_imports WHERE file_hash = ? AND status NOT IN ('FAILED','CANCELLED')"
  ).get(fileHash) as { id: number } | undefined;

  if (existing) {
    return { importId: existing.id, source: "triagem-saida", filename, fileHash, rowsFound: 0, rowsValid: 0,
      issues: [{ row: null, severity: "WARNING", code: "ALREADY_IMPORTED", message: "Arquivo já importado." }],
      alreadyImported: true, existingImportId: existing.id, previewRows: [] };
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];

  if (rawRows.length === 0) throw new ImportCentralError("EMPTY_FILE", "Planilha vazia.");

  const header = Object.keys(rawRows[0]);
  const imeiCol = findColumn(header, TRIAGEM_SAIDA_COLS.imei);
  const issues: ImportIssueRaw[] = [];
  if (!imeiCol) issues.push({ row: null, severity: "ERROR", code: "COL_IMEI_MISSING", message: "Coluna IMEI não encontrada." });

  let rowsValid = 0;
  for (const r of rawRows) {
    if (normalizeImei(imeiCol ? r[imeiCol] : null)) rowsValid++;
  }

  const importRow = db.prepare(`
    INSERT INTO triagem_saida_imports (filename, file_hash, status, rows_found, rows_linked, rows_unlinked, issues_count, created_by_user_id)
    VALUES (?, ?, 'PENDING', ?, 0, 0, ?, ?)
  `).run(filename, fileHash, rawRows.length, issues.length, userId);

  return {
    importId: importRow.lastInsertRowid as number,
    source: "triagem-saida",
    filename,
    fileHash,
    rowsFound: rawRows.length,
    rowsValid,
    issues,
    alreadyImported: false,
    existingImportId: null,
    previewRows: rawRows.slice(0, 5),
  };
}

export function confirmTriagemSaida(db: Db, importId: number, filePath: string, _userId: number | null): { rowsInserted: number; rowsLinked: number } {
  const row = db.prepare("SELECT * FROM triagem_saida_imports WHERE id = ?").get(importId) as Record<string, unknown> | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row["status"] === "COMPLETED") throw new ImportCentralError("ALREADY_IMPORTED", "Importação já concluída.");
  if (row["status"] === "CANCELLED") throw new ImportCentralError("CANCELLED", "Importação cancelada.");

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];
  const header = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

  const imeiCol  = findColumn(header, TRIAGEM_SAIDA_COLS.imei);
  const osCol    = findColumn(header, TRIAGEM_SAIDA_COLS.os);
  const brandCol = findColumn(header, TRIAGEM_SAIDA_COLS.brand);
  const modelCol = findColumn(header, TRIAGEM_SAIDA_COLS.model);
  const destCol  = findColumn(header, TRIAGEM_SAIDA_COLS.destination);
  const gradeCol = findColumn(header, TRIAGEM_SAIDA_COLS.grade);
  const dateCol  = findColumn(header, TRIAGEM_SAIDA_COLS.date);

  const insert = db.prepare(`
    INSERT INTO triagem_saida_rows (triagem_saida_import_id, imei, imei_norm, os, os_norm, brand, model, destination, grade, exit_date, raw_data_json, repair_case_id, link_issue)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findCase = db.prepare("SELECT id FROM repair_cases WHERE imei_norm = ? LIMIT 1");

  let rowsInserted = 0, rowsLinked = 0;

  db.prepare("BEGIN").run();
  try {
    for (const r of rawRows) {
      const imeiRaw  = imeiCol ? String(r[imeiCol] ?? "") : "";
      const imeiNorm = normalizeImei(imeiRaw);
      if (!imeiNorm) continue;
      const osRaw  = osCol ? String(r[osCol] ?? "") || null : null;
      const rc = findCase.get(imeiNorm) as { id: number } | undefined;

      insert.run(
        importId,
        imeiRaw || null, imeiNorm,
        osRaw, osRaw ? normalizeKey(osRaw) : null,
        brandCol ? String(r[brandCol] ?? "") || null : null,
        modelCol ? String(r[modelCol] ?? "") || null : null,
        destCol  ? String(r[destCol]  ?? "") || null : null,
        gradeCol ? String(r[gradeCol] ?? "") || null : null,
        dateCol  ? String(r[dateCol]  ?? "") || null : null,
        JSON.stringify(r),
        rc?.id ?? null,
        rc ? null : "IMEI_NOT_FOUND",
      );
      rowsInserted++;
      if (rc) rowsLinked++;
    }

    db.prepare("UPDATE triagem_saida_imports SET status = 'COMPLETED', finished_at = datetime('now'), rows_linked = ?, rows_unlinked = ? WHERE id = ?")
      .run(rowsLinked, rowsInserted - rowsLinked, importId);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    db.prepare("UPDATE triagem_saida_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(importId);
    throw err;
  }

  return { rowsInserted, rowsLinked };
}

// ---------------------------------------------------------------------------
// PEACS — PEDIDOS.xlsx aba "TABELA DE AVALIAÇÃO PEACS" (catálogo de preços)
// ---------------------------------------------------------------------------

const PEACS_COLS = {
  brand:    ["MARCA", "Marca", "marca", "FABRICANTE"],
  model:    ["MODELO", "Modelo", "modelo"],
  capacity: ["CAPACIDADE", "Capacidade", "GB", "ARMAZENAMENTO"],
  price:    ["PREÇO VENDA", "PREÇO ESTIMADO", "VENDA ESTIMADA", "VALOR ESTIMADO", "PREÇO"],
};

export async function previewPeacs(
  db: Db,
  filePath: string,
  filename: string,
  userId: number | null,
): Promise<SourcePreviewResult> {
  const fileHash = hashFile(filePath);

  const existing = db.prepare(
    "SELECT id FROM peacs_imports WHERE file_hash = ? AND status NOT IN ('FAILED','CANCELLED')"
  ).get(fileHash) as { id: number } | undefined;

  if (existing) {
    return { importId: existing.id, source: "peacs", filename, fileHash, rowsFound: 0, rowsValid: 0,
      issues: [{ row: null, severity: "WARNING", code: "ALREADY_IMPORTED", message: "Arquivo já importado." }],
      alreadyImported: true, existingImportId: existing.id, previewRows: [] };
  }

  const wb = XLSX.readFile(filePath);
  // Try to find a sheet with "PEACS" or "AVALIAÇÃO" in its name
  const sheetName = wb.SheetNames.find((n: string) =>
    n.toUpperCase().includes("PEAC") || n.toUpperCase().includes("AVALIA")
  ) ?? wb.SheetNames[0];

  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[];

  if (rawRows.length === 0) throw new ImportCentralError("EMPTY_FILE", "Planilha PEACS vazia.");

  const header = Object.keys(rawRows[0]);
  const brandCol = findColumn(header, PEACS_COLS.brand);
  const priceCol = findColumn(header, PEACS_COLS.price);
  const issues: ImportIssueRaw[] = [];
  if (!brandCol) issues.push({ row: null, severity: "ERROR", code: "COL_MARCA_MISSING", message: "Coluna MARCA não encontrada." });
  if (!priceCol) issues.push({ row: null, severity: "WARNING", code: "COL_PRECO_MISSING", message: "Coluna de preço não encontrada." });

  let rowsValid = 0;
  for (const r of rawRows) {
    if (brandCol && r[brandCol]) rowsValid++;
  }

  const importRow = db.prepare(`
    INSERT INTO peacs_imports (filename, file_hash, status, rows_found, entries_matched, entries_unmatched, issues_count, created_by_user_id)
    VALUES (?, ?, 'PENDING', ?, 0, 0, ?, ?)
  `).run(filename, fileHash, rawRows.length, issues.length, userId);

  return {
    importId: importRow.lastInsertRowid as number,
    source: "peacs",
    filename,
    fileHash,
    rowsFound: rawRows.length,
    rowsValid,
    issues,
    alreadyImported: false,
    existingImportId: null,
    previewRows: rawRows.slice(0, 5),
  };
}

export function confirmPeacs(db: Db, importId: number, filePath: string, _userId: number | null): { rowsInserted: number } {
  const row = db.prepare("SELECT * FROM peacs_imports WHERE id = ?").get(importId) as Record<string, unknown> | undefined;
  if (!row) throw new ImportCentralError("NOT_FOUND", "Importação não encontrada.");
  if (row["status"] === "COMPLETED") throw new ImportCentralError("ALREADY_IMPORTED", "Importação já concluída.");
  if (row["status"] === "CANCELLED") throw new ImportCentralError("CANCELLED", "Importação cancelada.");

  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames.find((n: string) =>
    n.toUpperCase().includes("PEAC") || n.toUpperCase().includes("AVALIA")
  ) ?? wb.SheetNames[0];

  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null }) as Record<string, unknown>[];
  const header = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

  const brandCol = findColumn(header, PEACS_COLS.brand);
  const modelCol = findColumn(header, PEACS_COLS.model);
  const capCol   = findColumn(header, PEACS_COLS.capacity);
  const priceCol = findColumn(header, PEACS_COLS.price);

  // Deactivate current active entries before inserting new ones
  db.prepare("UPDATE peacs_catalog SET active = 0 WHERE active = 1").run();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO peacs_catalog (peacs_import_id, brand, brand_norm, model, model_norm, capacity, capacity_norm, estimated_sale, raw_data_json, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  let rowsInserted = 0;

  db.prepare("BEGIN").run();
  try {
    for (const r of rawRows) {
      const brand = brandCol ? String(r[brandCol] ?? "").trim() : null;
      if (!brand) continue;
      const model    = modelCol ? String(r[modelCol] ?? "").trim() || null : null;
      const capacity = capCol   ? String(r[capCol]   ?? "").trim() || null : null;
      const price    = priceCol ? parseCostBR(String(r[priceCol] ?? "")) : null;

      insert.run(
        importId,
        brand, normalizeKey(brand),
        model ?? "", normalizeKey(model ?? ""),
        capacity ?? null, capacity ? normalizeKey(capacity) : null,
        price ?? null,
        JSON.stringify(r),
      );
      rowsInserted++;
    }

    db.prepare("UPDATE peacs_imports SET status = 'COMPLETED', finished_at = datetime('now'), entries_matched = ? WHERE id = ?")
      .run(rowsInserted, importId);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    db.prepare("UPDATE peacs_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(importId);
    throw err;
  }

  return { rowsInserted };
}

// ---------------------------------------------------------------------------
// Legado — ANALISE MI + PEDIDOS (somente leitura via import_batches)
// ---------------------------------------------------------------------------

export function getLegadoStatus(db: Db): {
  initialized: boolean;
  batchId: number | null;
  batchStatus: string | null;
  ordersFound: number;
  inventoryFound: number;
  createdAt: string | null;
} {
  const state = db.prepare("SELECT initialized, initial_import_batch_id FROM system_state LIMIT 1").get() as
    { initialized: number; initial_import_batch_id: number | null } | undefined;

  if (!state?.initialized) {
    return { initialized: false, batchId: null, batchStatus: null, ordersFound: 0, inventoryFound: 0, createdAt: null };
  }

  const batch = state.initial_import_batch_id
    ? db.prepare("SELECT * FROM import_batches WHERE id = ?").get(state.initial_import_batch_id) as Record<string, unknown> | undefined
    : undefined;

  return {
    initialized: true,
    batchId: batch ? (batch["id"] as number) : null,
    batchStatus: batch ? (batch["status"] as string) : null,
    ordersFound: batch ? ((batch["orders_found"] as number) ?? 0) : 0,
    inventoryFound: batch ? ((batch["inventory_found"] as number) ?? 0) : 0,
    createdAt: batch ? (batch["created_at"] as string) : null,
  };
}
