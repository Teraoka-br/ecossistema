/**
 * Testes de integração do motor único de match com SQLite em memória.
 * Cobrem os itens 24, 32-34 e 38-48 da lista obrigatória (o restante, puro,
 * está em calculate-match.test.ts).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import {
  runRepairMatchEngine,
  requestMatchRecompute,
  processPendingRecompute,
} from "../src/match/engine-orchestrator.js";
import { MatchRuleStateError } from "../src/match/engine-loader.js";
import { simulateMatchRules } from "../src/match/simulate-service.js";
import {
  activateRuleSet,
  createDraftRuleSet,
  getActiveRuleSet,
  listRuleSets,
} from "../src/match/match-rule-service.js";
import { createPartKeyAlias, deactivatePartKeyAlias } from "../src/operational/part-keys-service.js";
import { getCurrentOperationalStock } from "../src/operational/stock-service.js";
import { reserveKit, releaseReservation } from "../src/operational/reservation-service.js";
import { applyRelSeriaisToRepairCases } from "../src/import-central/operational-sync-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

let seq = 1;

/** Cria um caso pronto para o motor (análise COMPLETED, dados completos). */
function seedCase(
  db: Db,
  over: {
    chaves?: string[];
    cost?: number | null;
    sale?: number | null;
    age?: number | null;
    deposito?: string | null;
    workflow?: string;
    imei?: string | null;
    model?: string | null;
    partStatus?: string;
  } = {},
): { caseId: number; partIds: number[] } {
  const imei = over.imei !== undefined ? over.imei : `3500000000${String(seq++).padStart(5, "0")}`;
  const r = db.prepare(`
    INSERT INTO repair_cases
      (imei, imei_norm, model, brand, cost, estimated_sale, age_days, deposito_atual,
       analysis_status, workflow_status)
    VALUES (?,?,?,?,?,?,?,?, 'COMPLETED', ?)
  `).run(
    imei, imei,
    over.model !== undefined ? over.model : "IPHONE 12",
    "APPLE",
    over.cost !== undefined ? over.cost : 500,
    over.sale !== undefined ? over.sale : 1235,
    over.age !== undefined ? over.age : 102,
    over.deposito !== undefined ? over.deposito : "AGUARDANDO PECA",
    over.workflow ?? "PEDIR_PECA",
  );
  const caseId = r.lastInsertRowid as number;
  const partIds: number[] = [];
  for (const chave of over.chaves ?? ["BATERIA X"]) {
    const p = db.prepare(`
      INSERT INTO part_requests (repair_case_id, description, chave_peca, chave_peca_norm, status)
      VALUES (?,?,?,?,?)
    `).run(caseId, chave, chave, chave, over.partStatus ?? "PEDIR_PECA");
    partIds.push(p.lastInsertRowid as number);
  }
  return { caseId, partIds };
}

/** Injeta estoque físico via movimentação (base vazia + movimentos). */
function seedStock(db: Db, chave: string, ref: string, qty: number): void {
  db.prepare(`
    INSERT INTO stock_movements
      (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity, source_type)
    VALUES ('PURCHASE_RECEIPT', ?, ?, ?, ?, ?, 'seed')
  `).run(ref, ref, chave, chave, qty);
}

function caseStatus(db: Db, caseId: number): string {
  return (db.prepare("SELECT workflow_status AS s FROM repair_cases WHERE id = ?").get(caseId) as { s: string }).s;
}

let db: Db;
beforeEach(() => {
  db = makeDb();
});

// ---------------------------------------------------------------------------
// 24. Fonte automática de depósito é somente o Rel. Seriais (Com Saldo)
// ---------------------------------------------------------------------------

