/**
 * Shadow mode do custo de peças no motor (Camada 3).
 *
 * Garante que:
 *   - modo sombra não altera resultado nem ranking (fila idêntica à legada);
 *   - modo não-sombra usa a margem de reparo no score;
 *   - cobertura insuficiente respeita missingCostBehavior.
 */

import { describe, it, expect } from "vitest";
import { calculateMatch, VERIFY_REASONS } from "../src/match/calculate-match.js";
import type { ActiveRule, CalculateMatchInput, MatchCaseInput } from "../src/match/calculate-match.js";

const baseRule: ActiveRule = {
  id: 1, version: 1, name: "teste",
  marginAmountPerPoint: 100, ageDaysPerPoint: 30, ageMaxPoints: 12,
  allowNegativeMarginScore: true, marginWeight: 1, ageWeight: 1,
  manualPriorityEnabled: false,
  includePartsCost: false, shadowMode: true,
  minPartsCostCoverage: 0, missingCostBehavior: "USE_LEGACY_MARGIN",
};

function makeCase(id: number, opts: Partial<MatchCaseInput> = {}): MatchCaseInput {
  return {
    caseId: id, imei: `IMEI${id}`, model: "M", cost: 100,
    estimatedSale: 500, ageDays: 30, depositoAtual: "AGUARDANDO PECA",
    workflowStatus: "PEDIR_PECA", manualPriority: false,
    parts: [{ partRequestId: id * 10, chavePeca: "TELA A", chavePecaNorm: "TELA A", hasActiveOrder: false }],
    ...opts,
  };
}

function makeInput(cases: MatchCaseInput[], rule: ActiveRule): CalculateMatchInput {
  return {
    cases,
    availableStock: [{ chavePecaNorm: "TELA A", referencia: "REF", referenciaNorm: "ref", availableQuantity: 10 }],
    activeRule: rule,
    compatibility: { groups: [], aliases: new Map(), catalog: new Map() },
  };
}

describe("shadow mode", () => {
  it("(spec 27) modo sombra não altera resultado nem ranking", () => {
    const cases = [
      makeCase(1, { estimatedSale: 500, partsCost: 300, partsCostCoverage: 100, partsCostConfidence: "HIGH" }),
      makeCase(2, { estimatedSale: 480, partsCost: 10, partsCostCoverage: 100, partsCostConfidence: "HIGH" }),
    ];
    const legacy = calculateMatch(makeInput(cases, baseRule));
    const shadow = calculateMatch(makeInput(cases, {
      ...baseRule, includePartsCost: true, shadowMode: true,
    }));

    for (let i = 0; i < legacy.cases.length; i++) {
      expect(shadow.cases[i].result).toBe(legacy.cases[i].result);
      expect(shadow.cases[i].rank).toBe(legacy.cases[i].rank);
      expect(shadow.cases[i].score).toBe(legacy.cases[i].score);
    }
    // Mas registra a margem de reparo em paralelo
    const c1 = shadow.cases.find((c) => c.caseId === 1)!;
    expect(c1.repairMargin).toBe(500 - 100 - 300);
    expect(c1.isShadow).toBe(true);
  });

  it("(spec 28) modo não-sombra usa margem após peças no score", () => {
    // Caso 1: margem legada maior, mas custo de peças alto.
    // Caso 2: margem legada menor, custo de peças mínimo.
    const cases = [
      makeCase(1, { estimatedSale: 500, partsCost: 350, partsCostCoverage: 100, partsCostConfidence: "HIGH" }),
      makeCase(2, { estimatedSale: 480, partsCost: 5, partsCostCoverage: 100, partsCostConfidence: "HIGH" }),
    ];
    const active = calculateMatch(makeInput(cases, {
      ...baseRule, includePartsCost: true, shadowMode: false, minPartsCostCoverage: 100,
    }));
    const c1 = active.cases.find((c) => c.caseId === 1)!;
    const c2 = active.cases.find((c) => c.caseId === 2)!;
    // repairMargin c1 = 50; c2 = 375 → c2 deve ranquear acima
    expect(c2.rank!).toBeLessThan(c1.rank!);
    expect(c1.isShadow).toBe(false);
  });

  it("(spec 31) cobertura insuficiente com SEND_TO_VERIFY marca o caso", () => {
    const cases = [makeCase(1, { partsCost: null, partsCostCoverage: 0, partsCostConfidence: "MISSING" })];
    const out = calculateMatch(makeInput(cases, {
      ...baseRule, includePartsCost: true, shadowMode: false,
      minPartsCostCoverage: 100, missingCostBehavior: "SEND_TO_VERIFY",
    }));
    const c1 = out.cases[0];
    expect(c1.verifyReasons).toContain(VERIFY_REASONS.CUSTO_PECAS_INCOMPLETO);
    expect(c1.result).toBe("VERIFICAR");
  });

  it("(spec 31) cobertura insuficiente com USE_LEGACY_MARGIN mantém fila legada", () => {
    const cases = [makeCase(1, { partsCost: null, partsCostCoverage: 0, partsCostConfidence: "MISSING" })];
    const out = calculateMatch(makeInput(cases, {
      ...baseRule, includePartsCost: true, shadowMode: false,
      minPartsCostCoverage: 100, missingCostBehavior: "USE_LEGACY_MARGIN",
    }));
    const c1 = out.cases[0];
    expect(c1.result).toBe("MATCH");
    expect(c1.verifyReasons).toHaveLength(0);
  });
});
