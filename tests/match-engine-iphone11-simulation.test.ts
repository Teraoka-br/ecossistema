/**
 * Simulação de match com cenário hipotético: Bateria iPhone 11 em estoque.
 * Testa Regra 1 (só margem), Regra 2 (margem+idade), Regra 3 (com prioridade manual).
 */

import { describe, it, expect } from "vitest";
import { calculateMatch, type CalculateMatchInput, type ActiveRule } from "../src/match/calculate-match.js";

// ─── Chave canônica da peça ─────────────────────────────────────────────────

const BAT_IP11_KEY = "BATERIA-IPHONE-11";

// ─── Estoque: 2 unidades de Bateria iPhone 11 ───────────────────────────────

const stock = [
  { chavePecaNorm: BAT_IP11_KEY, referencia: "BAT-IP11-001", referenciaNorm: "bat-ip11-001", availableQuantity: 2 },
];

// ─── Casos hipotéticos ───────────────────────────────────────────────────────
// 3 aparelhos precisando de bateria iPhone 11, com perfis diferentes de score

const basePart = (id: number) => ({
  partRequestId: id,
  chavePeca: "BATERIA IPHONE 11",
  chavePecaNorm: BAT_IP11_KEY,
  hasActiveOrder: false,
});

const cases = [
  {
    // IMEI_A: margem alta (R$ 400), recente (15 dias) → score alto
    caseId: 1, imei: "111111111111111", model: "iPhone 11",
    cost: 600, estimatedSale: 1000, ageDays: 15,
    depositoAtual: "AGUARDANDO PECA", workflowStatus: "PEDIR_PECA",
    manualPriority: false, parts: [basePart(101)],
  },
  {
    // IMEI_B: margem baixa (R$ 50), antigo (400 dias) → score dependente da regra
    caseId: 2, imei: "222222222222222", model: "iPhone 11",
    cost: 900, estimatedSale: 950, ageDays: 400,
    depositoAtual: "AGUARDANDO PECA", workflowStatus: "PEDIR_PECA",
    manualPriority: false, parts: [basePart(102)],
  },
  {
    // IMEI_C: margem média (R$ 200), médio (90 dias), com prioridade manual ativa
    caseId: 3, imei: "333333333333333", model: "iPhone 11",
    cost: 700, estimatedSale: 900, ageDays: 90,
    depositoAtual: "MANUTENCAO INTERNA", workflowStatus: "AGUARDANDO_RECEBIMENTO",
    manualPriority: true, parts: [basePart(103)],
  },
];

const compat = {
  groups: [],
  aliases: new Map<string, string>(),
  catalog: new Map<string, readonly string[]>(),
};

// ─── Regras ──────────────────────────────────────────────────────────────────

/** Regra 1: só margem importa (peso margem=1, peso idade=0) */
const rule1: ActiveRule = {
  id: 1, version: 1, name: "Só margem",
  marginAmountPerPoint: 150, ageDaysPerPoint: 30, ageMaxPoints: 12,
  allowNegativeMarginScore: false,
  marginWeight: 1, ageWeight: 0,
  manualPriorityEnabled: false,
};

/** Regra 2: margem + idade balanceados (peso margem=0.6, peso idade=0.4) */
const rule2: ActiveRule = {
  id: 2, version: 1, name: "Margem + Idade balanceados",
  marginAmountPerPoint: 150, ageDaysPerPoint: 30, ageMaxPoints: 12,
  allowNegativeMarginScore: false,
  marginWeight: 0.6, ageWeight: 0.4,
  manualPriorityEnabled: false,
};

/** Regra 3: igual à regra 2, mas com prioridade manual habilitada */
const rule3: ActiveRule = {
  id: 3, version: 1, name: "Margem + Idade + Prioridade manual",
  marginAmountPerPoint: 150, ageDaysPerPoint: 30, ageMaxPoints: 12,
  allowNegativeMarginScore: false,
  marginWeight: 0.6, ageWeight: 0.4,
  manualPriorityEnabled: true,
};

