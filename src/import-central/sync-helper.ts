/**
 * Sincronização incremental para tabelas _current.
 *
 * Compara key + row_hash: INSERTED / UPDATED / UNCHANGED.
 * Deve ser chamado dentro de uma transação ativa.
 */

import crypto from "node:crypto";
import type { Db } from "../db/database.js";

export type SqlVal = string | number | null;

export interface SyncRow {
  key: string;
  hash: string;
  /** Colunas da tabela excluindo: id, keyCol, row_hash, last_seen_at, created_at */
  cols: Record<string, SqlVal>;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Computa hash SHA-256 (hex, 16 chars) de um conjunto de valores funcionais.
 * Nunca inclua import_id, created_at ou timestamps no hash.
 */
export function rowHash(...parts: (string | number | null | undefined)[]): string {
  const raw = parts.map((p) => (p == null ? "" : String(p))).join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Sincroniza `rows` para `tableName` usando key+hash.
 *
 * - INSERTED: chave não existe → INSERT
 * - UPDATED: chave existe, hash mudou → UPDATE todos os campos + row_hash
 * - UNCHANGED: chave existe, mesmo hash → UPDATE só importIdCol + last_seen_at
 *
 * @param importIdCol  nome da coluna importId em cols (atualizada no UNCHANGED)
 */
export function syncCurrentTable(
  db: Db,
  opts: {
    table: string;
    keyCol: string;
    importIdCol: string;
    rows: SyncRow[];
  },
): SyncResult {
  const { table, keyCol, importIdCol, rows } = opts;
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

  // Carregar estado atual
  const existing = new Map<string, { id: number; hash: string }>();
  const cur = db
    .prepare(`SELECT id, ${keyCol} AS k, row_hash AS h FROM ${table}`)
    .all() as { id: number; k: string; h: string | null }[];
  for (const r of cur) {
    if (r.k != null) existing.set(String(r.k), { id: r.id, hash: r.h ?? "" });
  }

  const colNames = Object.keys(rows[0].cols);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // Preparar statements (mesma estrutura para todas as linhas)
  const insertCols = [keyCol, "row_hash", "last_seen_at", ...colNames];
  const insertStmt = db.prepare(
    `INSERT INTO ${table} (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`,
  );

  const updateSet = [...colNames, "row_hash", "last_seen_at"].map((c) => `${c} = ?`).join(", ");
  const updateStmt = db.prepare(`UPDATE ${table} SET ${updateSet} WHERE id = ?`);

  const unchangedStmt = db.prepare(
    `UPDATE ${table} SET ${importIdCol} = ?, last_seen_at = datetime('now') WHERE id = ?`,
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of rows) {
    const colVals = colNames.map((c) => row.cols[c] ?? null) as SqlVal[];
    const ex = existing.get(row.key);

    if (!ex) {
      (insertStmt.run as (...args: SqlVal[]) => void)(
        row.key, row.hash, now, ...colVals,
      );
      inserted++;
    } else if (ex.hash !== row.hash) {
      (updateStmt.run as (...args: SqlVal[]) => void)(
        ...colVals, row.hash, now, ex.id,
      );
      updated++;
    } else {
      unchangedStmt.run(row.cols[importIdCol] ?? null, ex.id);
      unchanged++;
    }
  }

  return { inserted, updated, unchanged };
}
