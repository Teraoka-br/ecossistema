/**
 * Repara violações de FK na tabela users.
 *
 * Reinsere o usuário ID 1 (excluído fisicamente) como desativado,
 * preservando referências históricas. Deve ser executado contra uma
 * cópia do banco beta, nunca contra o original.
 *
 * Uso: npx tsx scripts/repair-fk-violations.ts [caminho-do-banco]
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const dbPath = process.argv[2] || path.resolve("data/app-beta-audit.sqlite");
console.log(`[repair] Abrindo banco: ${dbPath}`);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// 1. Verificar violações antes
const beforeViolations = db.prepare("PRAGMA foreign_key_check").all();
console.log(`[repair] Violações FK antes: ${beforeViolations.length}`);

if (beforeViolations.length === 0) {
  console.log("[repair] Nenhuma violação. Nada a fazer.");
  db.close();
  process.exit(0);
}

// 2. Identificar user IDs órfãos
const orphanIds = new Set<number>();
for (const v of beforeViolations as Array<{ table: string; rowid: number; parent: string; fkid: number }>) {
  if (v.parent !== "users") continue;
  const fks = db.prepare(`PRAGMA foreign_key_list(${v.table})`).all() as Array<{
    id: number; from: string;
  }>;
  const fkDef = fks.find(f => f.id === v.fkid);
  if (!fkDef) continue;
  try {
    const row = db.prepare(`SELECT ${fkDef.from} FROM ${v.table} WHERE rowid = ?`).get(v.rowid) as Record<string, unknown>;
    if (row) orphanIds.add(row[fkDef.from] as number);
  } catch { /* skip */ }
}

console.log(`[repair] User IDs órfãos: ${[...orphanIds].join(", ")}`);

// 3. Reinserir usuários órfãos como desativados
db.exec("BEGIN");
try {
  for (const uid of orphanIds) {
    const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(uid);
    if (exists) {
      console.log(`[repair] Usuário ${uid} já existe, pulando.`);
      continue;
    }
    db.prepare(
      `INSERT INTO users (id, username, display_name, pin_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'OPERATOR', 0, datetime('now'), datetime('now'))`,
    ).run(uid, `_historico_${String(uid).padStart(3, "0")}`, `Usuário Histórico #${uid} (excluído)`, "DISABLED_NO_LOGIN");
    console.log(`[repair] Criado usuário histórico ID ${uid} (desativado).`);
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}

// 4. Verificar violações depois
const afterViolations = db.prepare("PRAGMA foreign_key_check").all();
console.log(`[repair] Violações FK depois: ${afterViolations.length}`);

if (afterViolations.length > 0) {
  console.error("[repair] ATENÇÃO: ainda há violações restantes!");
  const byTable: Record<string, number> = {};
  for (const v of afterViolations as Array<{ table: string }>) {
    byTable[v.table] = (byTable[v.table] || 0) + 1;
  }
  console.error("[repair] Por tabela:", byTable);
}

db.close();
console.log("[repair] Concluído.");