describe("24. depósito automático vem somente do Rel. Seriais Com Saldo", () => {
  it("sync aplica deposito_atual do rel_seriais_saldo_current ao caso pelo IMEI", () => {
    const { caseId } = seedCase(db, { deposito: null, imei: "111222333444555" });
    db.prepare(`
      INSERT INTO rel_seriais_saldo_current (imei_norm, serial, deposito_atual, filial_atual)
      VALUES ('111222333444555', '111222333444555', 'MANUTENCAO INTERNA', 'MATRIZ')
    `).run();
    applyRelSeriaisToRepairCases(db);
    const row = db.prepare("SELECT deposito_atual FROM repair_cases WHERE id = ?").get(caseId) as { deposito_atual: string };
    expect(row.deposito_atual).toBe("MANUTENCAO INTERNA");
  });

  it("aparelho ausente do Com Saldo perde depósito (nunca herdado de outra fonte)", () => {
    const { caseId } = seedCase(db, { deposito: "AGUARDANDO PECA", imei: "999888777666555" });
    // Existe no "Todos" mas NÃO no "Com Saldo"
    db.prepare(
      "INSERT INTO rel_seriais_imports (filename, file_hash, status) VALUES ('teste.csv', 'h1', 'COMPLETED')",
    ).run();
    db.prepare(`
      INSERT INTO rel_seriais_current (rel_seriais_import_id, imei_norm, serial, deposito_atual)
      VALUES ((SELECT MAX(id) FROM rel_seriais_imports), '999888777666555', '999888777666555', 'TRIAGEM')
    `).run();
    applyRelSeriaisToRepairCases(db);
    const row = db.prepare("SELECT deposito_atual FROM repair_cases WHERE id = ?").get(caseId) as { deposito_atual: string | null };
    expect(row.deposito_atual).toBeNull(); // "Todos"/TRIAGEM nunca vira depósito
  });
});

// ---------------------------------------------------------------------------
// 32. Match parcial não cria reserva real
// ---------------------------------------------------------------------------

