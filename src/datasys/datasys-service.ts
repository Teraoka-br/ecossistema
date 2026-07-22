import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/database.js";
import { normalizeKey as normalizeText } from "../domain/text.js";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface DatasysImport {
  id: number;
  filename: string;
  fileHash: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  rowsFound: number;
  rowsImported: number;
  warningsCount: number;
  errorsCount: number;
  stagedFilePath: string | null;
  cancelledAt: string | null;
  createdByUserId: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DatasysRecord {
  id: number;
  datasysImportId: number;
  imei: string | null;
  imeiNorm: string | null;
  os: string | null;
  osNorm: string | null;
  brand: string | null;
  model: string | null;
  entryDate: string | null;
  ageDays: number | null;
  cost: number | null;
  rawDataJson: string | null;
  createdAt: string;
}

export interface DatasysIssue {
  id: number;
  datasysImportId: number;
  rowNumber: number | null;
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  rawValue: string | null;
  createdAt: string;
}

export interface DatasysPreviewResult {
  importId: number;
  filename: string;
  fileHash: string;
  rowsFound: number;
  rowsValid: number;
  issues: Pick<DatasysIssue, "rowNumber" | "severity" | "code" | "message">[];
  alreadyImported: boolean;
  existingImportId: number | null;
  columnMapping: Record<string, string>;
}

export class DatasysError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DatasysError";
  }
}

// ---------------------------------------------------------------------------
// Mapeamento de colunas esperadas do relatório Datasys / RELATORIO
// ---------------------------------------------------------------------------
export const DATASYS_COLUMN_MAPPING: Record<string, string[]> = {
  imei:       ["IMEI", "Imei", "imei", "SERIAL", "Serial"],
  os:         ["OS", "Os", "os", "O.S.", "NUM OS", "Num OS"],
  brand:      ["MARCA", "Marca", "marca", "FABRICANTE"],
  model:      ["MODELO", "Modelo", "modelo"],
  entryDate:  ["DATA ENTRADA", "Data Entrada", "DATA", "Data"],
  ageDays:    ["IDADE", "Idade", "idade", "DIAS", "Dias"],
  cost:       ["CUSTO", "Custo", "custo", "VALOR CUSTO", "Valor Custo"],
};

// ---------------------------------------------------------------------------
// Hash do arquivo
// ---------------------------------------------------------------------------
function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Validação de path traversal
// ---------------------------------------------------------------------------
function validateStagedPath(filePath: string, allowedDir: string): void {
  const resolved = path.resolve(filePath);
  const dir = path.resolve(allowedDir);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new DatasysError("INVALID_PATH", "Caminho de arquivo inválido.");
  }
}

