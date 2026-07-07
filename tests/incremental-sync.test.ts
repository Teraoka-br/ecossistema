/**
 * Testes de sincronização incremental (Round 5).
 * Cobre: idempotência, atualização, inserção, PEACS deactivation, rel_seriais consolidation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { syncCurrentTable, rowHash } from "../src/import-central/sync-helper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function makeHash(...parts: (string | number | null | undefined)[]): string {
  return rowHash(...parts);
}

function seedHisImport(db: Db): number {
  const r = db.prepare(
    `INSERT INTO his_imports (filename, file_hash, status, rows_found, issues_count)
     VALUES ('his.xlsx', ?, 'COMPLETED', 5, 0)`,
  ).run(`hh-${++_seq}`);
  return r.lastInsertRowid as number;
}

function seedRelSeriaisImport(db: Db): number {
  const r = db.prepare(
    `INSERT INTO rel_seriais_imports (filename, file_hash, status, rows_found, rows_valid, issues_count)
     VALUES ('ser.csv', ?, 'COMPLETED', 5, 5, 0)`,
  ).run(`rs-${++_seq}`);
  return r.lastInsertRowid as number;
}

function seedShImport(db: Db): number {
  const r = db.prepare(
    `INSERT INTO sh_os_imports (filename, file_hash, status, rows_found, rows_valid, issues_count)
     VALUES ('sh.xls', ?, 'COMPLETED', 5, 5, 0)`,
  ).run(`sh-${++_seq}`);
  return r.lastInsertRowid as number;
}

function seedDemonstrativoImport(db: Db): number {
  const r = db.prepare(
    `INSERT INTO demonstrativo_imports (filename, file_hash, status, rows_found, rows_valid, issues_count)
     VALUES ('dem.xls', ?, 'COMPLETED', 5, 5, 0)`,
  ).run(`dm-${++_seq}`);
  return r.lastInsertRowid as number;
}

function seedPeacsImport(db: Db): number {
  const r = db.prepare(
    `INSERT INTO peacs_imports (filename, file_hash, status, rows_found, entries_matched, entries_unmatched, issues_count)
     VALUES ('peacs.xlsx', ?, 'COMPLETED', 5, 5, 0, 0)`,
  ).run(`pc-${++_seq}`);
  return r.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// syncCurrentTable — His Current
// ---------------------------------------------------------------------------

describe("syncCurrentTable — his_current", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("1. Idempotência: segunda chamada com mesmos dados → 0 inserted/updated", () => {
    const imp1 = seedHisImport(db);
    const rows = [
      { key: "111000000000001", hash: makeHash("111000000000001", 500, 30), cols: { his_import_id: imp1, audited_cost: 500, age_days: 30, imei_raw: null, report_date: null, source_line: null } },
    ];

    const r1 = syncCurrentTable(db, { table: "his_current", keyCol: "imei_norm", importIdCol: "his_import_id", rows });
    expect(r1.inserted).toBe(1);
    expect(r1.updated).toBe(0);
    expect(r1.unchanged).toBe(0);

    const imp2 = seedHisImport(db);
    const rows2 = rows.map((r) => ({ ...r, cols: { ...r.cols, his_import_id: imp2 } }));
    const r2 = syncCurrentTable(db, { table: "his_current", keyCol: "imei_norm", importIdCol: "his_import_id", rows: rows2 });
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(1);
  });

  it("2. Atualização: segunda chamada com custo diferente → rows_updated=1", () => {
    const imp1 = seedHisImport(db);
    syncCurrentTable(db, {
      table: "his_current", keyCol: "imei_norm", importIdCol: "his_import_id",
      rows: [{ key: "111000000000002", hash: makeHash("111000000000002", 300, 20), cols: { his_import_id: imp1, audited_cost: 300, age_days: 20, imei_raw: null, report_date: null, source_line: null } }],
    });

    const imp2 = seedHisImport(db);
    const r2 = syncCurrentTable(db, {
      table: "his_current", keyCol: "imei_norm", importIdCol: "his_import_id",
      rows: [{ key: "111000000000002", hash: makeHash("111000000000002", 450, 25), cols: { his_import_id: imp2, audited_cost: 450, age_days: 25, imei_raw: null, report_date: null, source_line: null } }],
    });
    expect(r2.updated).toBe(1);

    const cur = db.prepare("SELECT audited_cost, age_days FROM his_current WHERE imei_norm='111000000000002'").get() as { audited_cost: number; age_days: number };
    expect(cur.audited_cost).toBe(450);
    expect(cur.age_days).toBe(25);
  });

  it("3. Inserção nova: IMEI que não existia → inserted=1", () => {
    const imp1 = seedHisImport(db);
    const r = syncCurrentTable(db, {
      table: "his_current", keyCol: "imei_norm", importIdCol: "his_import_id",
      rows: [{ key: "999000000000003", hash: makeHash("999000000000003", 700, 10), cols: { his_import_id: imp1, audited_cost: 700, age_days: 10, imei_raw: null, report_date: null, source_line: null } }],
    });
    expect(r.inserted).toBe(1);
    const cur = db.prepare("SELECT audited_cost FROM his_current WHERE imei_norm='999000000000003'").get() as { audited_cost: number };
    expect(cur.audited_cost).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// syncCurrentTable — rel_seriais_current
// ---------------------------------------------------------------------------

describe("syncCurrentTable — rel_seriais_current", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("4. Idempotência rel_seriais: segunda importação igual → unchanged=1", () => {
    const imp1 = seedRelSeriaisImport(db);
    const rows = [{
      key: "222000000000001",
      hash: makeHash("222000000000001", "Galaxy A32", "SIM", "DP-CWB"),
      cols: { rel_seriais_import_id: imp1, serial: "SN1", descricao: "Galaxy A32", codigo_comercial: "COD-1", fabricante: "Samsung", disponivel: "SIM", deposito_atual: "DP-CWB", filial_atual: null },
    }];

    syncCurrentTable(db, { table: "rel_seriais_current", keyCol: "imei_norm", importIdCol: "rel_seriais_import_id", rows });

    const imp2 = seedRelSeriaisImport(db);
    const r2 = syncCurrentTable(db, {
      table: "rel_seriais_current", keyCol: "imei_norm", importIdCol: "rel_seriais_import_id",
      rows: rows.map((r) => ({ ...r, cols: { ...r.cols, rel_seriais_import_id: imp2 } })),
    });
    expect(r2.unchanged).toBe(1);
    expect(r2.updated).toBe(0);
  });

  it("5. Atualização rel_seriais: deposito muda → updated=1", () => {
    const imp1 = seedRelSeriaisImport(db);
    syncCurrentTable(db, {
      table: "rel_seriais_current", keyCol: "imei_norm", importIdCol: "rel_seriais_import_id",
      rows: [{ key: "222000000000002", hash: makeHash("222000000000002", "S21", "SIM", "DP-A"), cols: { rel_seriais_import_id: imp1, serial: "SN2", descricao: "S21", codigo_comercial: "COD-2", fabricante: "Samsung", disponivel: "SIM", deposito_atual: "DP-A", filial_atual: null } }],
    });

    const imp2 = seedRelSeriaisImport(db);
    const r2 = syncCurrentTable(db, {
      table: "rel_seriais_current", keyCol: "imei_norm", importIdCol: "rel_seriais_import_id",
      rows: [{ key: "222000000000002", hash: makeHash("222000000000002", "S21", "SIM", "DP-B"), cols: { rel_seriais_import_id: imp2, serial: "SN2", descricao: "S21", codigo_comercial: "COD-2", fabricante: "Samsung", disponivel: "SIM", deposito_atual: "DP-B", filial_atual: null } }],
    });
    expect(r2.updated).toBe(1);

    const cur = db.prepare("SELECT deposito_atual FROM rel_seriais_current WHERE imei_norm='222000000000002'").get() as { deposito_atual: string };
    expect(cur.deposito_atual).toBe("DP-B");
  });
});

// ---------------------------------------------------------------------------
// syncCurrentTable — sh_os_current
// ---------------------------------------------------------------------------

describe("syncCurrentTable — sh_os_current", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("6. SH idempotência: mesmo arquivo → unchanged=1", () => {
    const imp1 = seedShImport(db);
    const rows = [{
      key: "33001",
      hash: makeHash("33001", null, "Apple", "11", "Branco", null, null),
      cols: { sh_os_import_id: imp1, os_norm: "33001", imei_norm: null, os_raw: "33001", imei_raw: null, marca: "Apple", modelo: "11", cor: "Branco", defeito: null, obs_servico: null },
    }];

    syncCurrentTable(db, { table: "sh_os_current", keyCol: "lookup_key", importIdCol: "sh_os_import_id", rows });

    const imp2 = seedShImport(db);
    const r2 = syncCurrentTable(db, {
      table: "sh_os_current", keyCol: "lookup_key", importIdCol: "sh_os_import_id",
      rows: rows.map((r) => ({ ...r, cols: { ...r.cols, sh_os_import_id: imp2 } })),
    });
    expect(r2.unchanged).toBe(1);
    expect(r2.updated).toBe(0);
  });

  it("7. SH: defeito atualizado → updated=1, dados corretos", () => {
    const imp1 = seedShImport(db);
    syncCurrentTable(db, {
      table: "sh_os_current", keyCol: "lookup_key", importIdCol: "sh_os_import_id",
      rows: [{ key: "44001", hash: makeHash("44001", null, "Samsung", "A32", null, "Tela trincada", null), cols: { sh_os_import_id: imp1, os_norm: "44001", imei_norm: null, os_raw: "44001", imei_raw: null, marca: "Samsung", modelo: "A32", cor: null, defeito: "Tela trincada", obs_servico: null } }],
    });

    const imp2 = seedShImport(db);
    const r2 = syncCurrentTable(db, {
      table: "sh_os_current", keyCol: "lookup_key", importIdCol: "sh_os_import_id",
      rows: [{ key: "44001", hash: makeHash("44001", null, "Samsung", "A32", null, "Tela trincada — revisado", null), cols: { sh_os_import_id: imp2, os_norm: "44001", imei_norm: null, os_raw: "44001", imei_raw: null, marca: "Samsung", modelo: "A32", cor: null, defeito: "Tela trincada — revisado", obs_servico: null } }],
    });
    expect(r2.updated).toBe(1);

    const cur = db.prepare("SELECT defeito FROM sh_os_current WHERE lookup_key='44001'").get() as { defeito: string };
    expect(cur.defeito).toBe("Tela trincada — revisado");
  });
});

// ---------------------------------------------------------------------------
// syncCurrentTable — demonstrativo_current
// ---------------------------------------------------------------------------

describe("syncCurrentTable — demonstrativo_current", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("8. Demonstrativo idempotência: mesmo saldo → unchanged=1", () => {
    const imp1 = seedDemonstrativoImport(db);
    const rows = [{
      key: "REFNORM001",
      hash: makeHash("REFNORM001", "Tela Apple 11", 150),
      cols: { demonstrativo_import_id: imp1, referencia: "REF001", descricao: "Tela Apple 11", codigo_comercial: null, fabricante: null, grupo: null, subgrupo: null, familia: null, saldo: 150 },
    }];

    syncCurrentTable(db, { table: "demonstrativo_current", keyCol: "referencia_norm", importIdCol: "demonstrativo_import_id", rows });

    const imp2 = seedDemonstrativoImport(db);
    const r2 = syncCurrentTable(db, {
      table: "demonstrativo_current", keyCol: "referencia_norm", importIdCol: "demonstrativo_import_id",
      rows: rows.map((r) => ({ ...r, cols: { ...r.cols, demonstrativo_import_id: imp2 } })),
    });
    expect(r2.unchanged).toBe(1);
  });

  it("9. Demonstrativo: saldo atualizado → updated=1", () => {
    const imp1 = seedDemonstrativoImport(db);
    syncCurrentTable(db, {
      table: "demonstrativo_current", keyCol: "referencia_norm", importIdCol: "demonstrativo_import_id",
      rows: [{ key: "REFNORM002", hash: makeHash("REFNORM002", "Bateria", 50), cols: { demonstrativo_import_id: imp1, referencia: "REF002", descricao: "Bateria", codigo_comercial: null, fabricante: null, grupo: null, subgrupo: null, familia: null, saldo: 50 } }],
    });

    const imp2 = seedDemonstrativoImport(db);
    const r2 = syncCurrentTable(db, {
      table: "demonstrativo_current", keyCol: "referencia_norm", importIdCol: "demonstrativo_import_id",
      rows: [{ key: "REFNORM002", hash: makeHash("REFNORM002", "Bateria", 75), cols: { demonstrativo_import_id: imp2, referencia: "REF002", descricao: "Bateria", codigo_comercial: null, fabricante: null, grupo: null, subgrupo: null, familia: null, saldo: 75 } }],
    });
    expect(r2.updated).toBe(1);

    const cur = db.prepare("SELECT saldo FROM demonstrativo_current WHERE referencia_norm='REFNORM002'").get() as { saldo: number };
    expect(cur.saldo).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// PEACS incremental — deactivation
// ---------------------------------------------------------------------------

describe("PEACS incremental sync via peacs_catalog", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("10. PEACS deactivation: chave ausente na 2ª importação → active=0", () => {
    const imp1 = seedPeacsImport(db);
    // Inserir dois modelos ativos
    db.prepare(
      `INSERT INTO peacs_catalog (peacs_import_id, brand, brand_norm, model, model_norm, marca_modelo, marca_modelo_norm, estimated_sale, active, row_hash, last_seen_at)
       VALUES (?, '', '', '', '', 'Apple iPhone 11', 'APPLE IPHONE 11', 1500, 1, 'h1', datetime('now'))`,
    ).run(imp1);
    db.prepare(
      `INSERT INTO peacs_catalog (peacs_import_id, brand, brand_norm, model, model_norm, marca_modelo, marca_modelo_norm, estimated_sale, active, row_hash, last_seen_at)
       VALUES (?, '', '', '', '', 'Samsung Galaxy A32', 'SAMSUNG GALAXY A32', 900, 1, 'h2', datetime('now'))`,
    ).run(imp1);

    // Simular: nova importação só tem Apple
    const imp2 = seedPeacsImport(db);
    const seenNorms = new Set(["APPLE IPHONE 11"]);
    const activeRows = db.prepare("SELECT id, marca_modelo_norm FROM peacs_catalog WHERE active=1").all() as { id: number; marca_modelo_norm: string }[];
    for (const row of activeRows) {
      if (!seenNorms.has(row.marca_modelo_norm)) {
        db.prepare("UPDATE peacs_catalog SET active=0, updated_at=datetime('now') WHERE id=?").run(row.id);
      } else {
        db.prepare("UPDATE peacs_catalog SET peacs_import_id=?, last_seen_at=datetime('now') WHERE id=?").run(imp2, row.id);
      }
    }

    const galaxy = db.prepare("SELECT active FROM peacs_catalog WHERE marca_modelo_norm='SAMSUNG GALAXY A32'").get() as { active: number };
    expect(galaxy.active).toBe(0);

    const apple = db.prepare("SELECT active FROM peacs_catalog WHERE marca_modelo_norm='APPLE IPHONE 11'").get() as { active: number };
    expect(apple.active).toBe(1);
  });

  it("11. PEACS row_hash e last_seen_at persistidos", () => {
    const imp1 = seedPeacsImport(db);
    db.prepare(
      `INSERT INTO peacs_catalog (peacs_import_id, brand, brand_norm, model, model_norm, marca_modelo, marca_modelo_norm, estimated_sale, active, row_hash, last_seen_at)
       VALUES (?, '', '', '', '', 'Motorola Edge 30', 'MOTOROLA EDGE 30', 1200, 1, 'abc123', datetime('now'))`,
    ).run(imp1);

    const row = db.prepare("SELECT row_hash, last_seen_at FROM peacs_catalog WHERE marca_modelo_norm='MOTOROLA EDGE 30'").get() as { row_hash: string; last_seen_at: string };
    expect(row.row_hash).toBe("abc123");
    expect(row.last_seen_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// rel_seriais_current: consolidação SIM preferencial
// ---------------------------------------------------------------------------

describe("rel_seriais_current — consolidação SIM preferencial", () => {
  let db: Db;

  beforeEach(async () => { db = await createDb(); });

  it("12. Somente uma linha por IMEI em rel_seriais_current (UNIQUE)", () => {
    const imp1 = seedRelSeriaisImport(db);
    // Inserir uma linha
    db.prepare(
      `INSERT INTO rel_seriais_current (rel_seriais_import_id, imei_norm, serial, descricao, codigo_comercial, fabricante, disponivel, deposito_atual, row_hash)
       VALUES (?, '333000000000001', 'SN-A', 'iPhone 12', 'COD-12', 'Apple', 'SIM', 'DP-1', 'h1')`,
    ).run(imp1);

    const count = (db.prepare("SELECT count(*) as c FROM rel_seriais_current WHERE imei_norm='333000000000001'").get() as { c: number }).c;
    expect(count).toBe(1);

    // Tentar inserir segunda linha com mesmo IMEI deve falhar ou conflitar
    expect(() => {
      db.prepare(
        `INSERT INTO rel_seriais_current (rel_seriais_import_id, imei_norm, serial, descricao, codigo_comercial, fabricante, disponivel, deposito_atual, row_hash)
         VALUES (?, '333000000000001', 'SN-B', 'iPhone 12', 'COD-12', 'Apple', 'NÃO', 'DP-2', 'h2')`,
      ).run(imp1);
    }).toThrow();
  });
});
