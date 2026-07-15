/**
 * Testes do backfill de campos de prioridade em repair_cases.
 * Tests 1-3 do spec.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  getPriorityCoverage,
  backfillRepairCasePriorityFields,
} from "../src/match/priority-backfill-service.js";

let db: Db;
beforeEach(async () => { db = await createDb(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertCase(
  db: Db,
  opts: {
    imei_norm?: string;
    age_days?: number | null;
    margin?: number | null;
    cost?: number | null;
    estimated_sale?: number | null;
  } = {},
): number {
  const r = db.prepare(`
    INSERT INTO repair_cases
      (imei, imei_norm, workflow_status, analysis_status, created_at, updated_at)
    VALUES (?, ?, 'PEDIR_PECA', 'COMPLETED', datetime('now'), datetime('now'))
  `).run(opts.imei_norm ?? "111111111111111", opts.imei_norm ?? "111111111111111");

  const id = Number(r.lastInsertRowid);

  if (opts.age_days !== undefined || opts.margin !== undefined || opts.cost !== undefined || opts.estimated_sale !== undefined) {
    db.prepare(`
      UPDATE repair_cases
      SET age_days = ?, margin = ?, cost = ?, estimated_sale = ?
      WHERE id = ?
    `).run(
      opts.age_days ?? null,
      opts.margin ?? null,
      opts.cost ?? null,
      opts.estimated_sale ?? null,
      id,
    );
  }
  return id;
}

function getOrCreateBatch(db: Db): number {
  const existing = db.prepare("SELECT id FROM import_batches LIMIT 1").get() as { id: number } | undefined;
  if (existing) return existing.id;
  const r = db.prepare(`
    INSERT INTO import_batches
      (analysis_file_name, orders_file_name, analysis_file_hash, orders_file_hash, status)
    VALUES ('a.xlsx', 'o.xlsx', 'ha', 'ho', 'COMPLETED')
  `).run();
  return Number(r.lastInsertRowid);
}

function insertSop(
  db: Db,
  imei: string,
  idade: number | null,
  custo: number | null,
  venda: number | null,
  margem: number | null,
): void {
  const batchId = getOrCreateBatch(db);
  db.prepare(`
    INSERT INTO source_order_parts
      (import_batch_id, id_pedido, imei, chave_peca, chave_peca_norm, idade, custo, venda, margem_legada,
       status_atual_legado, quantidade_pecas_aparelho, raw_json)
    VALUES (?, ?, ?, 'TELA', 'tela', ?, ?, ?, ?, 'SOLICITADO', 1, '{}')
  `).run(batchId, `PED-${imei}`, imei, idade, custo, venda, margem);
}

// ---------------------------------------------------------------------------
// Test 1: diagnóstico de baixa cobertura
// ---------------------------------------------------------------------------

describe("getPriorityCoverage", () => {
  it("deve retornar lowCoverageAlert=true quando menos de 80% dos casos têm age_days", () => {
    // 5 casos sem nenhum campo preenchido
    for (let i = 0; i < 5; i++) {
      insertCase(db, { imei_norm: `10000000000000${i}` });
    }
    // 1 caso com age_days preenchido
    insertCase(db, { imei_norm: "200000000000001", age_days: 10, margin: 100 });

    const cov = getPriorityCoverage(db);
    expect(cov.totalCompleted).toBe(6);
    expect(cov.withAgeDays).toBe(1);
    expect(cov.pctAgeDays).toBeLessThan(80);
    expect(cov.lowCoverageAlert).toBe(true);
  });

  it("deve retornar lowCoverageAlert=false quando >= 80% têm age_days e margin", () => {
    for (let i = 0; i < 4; i++) {
      insertCase(db, { imei_norm: `30000000000000${i}`, age_days: 20, margin: 50 });
    }
    // 1 sem (20% = abaixo, mas 80% já tem)
    insertCase(db, { imei_norm: "400000000000001" });

    const cov = getPriorityCoverage(db);
    expect(cov.pctAgeDays).toBe(80);
    expect(cov.pctMargin).toBe(80);
    expect(cov.lowCoverageAlert).toBe(false);
  });

  it("deve retornar total=0 e lowCoverageAlert=false sem casos COMPLETED", () => {
    const cov = getPriorityCoverage(db);
    expect(cov.totalCompleted).toBe(0);
    expect(cov.lowCoverageAlert).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: backfill preenche age_days e margin de source_order_parts
// ---------------------------------------------------------------------------

describe("backfillRepairCasePriorityFields", () => {
  it("deve preencher age_days e margin a partir de source_order_parts", () => {
    const imei = "555000000000001";
    insertCase(db, { imei_norm: imei });
    insertSop(db, imei, 45, 300, 600, 300);

    const result = backfillRepairCasePriorityFields(db);

    expect(result.casesEligible).toBeGreaterThan(0);
    expect(result.ageDaysUpdated).toBeGreaterThanOrEqual(1);

    const rc = db.prepare("SELECT age_days, cost, estimated_sale, margin FROM repair_cases WHERE imei_norm = ?").get(imei) as { age_days: number; cost: number; estimated_sale: number; margin: number } | undefined;
    expect(rc).toBeDefined();
    expect(rc!.age_days).toBe(45);
    expect(rc!.cost).toBe(300);
    expect(rc!.estimated_sale).toBe(600);
    // Margem calculada: venda - custo = 300
    expect(rc!.margin).toBe(300);
  });

  it("deve usar margem_legada quando custo e venda estão ausentes", () => {
    const imei = "555000000000002";
    insertCase(db, { imei_norm: imei });
    insertSop(db, imei, 10, null, null, 120);

    backfillRepairCasePriorityFields(db);

    const rc = db.prepare("SELECT margin FROM repair_cases WHERE imei_norm = ?").get(imei) as { margin: number } | undefined;
    expect(rc!.margin).toBe(120);
  });

  // ---------------------------------------------------------------------------
  // Test 3: backfill não sobrescreve valor já preenchido
  // ---------------------------------------------------------------------------

  it("não deve sobrescrever age_days ou margin já preenchidos", () => {
    const imei = "666000000000001";
    // Caso já com age_days=99 e margin=999
    insertCase(db, { imei_norm: imei, age_days: 99, margin: 999 });
    // SOP com valores diferentes
    insertSop(db, imei, 10, 100, 200, 100);

    backfillRepairCasePriorityFields(db);

    const rc = db.prepare("SELECT age_days, margin FROM repair_cases WHERE imei_norm = ?").get(imei) as { age_days: number; margin: number };
    expect(rc.age_days).toBe(99);
    expect(rc.margin).toBe(999);
  });

  it("deve reportar skipped para casos sem fontes disponíveis", () => {
    insertCase(db, { imei_norm: "777000000000001" }); // sem SOP, sem HIS
    const result = backfillRepairCasePriorityFields(db);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
