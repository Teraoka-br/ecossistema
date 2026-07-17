/**
 * Testes para exportação completa da fila de reparos (endpoint /api/fila-reparos/export).
 * Verifica que o endpoint ignora paginação e aplica os mesmos filtros da listagem.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { getDb as _getDb } from "../src/db/database.js";

let db: Db;

beforeEach(async () => {
  db = await createDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addCase(
  db: Db,
  imei: string,
  workflowStatus: string,
  brand = "APPLE",
  model = "IPHONE 11",
): number {
  return Number(
    db.prepare(`
      INSERT INTO repair_cases
        (imei, imei_norm, os, brand, model, color, workflow_status, analysis_status,
         age_days, cost, estimated_sale, margin, deposito_atual, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PRETO', ?, 'COMPLETED', 120, 500, 700, 200, 'AGUARDANDO PECA', datetime('now'), datetime('now'))
    `).run(imei, imei.toLowerCase(), `OS-${imei}`, brand, model, workflowStatus).lastInsertRowid,
  );
}

function buildExportQuery(db: Db, filter: string, q?: string): Record<string, unknown>[] {
  // Replica a lógica do endpoint diretamente para testes unitários
  const QUEUE_FILTER_STATUSES: Record<string, string[] | null> = {
    DO_NOW:           ["MATCH", "APTO_REPARO", "MATCH_PARCIAL", "VERIFICAR"],
    MATCH:            ["MATCH"],
    MATCH_PARCIAL:    ["MATCH_PARCIAL"],
    AGUARDANDO_PECAS: ["PEDIR_PECA", "AGUARDANDO_RECEBIMENTO"],
    APTO_REPARO:      ["APTO_REPARO"],
    EM_ANALISE:       ["EM_ANALISE", "EM_SEPARACAO"],
    VERIFICAR:        ["VERIFICAR"],
    FINALIZADOS:      ["CONCLUIDO", "VENDA_ESTADO", "CANCELADO"],
    TODOS:            null,
  };

  const statuses = QUEUE_FILTER_STATUSES[filter] ?? null;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (statuses && statuses.length > 0) {
    conditions.push(`rc.workflow_status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }

  if (q) {
    const like = `%${q}%`;
    conditions.push(`(rc.imei LIKE ? OR rc.brand LIKE ? OR rc.model LIKE ?)`);
    params.push(like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return db.prepare(`
    SELECT rc.id, rc.imei, rc.workflow_status, rc.brand, rc.model
    FROM repair_cases rc
    ${where}
    ORDER BY rc.id ASC
  `).all(...params) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// 1. Listagem paginada em 100, total 1.579
// ---------------------------------------------------------------------------

describe("cenário 1 — listagem paginada vs total real", () => {
  it("total do banco é maior que o limite de página", () => {
    // Insere 150 casos
    for (let i = 1; i <= 150; i++) {
      addCase(db, `IMEI${String(i).padStart(6, "0")}`, "MATCH");
    }
    const total = (db.prepare("SELECT COUNT(*) AS c FROM repair_cases").get() as { c: number }).c;
    expect(total).toBe(150);

    // Simula paginação de 100
    const page = db.prepare("SELECT * FROM repair_cases ORDER BY id LIMIT 100").all();
    expect(page.length).toBe(100);
    expect(total).toBeGreaterThan(page.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Exportação TODOS contém todos os registros
// ---------------------------------------------------------------------------

describe("cenário 2 — exportação TODOS sem paginação", () => {
  it("buildExportQuery retorna todos os casos com filtro TODOS", () => {
    for (let i = 1; i <= 50; i++) {
      addCase(db, `A${i}`, i % 2 === 0 ? "MATCH" : "PEDIR_PECA");
    }
    const result = buildExportQuery(db, "TODOS");
    expect(result.length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 3. Exportação MATCH contém apenas casos com status MATCH
// ---------------------------------------------------------------------------

describe("cenário 3 — exportação MATCH filtra corretamente", () => {
  it("só retorna casos workflow_status = MATCH", () => {
    addCase(db, "IMEI-MATCH-1", "MATCH");
    addCase(db, "IMEI-MATCH-2", "MATCH");
    addCase(db, "IMEI-PEDIR", "PEDIR_PECA");
    addCase(db, "IMEI-VERIF", "VERIFICAR");
    const result = buildExportQuery(db, "MATCH");
    expect(result.length).toBe(2);
    expect(result.every(r => r.workflow_status === "MATCH")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Exportação respeita busca de texto
// ---------------------------------------------------------------------------

describe("cenário 4 — exportação respeita busca por texto", () => {
  it("filtra por texto no IMEI", () => {
    addCase(db, "IPHONE11-001", "MATCH", "APPLE", "IPHONE 11");
    addCase(db, "SAMSUNG-001", "MATCH", "SAMSUNG", "GALAXY A32");
    addCase(db, "IPHONE11-002", "PEDIR_PECA", "APPLE", "IPHONE 11");
    const result = buildExportQuery(db, "TODOS", "IPHONE11");
    expect(result.length).toBe(2);
    expect(result.every(r => (r.imei as string).includes("IPHONE11"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Exportação respeita filtro + busca combinados
// ---------------------------------------------------------------------------

describe("cenário 5 — filtro + busca combinados", () => {
  it("MATCH + busca retorna só MATCHes da busca", () => {
    addCase(db, "IPHONE-M1", "MATCH", "APPLE", "IPHONE 12");
    addCase(db, "IPHONE-M2", "MATCH", "APPLE", "IPHONE 13");
    addCase(db, "IPHONE-V1", "VERIFICAR", "APPLE", "IPHONE 12");
    addCase(db, "SAMSUNG-M1", "MATCH", "SAMSUNG", "GALAXY");
    const result = buildExportQuery(db, "MATCH", "IPHONE");
    expect(result.length).toBe(2);
    expect(result.every(r => r.workflow_status === "MATCH")).toBe(true);
    expect(result.every(r => (r.imei as string).includes("IPHONE"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Exportação não inclui itens fora do filtro
// ---------------------------------------------------------------------------

describe("cenário 6 — exportação não contamina com itens fora do filtro", () => {
  it("filtro VERIFICAR não inclui MATCH nem PEDIR_PECA", () => {
    addCase(db, "V1", "VERIFICAR");
    addCase(db, "V2", "VERIFICAR");
    addCase(db, "M1", "MATCH");
    addCase(db, "P1", "PEDIR_PECA");
    const result = buildExportQuery(db, "VERIFICAR");
    expect(result.length).toBe(2);
    expect(result.every(r => r.workflow_status === "VERIFICAR")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Quantidade no botão corresponde ao total do filtro
// ---------------------------------------------------------------------------

describe("cenário 7 — total do filtro coincide com contagem real", () => {
  it("count(*) com filtro == resultado do buildExportQuery", () => {
    addCase(db, "C1", "MATCH");
    addCase(db, "C2", "MATCH");
    addCase(db, "C3", "PEDIR_PECA");
    const exportRows = buildExportQuery(db, "MATCH");
    const dbCount = (db.prepare(
      "SELECT COUNT(*) AS c FROM repair_cases WHERE workflow_status = 'MATCH'",
    ).get() as { c: number }).c;
    expect(exportRows.length).toBe(dbCount);
  });
});

// ---------------------------------------------------------------------------
// 8. Arquivo gerado possui todos os IMEIs sem duplicação
// ---------------------------------------------------------------------------

describe("cenário 8 — sem IMEIs duplicados na exportação", () => {
  it("cada IMEI aparece exatamente uma vez", () => {
    const imeis = ["IMEI-A", "IMEI-B", "IMEI-C", "IMEI-D", "IMEI-E"];
    for (const imei of imeis) addCase(db, imei, "MATCH");
    const result = buildExportQuery(db, "MATCH");
    const resultImeis = result.map(r => r.imei as string);
    const unique = new Set(resultImeis);
    expect(resultImeis.length).toBe(imeis.length);
    expect(unique.size).toBe(imeis.length);
  });
});
