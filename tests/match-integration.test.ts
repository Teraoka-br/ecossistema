/**
 * Teste de integração do motor de match — cenário de ponta a ponta em DB em memória.
 *
 * Cenário simples e determinístico:
 *   IMEI_A: 1 peça (BAT), age=90 (alta prioridade) → MATCH
 *   IMEI_B: 1 peça (BAT), age=5  (baixa prioridade) → SEM SALDO (BAT esgotado)
 *   IMEI_C: 1 peça (TELA) → PEDIR PECA (TELA não existe no estoque)
 *   IMEI_F: já CONCLUIDO → PRESERVED
 *   Sem IMEI: 1 peça (BAT) → VERIFICAR / MISSING_IMEI
 *
 * Estoque: 1 × PC-1 (BAT). Apenas IMEI_A recebe.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm } from "../src/import/import-service.js";
import { runMatch, getCurrentState, isRunStale } from "../src/match/match-service.js";
import {
  listDeviceResults,
  listLineResults,
  getStockSummaryFromResults,
  getComparisonData,
  exportResultsCsv,
} from "../src/match/match-repository.js";
import {
  ANALYSIS_HEADER,
  BIPAGEM_HEADER,
  ORDERS_HEADER,
  QUOTATION_HEADER,
  cleanup,
  makeXlsx,
  orderRow,
} from "./helpers.js";

const created: string[] = [];
let db: Db;
let runId: number;

beforeAll(() => {
  db = openDatabase(":memory:");
  runMigrations(db);

  // 5 linhas de pedido: A1 (BAT, age=90), B1 (BAT, age=5), C1 (TELA), F1 (CONCLUIDO), sem-imei
  const ordersPath = makeXlsx(
    [
      {
        name: "PEDIDOS",
        aoa: [
          ORDERS_HEADER,
          orderRow({ idPedido: "A1", imei: "IMEI_A", os: "OS1", chave: "BAT", ref: "PC-1", status: "SOLICITADO", qtde: 1, idade: 90, custo: 100, venda: 200 }),
          orderRow({ idPedido: "B1", imei: "IMEI_B", os: "OS2", chave: "BAT", ref: "PC-1", status: "SOLICITADO", qtde: 1, idade: 5,  custo: 100, venda: 200 }),
          orderRow({ idPedido: "C1", imei: "IMEI_C", os: "OS3", chave: "TELA", ref: "PC-2", status: "SOLICITADO", qtde: 1, idade: 30, custo: 50, venda: 100 }),
          orderRow({ idPedido: "F1", imei: "IMEI_F", os: "OS4", chave: "BAT", ref: "PC-1", status: "CONCLUIDO", qtde: 1, idade: 30, custo: 100, venda: 200 }),
          orderRow({ idPedido: "NI1", imei: "", os: "OS5", chave: "BAT", ref: "PC-1", status: "SOLICITADO", qtde: 1, idade: 20, custo: 100, venda: 200 }),
        ],
      },
      {
        name: "BIPAGEM DE PEÇAS",
        aoa: [
          BIPAGEM_HEADER,
          // Apenas PC-1 → BAT está no estoque (1 unidade)
          ["PC-1", "Bateria", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
          // PC-2 (TELA) não está: para testar PEDIR PECA
        ],
      },
    ],
    "PEDIDOS.xlsx",
  );

  const analysisPath = makeXlsx(
    [
      { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER] },
      { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
    ],
    "ANALISE MI.xlsx",
  );
  created.push(ordersPath, analysisPath);

  confirm(db, preview(db, { filePath: ordersPath, fileName: "PEDIDOS.xlsx" }, { filePath: analysisPath, fileName: "ANALISE MI.xlsx" }).previewBatchId);

  const result = runMatch(db, { createdBy: "Integrador" });
  runId = result.run.id;
});

afterAll(() => {
  while (created.length) cleanup(created.pop()!);
});

// ---------------------------------------------------------------------------
// Estado atual
// ---------------------------------------------------------------------------

describe("integração — estado atual", () => {
  it("sistema inicializado após importação", () => {
    expect(getCurrentState(db).initialized).toBe(true);
  });

  it("hash computado com sucesso (64 chars hex)", () => {
    expect(getCurrentState(db).hash).toHaveLength(64);
  });

  it("run não está stale logo após execução", () => {
    const run = db.prepare("SELECT status, input_hash FROM match_runs WHERE id = ?").get(runId) as {
      status: string;
      input_hash: string;
    };
    expect(isRunStale(db, { status: "COMPLETED", input_hash: run.input_hash } as Parameters<typeof isRunStale>[1])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aparelhos
// ---------------------------------------------------------------------------

describe("integração — aparelhos", () => {
  it("IMEI_A recebe kit completo (BAT, maior score)", () => {
    const { devices } = listDeviceResults(db, runId, { limit: 50, offset: 0 });
    const devA = devices.find((d) => d.imei === "IMEI_A");
    expect(devA).toBeDefined();
    expect(devA!.kit_status).toBe("KIT POSSIVEL");
  });

  it("IMEI_B fica sem saldo (BAT esgotado por IMEI_A)", () => {
    const { devices } = listDeviceResults(db, runId, { limit: 50, offset: 0 });
    const devB = devices.find((d) => d.imei === "IMEI_B");
    expect(devB).toBeDefined();
    // Com apenas 1 BAT, IMEI_A (maior score) consome; IMEI_B fica incompleto
    expect(["KIT INCOMPLETO", "MATCH PARCIAL"]).toContain(devB!.kit_status);
  });

  it("IMEI_F (permanente) tem allocationPhase PRESERVED", () => {
    const { devices } = listDeviceResults(db, runId, { limit: 50, offset: 0 });
    const devF = devices.find((d) => d.imei === "IMEI_F");
    expect(devF).toBeDefined();
    expect(devF!.allocation_phase).toBe("PRESERVED");
  });

  it("sem-IMEI agrupa em __NO_IMEI__ com kitStatus VERIFICAR", () => {
    const { devices } = listDeviceResults(db, runId, { limit: 50, offset: 0 });
    const devNI = devices.find((d) => d.device_key === "__NO_IMEI__");
    expect(devNI).toBeDefined();
    expect(devNI!.kit_status).toBe("VERIFICAR");
  });
});

// ---------------------------------------------------------------------------
// Linhas individuais
// ---------------------------------------------------------------------------

describe("integração — linhas individuais", () => {
  it("todos os pedidos têm exatamente uma linha em match_results", () => {
    const count = (
      db
        .prepare("SELECT COUNT(*) AS c FROM match_results WHERE match_run_id = ?")
        .get(runId) as { c: number }
    ).c;
    expect(count).toBe(5); // A1, B1, C1, F1, NI1
  });

  it("A1 (BAT para IMEI_A) é MATCH com allocationPhase FULL", () => {
    const { results } = listLineResults(db, runId, { limit: 100, offset: 0 });
    const lineA1 = results.find((r) => r.id_pedido === "A1");
    expect(lineA1).toBeDefined();
    expect(lineA1!.result_status).toBe("MATCH");
    expect(lineA1!.allocation_phase).toBe("FULL");
  });

  it("B1 (BAT para IMEI_B) não é MATCH (BAT esgotado)", () => {
    const { results } = listLineResults(db, runId, { limit: 100, offset: 0 });
    const lineB1 = results.find((r) => r.id_pedido === "B1");
    expect(lineB1).toBeDefined();
    expect(lineB1!.result_status).toBe("SEM SALDO");
  });

  it("C1 (TELA) é PEDIR PECA (TELA nunca esteve no estoque)", () => {
    const { results } = listLineResults(db, runId, { limit: 100, offset: 0 });
    const lineC1 = results.find((r) => r.id_pedido === "C1");
    expect(lineC1).toBeDefined();
    expect(lineC1!.result_status).toBe("PEDIR PECA");
  });

  it("F1 (CONCLUIDO permanente) tem allocation_phase PRESERVED e reserved_units 0", () => {
    const { results } = listLineResults(db, runId, { limit: 100, offset: 0 });
    const lineF1 = results.find((r) => r.id_pedido === "F1");
    expect(lineF1).toBeDefined();
    expect(lineF1!.allocation_phase).toBe("PRESERVED");
    expect(lineF1!.reserved_units).toBe(0);
  });

  it("NI1 (sem IMEI) tem result_status VERIFICAR e reason_code MISSING_IMEI", () => {
    const { results } = listLineResults(db, runId, { limit: 100, offset: 0 });
    const lineNI1 = results.find((r) => r.id_pedido === "NI1");
    expect(lineNI1).toBeDefined();
    expect(lineNI1!.result_status).toBe("VERIFICAR");
    expect(lineNI1!.reason_code).toBe("MISSING_IMEI");
  });
});

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

describe("integração — estoque", () => {
  it("resumo de estoque contém pelo menos uma entrada", () => {
    const summary = getStockSummaryFromResults(db, runId);
    expect(summary.length).toBeGreaterThan(0);
  });

  it("SUM(reserved_units) == run.allocated_units", () => {
    const run = db.prepare("SELECT allocated_units FROM match_runs WHERE id = ?").get(runId) as {
      allocated_units: number;
    };
    const sumR = (
      db
        .prepare(
          "SELECT COALESCE(SUM(reserved_units), 0) AS s FROM match_results WHERE match_run_id = ?",
        )
        .get(runId) as { s: number }
    ).s;
    expect(sumR).toBe(run.allocated_units);
  });

  it("alocação por CHAVEPECA não excede estoque inicial", () => {
    const summary = getStockSummaryFromResults(db, runId);
    for (const s of summary) {
      expect(s.allocated_total).toBeLessThanOrEqual(s.stock_initial);
    }
  });
});

// ---------------------------------------------------------------------------
// Comparação e export
// ---------------------------------------------------------------------------

describe("integração — comparação e export", () => {
  it("getComparisonData retorna todas as 5 linhas", () => {
    const { total } = getComparisonData(db, runId, { limit: 100, offset: 0, onlyDivergent: false });
    expect(total).toBe(5);
  });

  it("onlyDivergent retorna subconjunto do total", () => {
    const { results: all } = getComparisonData(db, runId, { limit: 100, offset: 0, onlyDivergent: false });
    const { results: div } = getComparisonData(db, runId, { limit: 100, offset: 0, onlyDivergent: true });
    expect(div.length).toBeLessThanOrEqual(all.length);
  });

  it("exportResultsCsv retorna CSV com cabeçalho correto e dados", () => {
    const csv = exportResultsCsv(db, runId, false);
    const lines = csv.split("\n");
    const header = lines[0];
    // Cabeçalhos em português definidos pelo exportador
    expect(header).toContain("id_pedido");
    expect(header).toContain("status_calculado");
    expect(header).toContain("status_legado");
    expect(header).toContain("allocation_phase");
    // Ao menos uma linha de dados além do cabeçalho
    expect(lines.length).toBeGreaterThan(1);
    // ID_PEDIDO conhecido (A1 → MATCH)
    expect(csv).toContain("A1");
    expect(csv).toContain("MATCH");
  });

  it("CSV de divergências tem menos linhas que o CSV completo e contém dados quando há divergências", () => {
    const full = exportResultsCsv(db, runId, false);
    const div = exportResultsCsv(db, runId, true);
    const fullLines = full.split("\n");
    const divLines = div.split("\n");
    // divergente nunca tem mais linhas que o completo
    expect(divLines.length).toBeLessThanOrEqual(fullLines.length);
    // No cenário de integração há divergências (B1 ficou sem saldo, C1 pediu peça)
    // logo o CSV de divergências deve ter ao menos o cabeçalho + 1 linha de dado
    expect(divLines.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Paginação
// ---------------------------------------------------------------------------

describe("integração — paginação de aparelhos", () => {
  it("listDeviceResults com limit=2 retorna 2 aparelhos", () => {
    const { devices, total } = listDeviceResults(db, runId, { limit: 2, offset: 0 });
    expect(devices).toHaveLength(2);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("filtro por kitStatus KIT POSSIVEL retorna apenas IMEI_A", () => {
    const { devices } = listDeviceResults(db, runId, {
      limit: 50,
      offset: 0,
      kitStatus: "KIT POSSIVEL",
    });
    expect(devices.every((d) => d.kit_status === "KIT POSSIVEL")).toBe(true);
    expect(devices.some((d) => d.imei === "IMEI_A")).toBe(true);
  });

  it("busca por IMEI retorna o aparelho correto", () => {
    const { devices } = listDeviceResults(db, runId, { limit: 50, offset: 0, search: "IMEI_A" });
    expect(devices.some((d) => d.imei === "IMEI_A")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reutilização e staleness
// ---------------------------------------------------------------------------

describe("integração — reutilização e staleness", () => {
  it("segunda execução com mesmo estado reutiliza o run", () => {
    const r2 = runMatch(db, { createdBy: "Integrador" });
    expect(r2.reused).toBe(true);
    expect(r2.run.id).toBe(runId);
  });

  it("nova execução após mudança de regra cria novo run", () => {
    db.prepare("UPDATE decision_rules SET age_days_per_point = 999 WHERE active = 1").run();
    const r3 = runMatch(db, { createdBy: "Integrador" });
    expect(r3.reused).toBe(false);
    expect(r3.run.id).toBeGreaterThan(runId);
    // Restaurar
    db.prepare("UPDATE decision_rules SET age_days_per_point = 10 WHERE active = 1").run();
  });
});
