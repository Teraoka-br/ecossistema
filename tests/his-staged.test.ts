/**
 * Testes do staging do His Estoque.
 * Cobre: previewHis grava his_staged_rows, confirmHis lê do staging (não re-stream),
 * limpeza após confirmação/cancelamento/expiração, última ocorrência física,
 * segunda importação unchanged, motor trigger, his_import_rows não cresce.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb, makeXlsx, cleanup } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  previewHis,
  confirmHis,
  cancelStaging,
  expireOldStagings,
  ImportCentralError,
} from "../src/import-central/import-central-service.js";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cria um XLSX mínimo compatível com o parser do His Estoque.
 * Col B=1 (IMEI), R=17 (age), S=18 (cost), U=20 (date).
 */
function makeHisXlsx(
  rows: { imei: string; age?: number; cost?: number; date?: number }[],
): string {
  const header = Array(21).fill("");
  header[1] = "SERIAL"; header[17] = "IDADE"; header[18] = "CUSTO"; header[20] = "DATA";
  const dataRows = rows.map((r) => {
    const row = Array(21).fill("");
    row[1]  = r.imei;
    if (r.age  !== undefined) row[17] = r.age;
    if (r.cost !== undefined) row[18] = r.cost;
    if (r.date !== undefined) row[20] = r.date;
    return row;
  });
  return makeXlsx([{ name: "His Estoque", aoa: [header, ...dataRows] }]);
}

function countHisImportRows(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM his_import_rows").get() as { c: number }).c;
}

function countHisCurrent(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM his_current").get() as { c: number }).c;
}

function countStagedRows(db: Db, stagingId: number): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM his_staged_rows WHERE staging_id=?").get(stagingId) as { c: number }).c;
}

// ---------------------------------------------------------------------------