function run(rule: ActiveRule) {
  const input: CalculateMatchInput = { cases, availableStock: stock, activeRule: rule, compatibility: compat };
  return calculateMatch(input);
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe("Simulação match — Bateria iPhone 11 (2 unidades, 3 candidatos)", () => {

  it("Regra 1 (só margem): IMEI_A e IMEI_C recebem MATCH, IMEI_B fica PEDIR_PECA", () => {
    const out = run(rule1);

    // Com stock=2 e 3 candidatos, 2 recebem MATCH; o de menor score fica sem.
    const byCase = new Map(out.cases.map(c => [c.caseId, c]));

    const a = byCase.get(1)!;
    const b = byCase.get(2)!;
    const c = byCase.get(3)!;

    // Scores com Regra 1 (peso idade=0):
    // A: margin=400 → 400/150=2.667 pts de margem × 1 = 2.667
    // B: margin=50  → 50/150=0.333 pts de margem × 1 = 0.333
    // C: margin=200 → 200/150=1.333 pts de margem × 1 = 1.333
    // Ranking: A(2.667) > C(1.333) > B(0.333)
    // Stock=2 → A e C recebem MATCH, B não

    expect(a.result).toBe("MATCH");
    expect(c.result).toBe("MATCH");
    expect(b.result).toBe("PEDIR_PECA");

    // Verificar scores
    expect(a.score!).toBeCloseTo(2.667, 2);
    expect(c.score!).toBeCloseTo(1.333, 2);
    expect(b.score!).toBeCloseTo(0.333, 2);

    // Rankings
    expect(a.rank).toBe(1);
    expect(c.rank).toBe(2);
    expect(b.rank).toBe(3);

    console.log("\n=== REGRA 1 (só margem) ===");
    for (const cas of out.cases) {
      console.log(`  IMEI ${cas.caseId}: score=${cas.score?.toFixed(4)} rank=${cas.rank} → ${cas.result}`);
    }
    console.log(`  Disputadas: ${out.disputedKeys.map(d => `${d.stockChaveNorm} demanda=${d.demanded}`).join(", ") || "nenhuma"}`);
  });

  it("Regra 2 (margem+idade): IMEI_B (400 dias) sobe no ranking mas ainda perde para A", () => {
    const out = run(rule2);
    const byCase = new Map(out.cases.map(c => [c.caseId, c]));

    const a = byCase.get(1)!;
    const b = byCase.get(2)!;
    const c = byCase.get(3)!;

    // Scores com Regra 2 (marginWeight=0.6, ageWeight=0.4):
    // A: marginPts=2.667, agePts=min(15/30,12)=0.5 → 2.667×0.6 + 0.5×0.4 = 1.600 + 0.200 = 1.800
    // B: marginPts=0.333, agePts=min(400/30,12)=12  → 0.333×0.6 + 12×0.4  = 0.200 + 4.800 = 5.000
    // C: marginPts=1.333, agePts=min(90/30,12)=3    → 1.333×0.6 + 3×0.4   = 0.800 + 1.200 = 2.000
    // Ranking: B(5.000) > C(2.000) > A(1.800)
    // Stock=2 → B e C recebem MATCH, A fica sem

    expect(b.result).toBe("MATCH");
    expect(c.result).toBe("MATCH");
    expect(a.result).toBe("PEDIR_PECA");

    expect(b.rank).toBe(1);
    expect(c.rank).toBe(2);
    expect(a.rank).toBe(3);

    console.log("\n=== REGRA 2 (margem+idade) ===");
    for (const cas of out.cases) {
      console.log(`  IMEI ${cas.caseId}: score=${cas.score?.toFixed(4)} rank=${cas.rank} → ${cas.result}`);
    }
  });

  it("Regra 3 (com prioridade manual): IMEI_C (manual_priority=true) sobe para frente, MATCH garantido", () => {
    const out = run(rule3);
    const byCase = new Map(out.cases.map(c => [c.caseId, c]));

    const a = byCase.get(1)!;
    const b = byCase.get(2)!;
    const c = byCase.get(3)!;

    // Com manualPriorityEnabled=true:
    // Grupo prioritário (manual_priority=true): C
    // Grupo normal (manual_priority=false): B > A (por score da Regra 2)
    // Ordem: C → B → A
    // Stock=2 → C e B recebem MATCH, A fica sem

    expect(c.result).toBe("MATCH");
    expect(b.result).toBe("MATCH");
    expect(a.result).toBe("PEDIR_PECA");

    expect(c.rank).toBe(1); // prioridade manual → primeiro
    expect(b.rank).toBe(2);
    expect(a.rank).toBe(3);

    console.log("\n=== REGRA 3 (margem+idade+prioridade manual) ===");
    for (const cas of out.cases) {
      console.log(`  IMEI ${cas.caseId}: score=${cas.score?.toFixed(4)} rank=${cas.rank} priority=${cas.eligible && cases.find(x => x.caseId === cas.caseId)?.manualPriority} → ${cas.result}`);
    }
  });

  it("Estoque disputado é detectado corretamente (3 demandam, 2 disponíveis)", () => {
    const out = run(rule1);
    expect(out.disputedKeys).toHaveLength(1);
    expect(out.disputedKeys[0].stockChaveNorm).toBe(BAT_IP11_KEY);
    expect(out.disputedKeys[0].demanded).toBe(3);
    expect(out.disputedKeys[0].available).toBe(2);
    console.log(`\n=== DISPUTA === demanded=${out.disputedKeys[0].demanded} available=${out.disputedKeys[0].available}`);
  });
});
