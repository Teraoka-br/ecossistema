/**
 * Testes do script migrate-repair-domain.ts.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  mapLegacyPartStatus,
  deriveWorkflowFromParts,
  groupRows,
} from "../scripts/migrate-repair-domain.js";

function makeDb() {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// mapLegacyPartStatus
// ---------------------------------------------------------------------------
describe("mapLegacyPartStatus", () => {
  it("MATCH → INDICADA (nunca RESERVADA)", () => {
    expect(mapLegacyPartStatus("MATCH")).toBe("INDICADA");
  });

  it("MATCH PARCIAL → INDICADA", () => {
    expect(mapLegacyPartStatus("MATCH PARCIAL")).toBe("INDICADA");
  });

  it("PEDIR PEÇA → PEDIR_PECA", () => {
    expect(mapLegacyPartStatus("PEDIR PEÇA")).toBe("PEDIR_PECA");
  });

  it("SEM SALDO → PEDIR_PECA", () => {
    expect(mapLegacyPartStatus("SEM SALDO")).toBe("PEDIR_PECA");
  });

  it("AGUARDANDO RECEBIMENTO → AGUARDANDO_RECEBIMENTO", () => {
    expect(mapLegacyPartStatus("AGUARDANDO RECEBIMENTO")).toBe("AGUARDANDO_RECEBIMENTO");
  });

  it("CONCLUIDO → SEPARADA", () => {
    expect(mapLegacyPartStatus("CONCLUIDO")).toBe("SEPARADA");
  });

  it("SEPARADO → SEPARADA", () => {
    expect(mapLegacyPartStatus("SEPARADO")).toBe("SEPARADA");
  });

  it("CANCELADO → CANCELADA", () => {
    expect(mapLegacyPartStatus("CANCELADO")).toBe("CANCELADA");
  });

  it("VERIFICAR → VERIFICAR", () => {
    expect(mapLegacyPartStatus("VERIFICAR")).toBe("VERIFICAR");
  });

  it("null → PEDIR_PECA", () => {
    expect(mapLegacyPartStatus(null)).toBe("PEDIR_PECA");
  });

  it("status desconhecido → PEDIR_PECA", () => {
    expect(mapLegacyPartStatus("DESCONHECIDO")).toBe("PEDIR_PECA");
  });

  it("nunca produz RESERVADA", () => {
    const statuses = ["MATCH", "MATCH PARCIAL", "PEDIR PEÇA", "SEM SALDO", "AGUARDANDO", "CONCLUIDO", "CANCELADO", "VERIFICAR", null, ""];
    for (const s of statuses) {
      expect(mapLegacyPartStatus(s)).not.toBe("RESERVADA");
    }
  });
});

// ---------------------------------------------------------------------------
// deriveWorkflowFromParts
// ---------------------------------------------------------------------------
describe("deriveWorkflowFromParts", () => {
  it("todas canceladas → CANCELADO", () => {
    expect(deriveWorkflowFromParts(["CANCELADA", "CANCELADA"])).toBe("CANCELADO");
  });

  it("qualquer VERIFICAR → VERIFICAR", () => {
    expect(deriveWorkflowFromParts(["PEDIR_PECA", "VERIFICAR"])).toBe("VERIFICAR");
  });

  it("todas SEPARADA → APTO_REPARO", () => {
    expect(deriveWorkflowFromParts(["SEPARADA", "SEPARADA"])).toBe("APTO_REPARO");
  });

  it("SEPARADA + CANCELADA → APTO_REPARO", () => {
    expect(deriveWorkflowFromParts(["SEPARADA", "CANCELADA"])).toBe("APTO_REPARO");
  });

  it("qualquer AGUARDANDO_RECEBIMENTO → AGUARDANDO_RECEBIMENTO", () => {
    expect(deriveWorkflowFromParts(["INDICADA", "AGUARDANDO_RECEBIMENTO"])).toBe("AGUARDANDO_RECEBIMENTO");
  });

  it("qualquer PEDIR_PECA → PEDIR_PECA", () => {
    expect(deriveWorkflowFromParts(["INDICADA", "PEDIR_PECA"])).toBe("PEDIR_PECA");
  });

  it("todas INDICADA → MATCH", () => {
    expect(deriveWorkflowFromParts(["INDICADA", "INDICADA"])).toBe("MATCH");
  });

  it("INDICADA + CANCELADA → MATCH (canceladas ignoradas)", () => {
    expect(deriveWorkflowFromParts(["INDICADA", "CANCELADA"])).toBe("MATCH");
  });

  it("lista vazia → CANCELADO", () => {
    expect(deriveWorkflowFromParts([])).toBe("CANCELADO");
  });
});

// ---------------------------------------------------------------------------
// groupRows — identidade IMEI+OS+data
// ---------------------------------------------------------------------------
describe("groupRows: identidade IMEI+OS+data", () => {
  function makeRow(overrides: Partial<{
    id: number; import_batch_id: number; id_pedido: string;
    imei: string | null; os: string | null; data_pedido: string | null;
    status_atual_legado: string | null; concat_peca: string | null;
    chave_peca: string | null; chave_peca_norm: string | null;
    status_kit_legado: string | null; idade: number | null;
    custo: number | null; venda: number | null; margem_legada: number | null;
    marca: string | null; modelo: string | null;
  }> = {}) {
    return {
      id: 1, import_batch_id: 1, id_pedido: "PED-001",
      imei: "100000000000001", os: "OS-001", data_pedido: "2024-01-15",
      status_atual_legado: "PEDIR PEÇA", concat_peca: "Tela",
      chave_peca: "TEL-01", chave_peca_norm: "tel01",
      status_kit_legado: "PEDIR PEÇA", idade: 30,
      custo: 100, venda: 200, margem_legada: 100,
      marca: "Samsung", modelo: "Galaxy A",
      ...overrides,
    };
  }

  it("IMEI+OS+data idênticos → 1 grupo", () => {
    const rows = [
      makeRow({ id: 1, id_pedido: "PED-001", concat_peca: "Tela" }),
      makeRow({ id: 2, id_pedido: "PED-002", concat_peca: "Bateria" }),
    ];
    const groups = groupRows(rows, 1);
    expect(groups.length).toBe(1);
    expect(groups[0].rows.length).toBe(2);
  });

  it("mesmo IMEI+OS mas datas diferentes → 2 grupos", () => {
    const rows = [
      makeRow({ id: 1, id_pedido: "PED-001", data_pedido: "2024-01-01" }),
      makeRow({ id: 2, id_pedido: "PED-002", data_pedido: "2024-02-01" }),
    ];
    const groups = groupRows(rows, 1);
    expect(groups.length).toBe(2);
  });

  it("sem IMEI → cada id_pedido vira caso próprio", () => {
    const rows = [
      makeRow({ id: 1, imei: null, id_pedido: "PED-001" }),
      makeRow({ id: 2, imei: null, id_pedido: "PED-002" }),
    ];
    const groups = groupRows(rows, 1);
    expect(groups.length).toBe(2);
  });

  it("sem IMEI → workflowStatus = VERIFICAR", () => {
    const rows = [makeRow({ id: 1, imei: null, id_pedido: "PED-001", status_atual_legado: "MATCH" })];
    const groups = groupRows(rows, 1);
    expect(groups[0].workflowStatus).toBe("VERIFICAR");
  });

  it("legacy_case_key inclui IMEI, OS e data", () => {
    const rows = [makeRow()];
    const groups = groupRows(rows, 1);
    expect(groups[0].legacyCaseKey).toContain("100000000000001");
    expect(groups[0].legacyCaseKey).toContain("2024-01-15");
  });

  it("repair_date extraído de data_pedido (slice YYYY-MM-DD)", () => {
    const rows = [makeRow({ data_pedido: "2024-03-20T00:00:00.000Z" })];
    const groups = groupRows(rows, 1);
    expect(groups[0].repairDate).toBe("2024-03-20");
  });

  it("workflow derivado dos status das peças — MATCH → INDICADA → MATCH case workflow", () => {
    const rows = [
      makeRow({ id: 1, id_pedido: "PED-001", status_atual_legado: "MATCH" }),
      makeRow({ id: 2, id_pedido: "PED-002", status_atual_legado: "MATCH PARCIAL" }),
    ];
    const groups = groupRows(rows, 1);
    // Todos são INDICADA → MATCH
    expect(groups[0].workflowStatus).toBe("MATCH");
  });
});

// ---------------------------------------------------------------------------
// Schema da migration 012 no banco em memória
// ---------------------------------------------------------------------------
describe("migration 012: schema aplicado em banco em memória", () => {
  it("repair_cases tem coluna repair_date após runMigrations", () => {
    const db = makeDb();
    const cols = (db.prepare("PRAGMA table_info(repair_cases)").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toContain("repair_date");
    expect(cols).toContain("repair_date_source");
    expect(cols).toContain("legacy_case_key");
  });

  it("datasys_imports tem coluna staged_file_path após runMigrations", () => {
    const db = makeDb();
    const cols = (db.prepare("PRAGMA table_info(datasys_imports)").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toContain("staged_file_path");
  });

  it("índice único de legacy_case_key impede duplicata no mesmo lote", () => {
    const db = makeDb();
    // Cria lotes antes para satisfazer FK
    const batchCols = "(analysis_file_name,orders_file_name,analysis_file_hash,orders_file_hash,status)";
    const batchVals = "('a.xlsx','b.xlsx','hash1','hash2','COMPLETED')";
    db.prepare(`INSERT INTO import_batches ${batchCols} VALUES ${batchVals}`).run();
    db.prepare(`INSERT INTO import_batches ${batchCols} VALUES ('c.xlsx','d.xlsx','hash3','hash4','COMPLETED')`).run();
    db.prepare(
      `INSERT INTO repair_cases (legacy_import_batch_id, legacy_case_key, analysis_status, workflow_status)
       VALUES (1, 'key-abc', 'DRAFT', 'EM_ANALISE')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO repair_cases (legacy_import_batch_id, legacy_case_key, analysis_status, workflow_status)
         VALUES (1, 'key-abc', 'DRAFT', 'EM_ANALISE')`,
      ).run(),
    ).toThrow();
  });

  it("índice único permite mesma legacy_case_key em lotes diferentes", () => {
    const db = makeDb();
    const batchCols = "(analysis_file_name,orders_file_name,analysis_file_hash,orders_file_hash,status)";
    db.prepare(`INSERT INTO import_batches ${batchCols} VALUES ('a.xlsx','b.xlsx','h1','h2','COMPLETED')`).run();
    db.prepare(`INSERT INTO import_batches ${batchCols} VALUES ('c.xlsx','d.xlsx','h3','h4','COMPLETED')`).run();
    db.prepare(
      `INSERT INTO repair_cases (legacy_import_batch_id, legacy_case_key, analysis_status, workflow_status)
       VALUES (1, 'key-abc', 'DRAFT', 'EM_ANALISE')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO repair_cases (legacy_import_batch_id, legacy_case_key, analysis_status, workflow_status)
         VALUES (2, 'key-abc', 'DRAFT', 'EM_ANALISE')`,
      ).run(),
    ).not.toThrow();
  });
});
