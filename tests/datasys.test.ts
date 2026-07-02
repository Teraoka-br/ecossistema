/**
 * Testes da intake do Datasys.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import { listDatasysImports, searchDatasysRecords, previewDatasysImport } from "../src/datasys/datasys-service.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import XLSX from "xlsx";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function makeFixture(rows: Record<string, unknown>[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-test-"));
  const filePath = path.join(dir, "RELATORIO.xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "RELATORIO");
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function cleanupFile(fp: string): void {
  try { fs.rmSync(path.dirname(fp), { recursive: true, force: true }); } catch { /* noop */ }
}

describe("datasys preview", () => {
  let db: Db;
  beforeEach(() => { db = makeDb(); });

  it("retorna rowsFound e rowsValid corretamente", async () => {
    const fp = makeFixture([
      { IMEI: "111111111111111", OS: "OS001", MARCA: "Samsung", MODELO: "A53", IDADE: 30, CUSTO: 200 },
      { IMEI: "",               OS: "",      MARCA: "", MODELO: "", IDADE: "", CUSTO: "" }, // linha vazia
    ]);
    try {
      const result = await previewDatasysImport(db, { filePath: fp, filename: "RELATORIO.xlsx", userId: null });
      expect(result.rowsFound).toBe(2);
      expect(result.rowsValid).toBe(1);
      expect(result.issues.some((i) => i.code === "EMPTY_KEY")).toBe(true);
    } finally {
      cleanupFile(fp);
    }
  });

  it("detecta idempotência por hash", async () => {
    const fp = makeFixture([{ IMEI: "222222222222222", OS: "OS002" }]);
    try {
      // Marca o hash como COMPLETED manualmente para simular importação anterior
      const hash = (await import("node:crypto")).default.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
      db.prepare("INSERT INTO datasys_imports (filename, file_hash, status, rows_found) VALUES (?, ?, 'COMPLETED', 1)").run("old.xlsx", hash);
      const result = await previewDatasysImport(db, { filePath: fp, filename: "RELATORIO.xlsx", userId: null });
      expect(result.alreadyImported).toBe(true);
    } finally {
      cleanupFile(fp);
    }
  });
});

describe("datasys search", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    // Insere import e record manualmente
    const r = db.prepare("INSERT INTO datasys_imports (filename, file_hash, status, rows_found, rows_imported) VALUES ('test.xlsx','abc','COMPLETED',1,1)").run();
    const importId = r.lastInsertRowid as number;
    db.prepare("INSERT INTO datasys_records (datasys_import_id, imei, imei_norm, os, os_norm, brand, model, age_days, cost) VALUES (?,?,?,?,?,?,?,?,?)").run(
      importId, "333333333333333", "333333333333333", "OS777", "OS777", "Apple", "iPhone 13", 45, 800,
    );
  });

  it("busca por IMEI retorna registro", () => {
    const records = searchDatasysRecords(db, { imei: "333333333333333" });
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("iPhone 13");
  });

  it("busca por OS retorna registro", () => {
    const records = searchDatasysRecords(db, { os: "OS777" });
    expect(records.length).toBe(1);
    expect(records[0].imei).toBe("333333333333333");
  });

  it("busca sem parâmetros retorna vazio", () => {
    const records = searchDatasysRecords(db, {});
    expect(records.length).toBe(0);
  });

  it("divergência não sobrescreve repair_case (separação de domínios)", () => {
    // Datasys search é somente leitura — não deve tocar repair_cases
    const before = db.prepare("SELECT COUNT(*) as c FROM repair_cases").get() as { c: number };
    searchDatasysRecords(db, { imei: "333333333333333" });
    const after = db.prepare("SELECT COUNT(*) as c FROM repair_cases").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("listDatasysImports retorna histórico", () => {
    const imports = listDatasysImports(db);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports[0].status).toBe("COMPLETED");
  });
});
