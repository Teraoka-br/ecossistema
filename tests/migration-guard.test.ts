import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";

const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");

/** Aplica só a migration 001 manualmente, simulando um banco "parado" no schema antigo. */
function applyOnly001(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const sql001 = fs.readFileSync(path.join(MIGRATIONS_DIR, "001_init.sql"), "utf8");
  db.exec(sql001);
  db.prepare("INSERT INTO schema_migrations (name) VALUES ('001_init.sql')").run();
}

describe("guarda de pré-migração para 002_fix_order_identity.sql", () => {
  it("aborta quando há ID_PEDIDO duplicado no schema antigo, sem remover linhas", () => {
    const db = openDatabase(":memory:");
    applyOnly001(db);

    // No schema 001 (UNIQUE inclui chave_peca_norm), duas linhas com o MESMO
    // id_pedido e CHAVEPEÇA diferentes eram aceitas — exatamente o resquício
    // do modelo de identidade antigo que a migration 002 precisa proteger.
    const insert = db.prepare(
      `INSERT INTO import_batches (analysis_file_name, orders_file_name, analysis_file_hash, orders_file_hash, status)
       VALUES ('a.xlsx', 'p.xlsx', 'ha', 'hp', 'COMPLETED')`,
    );
    const batchId = Number(insert.run().lastInsertRowid);

    const insertPart = db.prepare(
      `INSERT INTO source_order_parts (import_batch_id, id_pedido, chave_peca, chave_peca_norm, raw_json)
       VALUES (?, ?, ?, ?, '{}')`,
    );
    insertPart.run(batchId, "PEDDUP-LEGACY", "BATERIA 13", "BATERIA 13");
    insertPart.run(batchId, "PEDDUP-LEGACY", "CARCAÇA 13", "CARCACA 13");

    const countBefore = (
      db.prepare("SELECT COUNT(*) AS c FROM source_order_parts").get() as { c: number }
    ).c;
    expect(countBefore).toBe(2);

    expect(() => runMigrations(db)).toThrow(/ABORTADA/);
    expect(() => runMigrations(db)).toThrow(/PEDDUP-LEGACY/);

    // Migration 002 (e a 003, que depende dela) NÃO foram aplicadas.
    const applied = db
      .prepare("SELECT name FROM schema_migrations")
      .all() as { name: string }[];
    const names = applied.map((r) => r.name);
    expect(names).toContain("001_init.sql");
    expect(names).not.toContain("002_fix_order_identity.sql");
    expect(names).not.toContain("003_add_conflicts_count.sql");

    // Nenhuma linha foi removida — o aborto acontece ANTES da migration rodar.
    const countAfter = (
      db.prepare("SELECT COUNT(*) AS c FROM source_order_parts").get() as { c: number }
    ).c;
    expect(countAfter).toBe(2);

    db.close();
  });

  it("aplica normalmente quando não há duplicidade (caso comum)", () => {
    const db = openDatabase(":memory:");
    applyOnly001(db);

    const insert = db.prepare(
      `INSERT INTO import_batches (analysis_file_name, orders_file_name, analysis_file_hash, orders_file_hash, status)
       VALUES ('a.xlsx', 'p.xlsx', 'ha', 'hp', 'COMPLETED')`,
    );
    const batchId = Number(insert.run().lastInsertRowid);
    db.prepare(
      `INSERT INTO source_order_parts (import_batch_id, id_pedido, chave_peca, chave_peca_norm, raw_json)
       VALUES (?, 'PEDOK', 'BATERIA 13', 'BATERIA 13', '{}')`,
    ).run(batchId);

    const outcome = runMigrations(db);
    expect(outcome.applied).toContain("002_fix_order_identity.sql");
    expect(outcome.applied).toContain("003_add_conflicts_count.sql");

    const countAfter = (
      db.prepare("SELECT COUNT(*) AS c FROM source_order_parts").get() as { c: number }
    ).c;
    expect(countAfter).toBe(1);

    db.close();
  });
});
