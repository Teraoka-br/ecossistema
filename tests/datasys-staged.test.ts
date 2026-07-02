/**
 * Testes de segurança do Datasys: staged_file_path server-side, cancelamento e bloqueio.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import XLSX from "xlsx";
import {
  previewDatasysImport,
  confirmDatasysImport,
  cancelDatasysPreview,
  DatasysError,
} from "../src/datasys/datasys-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "datasys-test-"));
}

function writeTmpXlsx(dir: string, filename: string): string {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["IMEI", "OS", "MARCA", "MODELO"],
    ["123456789012345", "OS-001", "Samsung", "Galaxy"],
    ["987654321098765", "OS-002", "Apple", "iPhone"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "RELATORIO");
  const filePath = path.join(dir, filename);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

describe("datasys: staged_file_path controlado pelo servidor", () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("preview persiste staged_file_path no banco", async () => {
    const filePath = writeTmpXlsx(tmpDir, "test.xlsx");
    const result = await previewDatasysImport(db, {
      filePath,
      filename: "test.xlsx",
      userId: null,
      uploadDir: tmpDir,
    });
    expect(result.importId).toBeGreaterThan(0);
    const row = db
      .prepare("SELECT staged_file_path FROM datasys_imports WHERE id = ?")
      .get(result.importId) as { staged_file_path: string | null };
    expect(row.staged_file_path).toBe(filePath);
  });

  it("confirm usa staged_file_path do banco (não aceita filePath do cliente)", async () => {
    const filePath = writeTmpXlsx(tmpDir, "test2.xlsx");
    const preview = await previewDatasysImport(db, {
      filePath,
      filename: "test2.xlsx",
      userId: null,
      uploadDir: tmpDir,
    });
    const result = await confirmDatasysImport(db, {
      importId: preview.importId,
      userId: null,
      uploadDir: tmpDir,
    });
    expect(result.imported).toBeGreaterThan(0);
  });

  it("confirm com importId inválido lança NOT_FOUND", async () => {
    await expect(
      confirmDatasysImport(db, { importId: 9999, userId: null, uploadDir: tmpDir }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("confirm já confirmado lança ALREADY_IMPORTED", async () => {
    const filePath = writeTmpXlsx(tmpDir, "test3.xlsx");
    const preview = await previewDatasysImport(db, {
      filePath,
      filename: "test3.xlsx",
      userId: null,
      uploadDir: tmpDir,
    });
    await confirmDatasysImport(db, { importId: preview.importId, userId: null, uploadDir: tmpDir });
    await expect(
      confirmDatasysImport(db, { importId: preview.importId, userId: null, uploadDir: tmpDir }),
    ).rejects.toMatchObject({ code: "ALREADY_IMPORTED" });
  });

  it("staged_file_path limpo após confirm bem-sucedido", async () => {
    const filePath = writeTmpXlsx(tmpDir, "test4.xlsx");
    const preview = await previewDatasysImport(db, {
      filePath,
      filename: "test4.xlsx",
      userId: null,
      uploadDir: tmpDir,
    });
    await confirmDatasysImport(db, { importId: preview.importId, userId: null, uploadDir: tmpDir });
    const row = db
      .prepare("SELECT staged_file_path FROM datasys_imports WHERE id = ?")
      .get(preview.importId) as { staged_file_path: string | null };
    expect(row.staged_file_path).toBeNull();
  });

  it("cancelDatasysPreview define cancelled_at e status=FAILED", async () => {
    const filePath = writeTmpXlsx(tmpDir, "test5.xlsx");
    const preview = await previewDatasysImport(db, {
      filePath,
      filename: "test5.xlsx",
      userId: null,
      uploadDir: tmpDir,
    });
    cancelDatasysPreview(db, preview.importId, null);
    const row = db
      .prepare("SELECT status, cancelled_at FROM datasys_imports WHERE id = ?")
      .get(preview.importId) as { status: string; cancelled_at: string | null };
    expect(row.status).toBe("FAILED");
    expect(row.cancelled_at).not.toBeNull();
  });

  it("cancelDatasysPreview de COMPLETED lança NOT_PENDING", async () => {
    const filePath = writeTmpXlsx(tmpDir, "test6.xlsx");
    const preview = await previewDatasysImport(db, {
      filePath,
      filename: "test6.xlsx",
      userId: null,
      uploadDir: tmpDir,
    });
    await confirmDatasysImport(db, { importId: preview.importId, userId: null, uploadDir: tmpDir });
    expect(() => cancelDatasysPreview(db, preview.importId, null)).toThrow(DatasysError);
  });

  it("path traversal fora do uploadDir lança INVALID_PATH", async () => {
    await expect(
      previewDatasysImport(db, {
        filePath: "/etc/passwd",
        filename: "evil.xlsx",
        userId: null,
        uploadDir: tmpDir,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});
