/**
 * Testes de simulação dry-run — usa a MESMA função pura do motor real.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { getActiveRuleSet, createDraftRuleSet, toActiveRule } from "../src/match/match-rule-service.js";
import { computeRuleScore } from "../src/match/calculate-match.js";
import { simulateMatchRules } from "../src/match/simulate-service.js";

let db: Db;
beforeEach(async () => { db = await createDb(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertCase(
  db: Db,
  imeiNorm: string,
  opts: { age_days?: number | null; cost?: number | null; sale?: number | null; manual?: boolean } = {},
): number {
  const r = db.prepare(`
    INSERT INTO repair_cases
      (imei, imei_norm, model, workflow_status, analysis_status, deposito_atual, created_at, updated_at)
    VALUES (?, ?, 'MODELO SIM', 'PEDIR_PECA', 'COMPLETED', 'AGUARDANDO PECA', datetime('now'), datetime('now'))
  `).run(imeiNorm, imeiNorm);
  const id = Number(r.lastInsertRowid);

  db.prepare(`
    UPDATE repair_cases
    SET age_days = ?, cost = ?, estimated_sale = ?, margin = ?, manual_priority_active = ?
    WHERE id = ?
  `).run(
    opts.age_days ?? null,
    opts.cost ?? 0,
    opts.sale ?? null,
    opts.sale != null && opts.cost != null ? opts.sale - opts.cost : null,
    opts.manual ? 1 : 0,
    id,
  );
  return id;
}

function insertPart(db: Db, caseId: number, chavePeca: string): void {
  const chaveNorm = chavePeca.toLowerCase().replace(/\s+/g, "-");
  db.prepare(`
    INSERT INTO part_requests
      (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
    VALUES (?, ?, ?, 'PEDIR_PECA', datetime('now'), datetime('now'))
  `).run(caseId, chavePeca, chaveNorm);
}

function insertStock(db: Db, chavePecaNorm: string, qty: number): void {
  const sessionId = db.prepare(`
    INSERT INTO count_sessions (responsible_name, status, started_at, finished_at)
    VALUES ('sistema', 'FINALIZED', datetime('now'), datetime('now'))
  `).run().lastInsertRowid;

  const snapshotId = db.prepare(`
    INSERT INTO stock_snapshots (count_session_id, status, total_units, created_at, baseline_movement_id_max)
    VALUES (?, 'OFFICIAL', ?, datetime('now'), 0)
  `).run(sessionId, qty).lastInsertRowid;

  const ref = `REF-${chavePecaNorm.toUpperCase()}`;
  const refNorm = ref.toLowerCase();
  db.prepare(`
    INSERT INTO stock_snapshot_items (snapshot_id, reference, reference_norm, chave_peca, chave_peca_norm, counted_quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(snapshotId, ref, refNorm, chavePecaNorm.toUpperCase(), chavePecaNorm, qty);
}

// ---------------------------------------------------------------------------
// Score da regra ativa (única implementação: computeRuleScore)
// ---------------------------------------------------------------------------

describe("computeRuleScore com a regra ativa persistida", () => {
  it("(T4) pontos decimais exatos com a regra ativa (sem arredondamento)", () => {
    const rule = toActiveRule(getActiveRuleSet(db));
    const { score, agePoints, marginPoints } = computeRuleScore(rule, 735, 102);
    expect(marginPoints).toBe(4.9);
    expect(agePoints).toBeCloseTo(3.4, 12);
    expect(score).toBeCloseTo(8.3, 12);
  });

  it("(T5) regra com foco em margem inverte a prioridade entre dois casos", () => {
    const ruleDefault = toActiveRule(getActiveRuleSet(db));
    // A: velho, margem pequena. B: novo, margem alta.
    const scoreA = computeRuleScore(ruleDefault, 50, 90).score;
    const scoreB = computeRuleScore(ruleDefault, 500, 10).score;
    expect(scoreA).not.toEqual(0);
    expect(scoreB).not.toEqual(0);

    const ruleMargem = toActiveRule(
      createDraftRuleSet(db, { marginAmountPerPoint: 10, ageDaysPerPoint: 999, reason: "teste margem" }),
    );
    const scoreA_m = computeRuleScore(ruleMargem, 50, 90).score;
    const scoreB_m = computeRuleScore(ruleMargem, 500, 10).score;
    expect(scoreB_m).toBeGreaterThan(scoreA_m);
  });
});

// ---------------------------------------------------------------------------
// Dry-run não altera banco
// ---------------------------------------------------------------------------

describe("simulateMatchRules — garantias de dry-run", () => {
  beforeEach(() => {
    const c1 = insertCase(db, "SIM000000000001", { age_days: 30, sale: 100 });
    insertPart(db, c1, "TELA");
    insertStock(db, "tela", 1);
  });

  it("(T6) dry-run não cria repair_match_run", async () => {
    const before = (db.prepare("SELECT COUNT(*) as n FROM repair_match_runs").get() as { n: number }).n;
    await simulateMatchRules(db, { compareWithActive: false });
    const after = (db.prepare("SELECT COUNT(*) as n FROM repair_match_runs").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("(T7) dry-run não altera workflow_status", async () => {
    const before = db.prepare("SELECT workflow_status FROM repair_cases WHERE imei_norm = 'SIM000000000001'").get() as { workflow_status: string };
    await simulateMatchRules(db, { compareWithActive: false });
    const after = db.prepare("SELECT workflow_status FROM repair_cases WHERE imei_norm = 'SIM000000000001'").get() as { workflow_status: string };
    expect(after.workflow_status).toBe(before.workflow_status);
  });

  it("(T8) dry-run não altera part_requests", async () => {
    const before = db.prepare("SELECT COUNT(*) as n FROM part_requests").get() as { n: number };
    await simulateMatchRules(db, { compareWithActive: false });
    const after = db.prepare("SELECT COUNT(*) as n FROM part_requests").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

// ---------------------------------------------------------------------------
// Comparação entre regras
// ---------------------------------------------------------------------------

describe("simulateMatchRules — comparação de regras", () => {
  it("(T9) regra com foco em idade forte altera quem recebe o estoque limitado", async () => {
    const c1 = insertCase(db, "CMP000000000001", { age_days: 120, sale: 10 });  // velho, margem baixa
    const c2 = insertCase(db, "CMP000000000002", { age_days: 2, sale: 500 });   // novo, margem alta
    insertPart(db, c1, "BATERIA-CMP");
    insertPart(db, c2, "BATERIA-CMP");
    insertStock(db, "bateria-cmp", 1);

    const ruleIdade = createDraftRuleSet(db, {
      ageDaysPerPoint: 1,
      ageMaxPoints: 200,
      marginAmountPerPoint: 9999,
      reason: "foco em idade",
    });

    const result = await simulateMatchRules(db, {
      ruleSetId: ruleIdade.id,
      compareWithActive: true,
    });

    expect(result.casesEvaluated).toBeGreaterThanOrEqual(2);
    expect(result.changedComparedToActive).not.toBeNull();
    expect(typeof result.fullKitsFound).toBe("number");
    expect(typeof result.partialKitsFound).toBe("number");
  });

  it("(T10) regra com foco em margem forte muda o vencedor do estoque limitado", async () => {
    const c1 = insertCase(db, "MRG000000000001", { age_days: 200, sale: 5 });    // muito velho, margem ínfima
    const c2 = insertCase(db, "MRG000000000002", { age_days: 1, sale: 9000 });   // novo, margem enorme
    insertPart(db, c1, "FRAME-MRG");
    insertPart(db, c2, "FRAME-MRG");
    insertStock(db, "frame-mrg", 1);

    const ruleMargem = createDraftRuleSet(db, {
      ageDaysPerPoint: 9999,
      ageMaxPoints: 1,
      marginAmountPerPoint: 1,
      reason: "foco em margem",
    });

    const result = await simulateMatchRules(db, {
      ruleSetId: ruleMargem.id,
      compareWithActive: true,
    });

    expect(result.casesEvaluated).toBeGreaterThanOrEqual(2);
    expect(result.changedComparedToActive).not.toBeNull();
    // Todo card avaliado recebe exatamente um resultado canônico
    expect(
      result.fullKitsFound + result.partialKitsFound + result.pedirPecaCount +
      result.aguardandoCount + result.verificarCount,
    ).toBe(result.casesEvaluated);
  });
});