describe("32. o motor apenas sinaliza — nunca reserva/movimenta", () => {
  it("MATCH e MATCH_PARCIAL não criam reservas, movimentações nem eventos", async () => {
    seedStock(db, "BATERIA X", "R1", 1);
    seedCase(db, { chaves: ["BATERIA X"] });                 // vira MATCH
    seedCase(db, { chaves: ["BATERIA X", "TELA X"] });       // vira parcial/pedido

    const movsBefore = (db.prepare("SELECT COUNT(*) c FROM stock_movements").get() as { c: number }).c;
    const eventsBefore = (db.prepare("SELECT COUNT(*) c FROM operational_events").get() as { c: number }).c;

    await runRepairMatchEngine(db);

    expect((db.prepare("SELECT COUNT(*) c FROM operational_reservations").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM stock_movements").get() as { c: number }).c).toBe(movsBefore);
    expect((db.prepare("SELECT COUNT(*) c FROM operational_events").get() as { c: number }).c).toBe(eventsBefore);
  });
});

// ---------------------------------------------------------------------------
// 33/34. Separação manual reduz o disponível; cancelamento devolve
// ---------------------------------------------------------------------------

describe("33/34. reserva manual e estoque disponível", () => {
  it("33. separação manual reduz o estoque disponível", () => {
    seedStock(db, "BATERIA X", "R1", 5);
    const { caseId, partIds } = seedCase(db, { chaves: ["BATERIA X"], workflow: "MATCH" });

    reserveKit(db, caseId, [{
      partRequestId: partIds[0], chavePeca: "BATERIA X", reference: "R1", quantity: 1, availableQty: 5,
    }], null);

    const stock = getCurrentOperationalStock(db);
    const g = stock.groups.find((x) => x.chavePecaNorm === "BATERIA X")!;
    expect(g.currentQuantity).toBe(5);
    expect(g.reservedQuantity).toBe(1);
    expect(g.availableQuantity).toBe(4);
  });

  it("34. cancelar a separação devolve o saldo disponível", () => {
    seedStock(db, "BATERIA X", "R1", 5);
    const { caseId, partIds } = seedCase(db, { chaves: ["BATERIA X"], workflow: "MATCH" });
    reserveKit(db, caseId, [{
      partRequestId: partIds[0], chavePeca: "BATERIA X", reference: "R1", quantity: 1, availableQty: 5,
    }], null);

    releaseReservation(db, partIds[0], { reason: "cancelado no teste", userId: null });

    const g = getCurrentOperationalStock(db).groups.find((x) => x.chavePecaNorm === "BATERIA X")!;
    expect(g.reservedQuantity).toBe(0);
    expect(g.availableQuantity).toBe(5);
  });

  it("unidade reservada não é sinalizada pelo motor para outro card", async () => {
    seedStock(db, "BATERIA X", "R1", 1);
    const a = seedCase(db, { chaves: ["BATERIA X"], workflow: "MATCH" });
    const b = seedCase(db, { chaves: ["BATERIA X"] });
    reserveKit(db, a.caseId, [{
      partRequestId: a.partIds[0], chavePeca: "BATERIA X", reference: "R1", quantity: 1, availableQty: 1,
    }], null);

    await runRepairMatchEngine(db);
    expect(caseStatus(db, b.caseId)).toBe("PEDIR_PECA"); // única unidade está reservada (João levou)
  });
});

// ---------------------------------------------------------------------------
// 38. Alterar compatibilidade dispara recálculo
// ---------------------------------------------------------------------------

describe("38. compatibilidade dispara recálculo", () => {
  it("criar vínculo enfileira recálculo e o motor passa a usar a referência vinculada", async () => {
    seedStock(db, "BATERIA IPHONE 12/12 PRO", "RF9", 2);
    const { caseId } = seedCase(db, { chaves: ["BATERIA IPHONE 12"] });

    await runRepairMatchEngine(db);
    expect(caseStatus(db, caseId)).toBe("PEDIR_PECA"); // sem vínculo, sem presunção por texto

    createPartKeyAlias(db, { requestedChavePeca: "BATERIA IPHONE 12", stockChavePeca: "BATERIA IPHONE 12/12 PRO" });
    const pending = (db.prepare("SELECT COUNT(*) c FROM match_recompute_requests WHERE processed_at IS NULL").get() as { c: number }).c;
    expect(pending).toBeGreaterThan(0); // recálculo solicitado pela alteração

    const run = await processPendingRecompute(db);
    expect(run).not.toBeNull();
    expect(caseStatus(db, caseId)).toBe("MATCH");
  });

  it("desativar vínculo também dispara recálculo (card volta a PEDIR_PECA)", async () => {
    seedStock(db, "BATERIA IPHONE 12/12 PRO", "RF9", 2);
    const { caseId } = seedCase(db, { chaves: ["BATERIA IPHONE 12"] });
    const alias = createPartKeyAlias(db, { requestedChavePeca: "BATERIA IPHONE 12", stockChavePeca: "BATERIA IPHONE 12/12 PRO" });
    await processPendingRecompute(db);
    expect(caseStatus(db, caseId)).toBe("MATCH");

    deactivatePartKeyAlias(db, alias.id);
    await processPendingRecompute(db);
    expect(caseStatus(db, caseId)).toBe("PEDIR_PECA");
  });
});

// ---------------------------------------------------------------------------
// 39/40. Simulação segura e idêntica ao motor real
// ---------------------------------------------------------------------------

describe("39/40. simulação", () => {
  it("39. simulação não escreve no banco", async () => {
    seedStock(db, "BATERIA X", "R1", 1);
    seedCase(db, { chaves: ["BATERIA X"] });
    seedCase(db, { chaves: ["BATERIA X"] });
    seedCase(db, { deposito: null });

    const dump = () => JSON.stringify({
      runs: db.prepare("SELECT COUNT(*) c FROM repair_match_runs").get(),
      results: db.prepare("SELECT COUNT(*) c FROM repair_match_results").get(),
      caseResults: db.prepare("SELECT COUNT(*) c FROM repair_match_case_results").get(),
      cases: db.prepare("SELECT id, workflow_status, updated_at FROM repair_cases ORDER BY id").all(),
      parts: db.prepare("SELECT id, status FROM part_requests ORDER BY id").all(),
      reservations: db.prepare("SELECT COUNT(*) c FROM operational_reservations").get(),
      movements: db.prepare("SELECT COUNT(*) c FROM stock_movements").get(),
      rules: db.prepare("SELECT id, active FROM match_rule_sets ORDER BY id").all(),
    });

    const before = dump();
    await simulateMatchRules(db, { compareWithActive: true });
    expect(dump()).toBe(before);
  });

  it("40. simulação da regra ativa reproduz exatamente o motor real", async () => {
    seedStock(db, "BATERIA X", "R1", 2);
    seedStock(db, "TELA X", "R2", 1);
    seedCase(db, { chaves: ["BATERIA X", "TELA X"], sale: 2000 });
    seedCase(db, { chaves: ["BATERIA X"], sale: 800 });
    seedCase(db, { chaves: ["TELA Y"] });
    seedCase(db, { deposito: "TRIAGEM" });
    seedCase(db, { cost: null });

    const sim = await simulateMatchRules(db, {});
    const real = await runRepairMatchEngine(db);

    expect(sim.casesEvaluated).toBe(real.casesEvaluated);
    expect(sim.fullKitsFound).toBe(real.fullKitsFound);
    expect(sim.partialKitsFound).toBe(real.partialKitsFound);
    expect(sim.verificarCount).toBe(real.verificarCount);

    // Status persistido por caso = status simulado por caso
    const persisted = db.prepare(
      "SELECT repair_case_id, result_status FROM repair_match_case_results WHERE run_id = ? ORDER BY repair_case_id",
    ).all(real.runId) as { repair_case_id: number; result_status: string }[];
    const persistedCounts: Record<string, number> = {};
    for (const p of persisted) persistedCounts[p.result_status] = (persistedCounts[p.result_status] ?? 0) + 1;
    expect(persistedCounts["MATCH"] ?? 0).toBe(sim.fullKitsFound);
    expect(persistedCounts["MATCH_PARCIAL"] ?? 0).toBe(sim.partialKitsFound);
    expect(persistedCounts["PEDIR_PECA"] ?? 0).toBe(sim.pedirPecaCount);
    expect(persistedCounts["VERIFICAR"] ?? 0).toBe(sim.verificarCount);
  });
});

// ---------------------------------------------------------------------------
// 41. Idempotência
// ---------------------------------------------------------------------------

describe("41. rodar o motor duas vezes é idempotente", () => {
  it("segunda execução sem mudanças não altera nada", async () => {
    seedStock(db, "BATERIA X", "R1", 1);
    seedCase(db, { chaves: ["BATERIA X"] });
    seedCase(db, { chaves: ["BATERIA X"] });
    seedCase(db, { deposito: null });

    const run1 = await runRepairMatchEngine(db);
    const stateAfter1 = JSON.stringify({
      cases: db.prepare("SELECT id, workflow_status FROM repair_cases ORDER BY id").all(),
      parts: db.prepare("SELECT id, status FROM part_requests ORDER BY id").all(),
    });
    const results1 = db.prepare(
      "SELECT repair_case_id, result_status, score, priority_rank FROM repair_match_case_results WHERE run_id = ? ORDER BY repair_case_id",
    ).all(run1.runId);

    const run2 = await runRepairMatchEngine(db);
    const stateAfter2 = JSON.stringify({
      cases: db.prepare("SELECT id, workflow_status FROM repair_cases ORDER BY id").all(),
      parts: db.prepare("SELECT id, status FROM part_requests ORDER BY id").all(),
    });
    const results2 = db.prepare(
      "SELECT repair_case_id, result_status, score, priority_rank FROM repair_match_case_results WHERE run_id = ? ORDER BY repair_case_id",
    ).all(run2.runId);

    expect(run2.casesChanged).toBe(0);
    expect(stateAfter2).toBe(stateAfter1);
    expect(JSON.stringify(results2)).toBe(JSON.stringify(results1));
    expect((db.prepare("SELECT COUNT(*) c FROM operational_reservations").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM purchase_orders").get() as { c: number }).c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 42-44. Estados protegidos nunca são sobrescritos
// ---------------------------------------------------------------------------

describe("42-44. estados posteriores ao fluxo não são sobrescritos", () => {
  for (const status of ["REPARO_EXECUTADO", "VENDA_ESTADO", "CANCELADO", "CONCLUIDO", "DIRECIONADO_TECNICO", "EM_REPARO", "APTO_REPARO"]) {
    it(`estado ${status} permanece intacto após o motor`, async () => {
      seedStock(db, "BATERIA X", "R1", 10);
      const { caseId } = seedCase(db, { chaves: ["BATERIA X"], workflow: status });
      await runRepairMatchEngine(db);
      expect(caseStatus(db, caseId)).toBe(status);
      // e nem sequer entra nos resultados da execução
      const inResults = db.prepare(
        "SELECT COUNT(*) c FROM repair_match_case_results WHERE repair_case_id = ?",
      ).get(caseId) as { c: number };
      expect(inResults.c).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 45-47. Regra ativa única
// ---------------------------------------------------------------------------

describe("45-47. regra ativa", () => {
  it("45. ativar uma regra desativa a anterior transacionalmente", () => {
    const before = getActiveRuleSet(db);
    const draft = createDraftRuleSet(db, { name: "Nova regra", reason: "teste" });
    activateRuleSet(db, draft.id, { reason: "ativação de teste", userId: null });
    const actives = listRuleSets(db).filter((r) => r.active);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(draft.id);
    expect(actives[0].id).not.toBe(before.id);
  });

  it("46. o banco impede duas regras ativas (índice único parcial)", () => {
    const draft = createDraftRuleSet(db, {});
    expect(() =>
      db.prepare("UPDATE match_rule_sets SET active = 1 WHERE id = ?").run(draft.id),
    ).toThrow(); // UNIQUE index idx_match_rule_sets_active
  });

  it("47. sem regra ativa o motor aborta sem alterar cards nem criar run", async () => {
    seedStock(db, "BATERIA X", "R1", 5);
    const { caseId } = seedCase(db, { chaves: ["BATERIA X"] });
    db.prepare("UPDATE match_rule_sets SET active = 0").run();

    const runsBefore = (db.prepare("SELECT COUNT(*) c FROM repair_match_runs").get() as { c: number }).c;
    await expect(runRepairMatchEngine(db)).rejects.toThrow(MatchRuleStateError);
    expect(caseStatus(db, caseId)).toBe("PEDIR_PECA"); // intacto
    expect((db.prepare("SELECT COUNT(*) c FROM repair_match_runs").get() as { c: number }).c).toBe(runsBefore);
  });
});

// ---------------------------------------------------------------------------
// 48. Correção em VERIFICAR devolve o card ao motor
// ---------------------------------------------------------------------------

describe("48. correção manual devolve o card ao motor", () => {
  it("card sem depósito vai a VERIFICAR com motivo; corrigido, volta e vira MATCH", async () => {
    seedStock(db, "BATERIA X", "R1", 1);
    const { caseId } = seedCase(db, { chaves: ["BATERIA X"], deposito: null });

    const run1 = await runRepairMatchEngine(db);
    expect(caseStatus(db, caseId)).toBe("VERIFICAR");
    const cr = db.prepare(
      "SELECT verify_reasons_json FROM repair_match_case_results WHERE run_id = ? AND repair_case_id = ?",
    ).get(run1.runId, caseId) as { verify_reasons_json: string };
    expect(JSON.parse(cr.verify_reasons_json)).toContain("DEPOSITO_NAO_IDENTIFICADO");

    // Correção manual (como a tela VERIFICAR faz) + retorno automático ao motor
    db.prepare("UPDATE repair_cases SET deposito_atual = 'AGUARDANDO PECA' WHERE id = ?").run(caseId);
    requestMatchRecompute(db, "MANUAL_FIX_DEPOSITO", "repair_case", caseId);
    const run2 = await processPendingRecompute(db);
    expect(run2).not.toBeNull();
    expect(caseStatus(db, caseId)).toBe("MATCH");

    const cr2 = db.prepare(
      "SELECT verify_reasons_json, result_status, score FROM repair_match_case_results WHERE run_id = ? AND repair_case_id = ?",
    ).get(run2!.runId, caseId) as { verify_reasons_json: string | null; result_status: string; score: number };
    expect(cr2.verify_reasons_json).toBeNull();
    expect(cr2.result_status).toBe("MATCH");
    expect(cr2.score).toBeCloseTo(735 / 150 + 102 / 30, 12); // decimal, sem arredondar
  });

  it("caso com múltiplas pendências permanece em VERIFICAR com o motivo restante", async () => {
    const { caseId } = seedCase(db, { chaves: ["BATERIA X"], deposito: null, cost: null });
    const run1 = await runRepairMatchEngine(db);
    const reasons1 = JSON.parse((db.prepare(
      "SELECT verify_reasons_json j FROM repair_match_case_results WHERE run_id = ? AND repair_case_id = ?",
    ).get(run1.runId, caseId) as { j: string }).j);
    expect(reasons1).toEqual(expect.arrayContaining(["DEPOSITO_NAO_IDENTIFICADO", "CUSTO_AUSENTE"]));

    db.prepare("UPDATE repair_cases SET deposito_atual = 'AGUARDANDO PECA' WHERE id = ?").run(caseId);
    const run2 = await runRepairMatchEngine(db);
    expect(caseStatus(db, caseId)).toBe("VERIFICAR"); // ainda falta custo
    const reasons2 = JSON.parse((db.prepare(
      "SELECT verify_reasons_json j FROM repair_match_case_results WHERE run_id = ? AND repair_case_id = ?",
    ).get(run2.runId, caseId) as { j: string }).j);
    expect(reasons2).toEqual(["CUSTO_AUSENTE"]);
  });
});