// ---------------------------------------------------------------------------
// Preview — analisa sem gravar registros
// ---------------------------------------------------------------------------
export async function previewDatasysImport(
  db: Db,
  params: { filePath: string; filename: string; userId: number | null; uploadDir: string },
): Promise<DatasysPreviewResult> {
  const { default: XLSX } = await import("xlsx");

  validateStagedPath(params.filePath, params.uploadDir);
  const fileHash = hashFile(params.filePath);

  // Idempotência: mesmo arquivo já importado
  const existing = db
    .prepare("SELECT id FROM datasys_imports WHERE file_hash = ? AND status = 'COMPLETED' LIMIT 1")
    .get(fileHash) as { id: number } | undefined;

  if (existing) {
    // Limpa arquivo temporário — duplicado não precisa ficar
    try { fs.unlinkSync(params.filePath); } catch { /* ignore */ }
    return {
      importId: -1,
      filename: params.filename,
      fileHash,
      rowsFound: 0,
      rowsValid: 0,
      issues: [],
      alreadyImported: true,
      existingImportId: existing.id,
      columnMapping: {},
    };
  }

  // Lê o arquivo
  const wb = XLSX.readFile(params.filePath, { cellDates: true });

  const sheetName = wb.SheetNames.find(
    (n) => n.toUpperCase().includes("RELATORIO") || n.toUpperCase().includes("RELATÓRIO"),
  ) ?? wb.SheetNames[0];

  if (!sheetName) {
    try { fs.unlinkSync(params.filePath); } catch { /* ignore */ }
    throw new DatasysError("NO_SHEET", "Nenhuma aba encontrada no arquivo.");
  }

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const resolved: Record<string, string | null> = {};
  for (const [field, candidates] of Object.entries(DATASYS_COLUMN_MAPPING)) {
    resolved[field] = candidates.find((c) => headers.includes(c)) ?? null;
  }

  const issues: Pick<DatasysIssue, "rowNumber" | "severity" | "code" | "message">[] = [];

  if (!resolved.imei && !resolved.os) {
    issues.push({ rowNumber: null, severity: "ERROR", code: "MISSING_KEY_COLUMNS", message: "Colunas de IMEI e OS não encontradas. Verifique o arquivo ou o mapeamento de colunas." });
  }

  const validRows: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const imei = resolved.imei ? String(row[resolved.imei] ?? "").trim() : "";
    const os = resolved.os ? String(row[resolved.os] ?? "").trim() : "";
    if (!imei && !os) {
      issues.push({ rowNumber: i + 2, severity: "WARNING", code: "EMPTY_KEY", message: "Linha sem IMEI nem OS — ignorada." });
      continue;
    }
    validRows.push(row);
  }

  if (validRows.length === 0 && rows.length > 0) {
    issues.push({ rowNumber: null, severity: "ERROR", code: "NO_VALID_ROWS", message: "Nenhuma linha válida encontrada no arquivo." });
  }

  // Cria registro PENDING e persiste o caminho staged
  const res = db
    .prepare(
      `INSERT INTO datasys_imports (filename, file_hash, status, rows_found, staged_file_path, created_by_user_id)
       VALUES (?, ?, 'PENDING', ?, ?, ?)`,
    )
    .run(params.filename, fileHash, rows.length, params.filePath, params.userId ?? null);
  const importId = res.lastInsertRowid as number;

  // Persiste os issues do preview
  if (issues.length > 0) {
    const insertIssue = db.prepare(
      `INSERT INTO datasys_import_issues (datasys_import_id, row_number, severity, code, message)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const iss of issues) {
      insertIssue.run(importId, iss.rowNumber ?? null, iss.severity, iss.code, iss.message);
    }
  }

  return {
    importId,
    filename: params.filename,
    fileHash,
    rowsFound: rows.length,
    rowsValid: validRows.length,
    issues,
    alreadyImported: false,
    existingImportId: null,
    columnMapping: Object.fromEntries(Object.entries(resolved).filter(([, v]) => v !== null)) as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------
// Confirm — efetivamente grava; usa staged_file_path do banco
// ---------------------------------------------------------------------------
export async function confirmDatasysImport(
  db: Db,
  params: { importId: number; userId: number | null; uploadDir: string },
): Promise<{ imported: number; warnings: number; errors: number }> {
  const { default: XLSX } = await import("xlsx");

  const imp = db
    .prepare("SELECT * FROM datasys_imports WHERE id = ?")
    .get(params.importId) as DatasysImportRow | undefined;
  if (!imp) throw new DatasysError("NOT_FOUND", "Importação não encontrada.");
  if (imp.status === "COMPLETED") throw new DatasysError("ALREADY_IMPORTED", "Importação já confirmada.");
  if (imp.cancelled_at) throw new DatasysError("CANCELLED", "Importação cancelada.");

  const filePath = imp.staged_file_path;
  if (!filePath) throw new DatasysError("NO_STAGED_FILE", "Arquivo staged não encontrado. Faça upload novamente.");
  validateStagedPath(filePath, params.uploadDir);
  if (!fs.existsSync(filePath)) {
    throw new DatasysError("FILE_MISSING", "Arquivo temporário não encontrado. Faça upload novamente.");
  }

  // Verifica que há linhas válidas (bloqueio: zero valid rows)
  const issueCount = (db.prepare(
    "SELECT COUNT(*) as c FROM datasys_import_issues WHERE datasys_import_id = ? AND code = 'NO_VALID_ROWS'",
  ).get(params.importId) as { c: number }).c;
  if (issueCount > 0) {
    throw new DatasysError("NO_VALID_ROWS", "Nenhuma linha válida no arquivo — confirmação bloqueada.");
  }

  db.prepare("UPDATE datasys_imports SET status = 'PROCESSING' WHERE id = ?").run(params.importId);

  try {
    const wb = XLSX.readFile(filePath, { cellDates: true });
    const sheetName = wb.SheetNames.find(
      (n) => n.toUpperCase().includes("RELATORIO") || n.toUpperCase().includes("RELATÓRIO"),
    ) ?? wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const resolved: Record<string, string | null> = {};
    for (const [field, candidates] of Object.entries(DATASYS_COLUMN_MAPPING)) {
      resolved[field] = candidates.find((c) => headers.includes(c)) ?? null;
    }

    let imported = 0;
    let warnings = 0;
    const errors = 0;

    const insertRecord = db.prepare(
      `INSERT INTO datasys_records (datasys_import_id, imei, imei_norm, os, os_norm, brand, model, entry_date, age_days, cost, raw_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertIssue = db.prepare(
      `INSERT INTO datasys_import_issues (datasys_import_id, row_number, severity, code, message, raw_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    db.exec("BEGIN");
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const imei = resolved.imei ? String(row[resolved.imei] ?? "").trim() : "";
        const os = resolved.os ? String(row[resolved.os] ?? "").trim() : "";
        if (!imei && !os) {
          insertIssue.run(params.importId, i + 2, "WARNING", "EMPTY_KEY", "Linha sem IMEI nem OS — ignorada.", null);
          warnings++;
          continue;
        }
        const imeiNorm = imei ? normalizeText(imei) : null;
        const osNorm = os ? normalizeText(os) : null;
        const brand = resolved.brand ? String(row[resolved.brand] ?? "").trim() || null : null;
        const model = resolved.model ? String(row[resolved.model] ?? "").trim() || null : null;
        const entryDate = resolved.entryDate ? String(row[resolved.entryDate] ?? "").trim() || null : null;
        const ageDaysRaw = resolved.ageDays ? row[resolved.ageDays] : null;
        const ageDays = ageDaysRaw != null ? Number(ageDaysRaw) || null : null;
        const costRaw = resolved.cost ? row[resolved.cost] : null;
        const cost = costRaw != null ? Number(costRaw) || null : null;

        insertRecord.run(
          params.importId,
          imei || null, imeiNorm,
          os || null, osNorm,
          brand, model, entryDate, ageDays, cost,
          JSON.stringify(row),
        );
        imported++;
      }

      db.prepare(
        `UPDATE datasys_imports SET status = 'COMPLETED', rows_imported = ?, warnings_count = ?, errors_count = ?, staged_file_path = NULL, finished_at = datetime('now') WHERE id = ?`,
      ).run(imported, warnings, errors, params.importId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      db.prepare("UPDATE datasys_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(params.importId);
      throw err;
    }

    // Limpa arquivo temporário após import bem-sucedido
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }

    return { imported, warnings, errors };
  } catch (err) {
    if (!(err instanceof DatasysError)) {
      db.prepare("UPDATE datasys_imports SET status = 'FAILED', finished_at = datetime('now') WHERE id = ?").run(params.importId);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cancel preview — apaga registro PENDING e arquivo staged
// ---------------------------------------------------------------------------
export function cancelDatasysPreview(db: Db, importId: number, userId: number | null): void {
  const imp = db
    .prepare("SELECT * FROM datasys_imports WHERE id = ?")
    .get(importId) as DatasysImportRow | undefined;
  if (!imp) throw new DatasysError("NOT_FOUND", "Importação não encontrada.");
  if (imp.status !== "PENDING" || imp.cancelled_at) {
    throw new DatasysError("NOT_PENDING", "Somente importações pendentes podem ser canceladas.");
  }

  if (imp.staged_file_path) {
    try { fs.unlinkSync(imp.staged_file_path); } catch { /* ignore */ }
  }

  db.prepare(
    "UPDATE datasys_imports SET status = 'FAILED', cancelled_at = datetime('now'), finished_at = datetime('now') WHERE id = ?",
  ).run(importId);

  void userId; // auditado na rota
}

// ---------------------------------------------------------------------------
// List imports
// ---------------------------------------------------------------------------
export function listDatasysImports(db: Db): DatasysImport[] {
  const rows = db
    .prepare("SELECT * FROM datasys_imports ORDER BY started_at DESC LIMIT 100")
    .all() as unknown as DatasysImportRow[];
  return rows.map(toDatasysImport);
}

// ---------------------------------------------------------------------------
// Search records
// ---------------------------------------------------------------------------
export function searchDatasysRecords(
  db: Db,
  params: { imei?: string; os?: string },
): DatasysRecord[] {
  const conditions: string[] = [];
  const p: (string | number | null)[] = [];
  if (params.imei) { conditions.push("imei_norm = ?"); p.push(normalizeText(params.imei)); }
  if (params.os) { conditions.push("os_norm = ?"); p.push(normalizeText(params.os)); }
  if (conditions.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT r.* FROM datasys_records r
       JOIN datasys_imports i ON i.id = r.datasys_import_id
       WHERE i.status = 'COMPLETED' AND (${conditions.join(" OR ")})
       ORDER BY i.started_at DESC LIMIT 50`,
    )
    .all(...p) as unknown as DatasysRecordRow[];
  return rows.map(toDatasysRecord);
}

/**
 * Para uma lista de IMEIs, devolve o OS do registro Datasys mais recente
 * (maior `datasys_imports.started_at`) de cada um — usado como referência na
 * Fila de Reparos quando o `repair_cases.os` do caso está vazio (comum em
 * aparelhos de lote, sem OS individual na importação legado).
 */
export function getLatestOsByImeis(db: Db, imeis: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const norms = [...new Set(imeis.filter(Boolean).map((i) => normalizeText(i)))];
  if (norms.length === 0) return result;

  const placeholders = norms.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT r.imei_norm AS imei_norm, r.os AS os
       FROM datasys_records r
       JOIN datasys_imports i ON i.id = r.datasys_import_id
       WHERE i.status = 'COMPLETED' AND r.imei_norm IN (${placeholders}) AND r.os IS NOT NULL AND r.os != ''
       ORDER BY i.started_at DESC`,
    )
    .all(...norms) as unknown as { imei_norm: string; os: string }[];

  // A primeira ocorrência de cada imei_norm (ordenado por started_at DESC) é a mais recente.
  for (const r of rows) {
    if (!result.has(r.imei_norm)) result.set(r.imei_norm, r.os);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface DatasysImportRow {
  id: number; filename: string; file_hash: string; status: string;
  rows_found: number; rows_imported: number; warnings_count: number; errors_count: number;
  staged_file_path: string | null; cancelled_at: string | null;
  created_by_user_id: number | null; started_at: string; finished_at: string | null;
}

interface DatasysRecordRow {
  id: number; datasys_import_id: number;
  imei: string | null; imei_norm: string | null; os: string | null; os_norm: string | null;
  brand: string | null; model: string | null; entry_date: string | null;
  age_days: number | null; cost: number | null; raw_data_json: string | null; created_at: string;
}

function toDatasysImport(r: DatasysImportRow): DatasysImport {
  return {
    id: r.id, filename: r.filename, fileHash: r.file_hash, status: r.status as DatasysImport["status"],
    rowsFound: r.rows_found, rowsImported: r.rows_imported, warningsCount: r.warnings_count, errorsCount: r.errors_count,
    stagedFilePath: r.staged_file_path, cancelledAt: r.cancelled_at,
    createdByUserId: r.created_by_user_id, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

function toDatasysRecord(r: DatasysRecordRow): DatasysRecord {
  return {
    id: r.id, datasysImportId: r.datasys_import_id, imei: r.imei, imeiNorm: r.imei_norm,
    os: r.os, osNorm: r.os_norm, brand: r.brand, model: r.model, entryDate: r.entry_date,
    ageDays: r.age_days, cost: r.cost, rawDataJson: r.raw_data_json, createdAt: r.created_at,
  };
}