describe("His Estoque — staging e confirmação", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("previewHis grava dados consolidados em his_staged_rows", async () => {
    const fp = makeHisXlsx([
      { imei: "352987119749929", age: 30, cost: 664.55 },
      { imei: "111000000000001", age: 10, cost: 100 },
    ]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      expect(preview.rowsValid).toBe(2);
      expect(countStagedRows(db, preview.stagingId)).toBe(2);
    } finally { cleanup(fp); }
  });

  it("confirmHis lê do staging, não re-processa o arquivo", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      // Alterar o staged row — confirmHis deve usar este valor, não o do arquivo
      db.prepare("UPDATE his_staged_rows SET audited_cost=999 WHERE staging_id=?").run(preview.stagingId);
      await confirmHis(db, preview.stagingId, null);
      const row = db.prepare("SELECT audited_cost FROM his_current WHERE imei_norm=?")
        .get("352987119749929") as { audited_cost: number } | undefined;
      expect(row?.audited_cost).toBe(999);
    } finally { cleanup(fp); }
  });

  it("staging é limpo após confirmar", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      const sid = preview.stagingId;
      await confirmHis(db, sid, null);
      expect(countStagedRows(db, sid)).toBe(0);
    } finally { cleanup(fp); }
  });

  it("staging é limpo após cancelar", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      const sid = preview.stagingId;
      expect(countStagedRows(db, sid)).toBeGreaterThan(0);
      cancelStaging(db, sid);
      expect(countStagedRows(db, sid)).toBe(0);
    } finally { cleanup(fp); }
  });

  it("staging é limpo após expirar", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      const sid = preview.stagingId;
      expect(countStagedRows(db, sid)).toBeGreaterThan(0);
      // Forçar expiração imediata
      db.prepare("UPDATE import_staged_files SET expires_at=datetime('now','-1 second') WHERE id=?").run(sid);
      expireOldStagings(db);
      expect(countStagedRows(db, sid)).toBe(0);
    } finally { cleanup(fp); }
  });

  it("custo e idade são preservados exatamente como vieram do arquivo", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 42, cost: 1234.56 }]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      await confirmHis(db, preview.stagingId, null);
      const row = db.prepare("SELECT audited_cost, age_days FROM his_current WHERE imei_norm=?")
        .get("352987119749929") as { audited_cost: number; age_days: number } | undefined;
      expect(row?.audited_cost).toBeCloseTo(1234.56);
      expect(row?.age_days).toBe(42);
    } finally { cleanup(fp); }
  });

  it("última ocorrência física vence (IMEI duplicado no arquivo)", async () => {
    const fp = makeHisXlsx([
      { imei: "352987119749929", age: 10, cost: 100 },
      { imei: "352987119749929", age: 20, cost: 200 }, // última — deve vencer
    ]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      expect(preview.rowsValid).toBe(1); // 1 IMEI único
      await confirmHis(db, preview.stagingId, null);
      const row = db.prepare("SELECT audited_cost, age_days FROM his_current WHERE imei_norm=?")
        .get("352987119749929") as { audited_cost: number; age_days: number } | undefined;
      expect(row?.audited_cost).toBe(200);
      expect(row?.age_days).toBe(20);
    } finally { cleanup(fp); }
  });

  it("segunda importação com dados iguais → unchanged", async () => {
    // fp2 tem hash diferente (IMEI inválido extra muda o arquivo mas não os dados válidos)
    const fp1 = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    const fp2 = makeHisXlsx([
      { imei: "352987119749929", age: 30, cost: 664.55 },
      { imei: "INVALIDO", age: 5, cost: 1 }, // filtrado pelo parser, muda o hash do arquivo
    ]);
    try {
      const prev1 = await previewHis(db, fp1, "his1.xlsx", null);
      await confirmHis(db, prev1.stagingId, null);
      const prev2 = await previewHis(db, fp2, "his2.xlsx", null);
      const r2 = await confirmHis(db, prev2.stagingId, null);
      expect(r2.rowsInserted).toBe(0);
      expect(r2.rowsUpdated).toBe(0);
      expect(r2.rowsUnchanged).toBe(1);
    } finally { cleanup(fp1); cleanup(fp2); }
  });

  it("segunda importação com dados alterados → updated", async () => {
    const fp1 = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    const fp2 = makeHisXlsx([{ imei: "352987119749929", age: 35, cost: 700 }]);
    try {
      const prev1 = await previewHis(db, fp1, "his1.xlsx", null);
      await confirmHis(db, prev1.stagingId, null);
      const prev2 = await previewHis(db, fp2, "his2.xlsx", null);
      const r2 = await confirmHis(db, prev2.stagingId, null);
      expect(r2.rowsUpdated).toBe(1);
      expect(r2.rowsInserted).toBe(0);
    } finally { cleanup(fp1); cleanup(fp2); }
  });

  it("his_import_rows não cresce após confirmHis", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    try {
      const before = countHisImportRows(db);
      const preview = await previewHis(db, fp, "his.xlsx", null);
      await confirmHis(db, preview.stagingId, null);
      expect(countHisImportRows(db)).toBe(before);
    } finally { cleanup(fp); }
  });

  it("segunda confirmação da mesma staging falha com ALREADY_CONFIRMED", async () => {
    const fp = makeHisXlsx([{ imei: "352987119749929", age: 30, cost: 664.55 }]);
    try {
      const preview = await previewHis(db, fp, "his.xlsx", null);
      await confirmHis(db, preview.stagingId, null);
      // Tentar confirmar de novo — deve falhar
      await expect(confirmHis(db, preview.stagingId, null))
        .rejects.toBeInstanceOf(ImportCentralError);
    } finally { cleanup(fp); }
  });
});

// ---------------------------------------------------------------------------
// beta-start scripts — verificação estrutural
// ---------------------------------------------------------------------------

describe("beta-start scripts", () => {
  it("beta:start nunca usa dist (sempre dev)", () => {
    const script = fs.readFileSync(
      path.resolve("scripts/beta-start.ts"), "utf8",
    );
    // Não deve ter lógica condicional baseada em existência de dist
    expect(script).not.toMatch(/isProduction/);
    expect(script).not.toMatch(/existsSync.*dist/);
    // Deve usar tsx watch
    expect(script).toMatch(/tsx watch src\/server\/index\.ts/);
  });

  it("beta:start:prod usa dist e exige que exista", () => {
    const script = fs.readFileSync(
      path.resolve("scripts/beta-start-prod.ts"), "utf8",
    );
    // Script deve referenciar o arquivo de dist (como variável ou string literal)
    expect(script).toMatch(/dist/);
    expect(script).toMatch(/index\.js/);
    // Deve verificar existência antes de iniciar
    expect(script).toMatch(/existsSync/);
    // Deve usar node, não tsx watch
    expect(script).toMatch(/node.*SERVER_JS|spawn.*node/);
    expect(script).not.toMatch(/tsx watch/);
  });

  it("package.json tem beta:start e beta:start:prod como scripts separados", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["beta:start"]).toMatch(/beta-start\.ts/);
    expect(pkg.scripts["beta:start:prod"]).toMatch(/beta-start-prod\.ts/);
    // beta:start não pode referenciar beta-start-prod
    expect(pkg.scripts["beta:start"]).not.toMatch(/prod/);
  });
});
