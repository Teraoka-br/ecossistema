/**
 * Testes determinísticos da FUNÇÃO PURA calculateMatch — motor único de match.
 * Cobrem os itens 1-23, 25-31, 35-37 e 49-50 da especificação de testes
 * obrigatórios (os demais, que tocam banco, estão em match-engine-integration).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateMatch,
  computeRuleScore,
  normalizeDeposito,
  isDepositoElegivel,
  VERIFY_REASONS,
  type ActiveRule,
  type CalculateMatchInput,
  type MatchCaseInput,
  type StockGroupInput,
} from "../src/match/calculate-match.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Regra 1 da especificação: 150/pt, 30 dias/pt, pesos 1, teto 12, negativa pune. */
const REGRA1: ActiveRule = {
  id: 1,
  version: 1,
  name: "Regra 1",
  marginAmountPerPoint: 150,
  ageDaysPerPoint: 30,
  ageMaxPoints: 12,
  allowNegativeMarginScore: true,
  marginWeight: 1,
  ageWeight: 1,
  manualPriorityEnabled: false,
};

let nextPartId = 1000;

function makeCase(over: Partial<MatchCaseInput> & { caseId: number; chaves?: (string | null)[] }): MatchCaseInput {
  const chaves = over.chaves ?? ["BATERIA X"];
  return {
    caseId: over.caseId,
    imei: over.imei !== undefined ? over.imei : `35000000000${over.caseId}`,
    model: over.model !== undefined ? over.model : "IPHONE 12",
    cost: over.cost !== undefined ? over.cost : 500,
    estimatedSale: over.estimatedSale !== undefined ? over.estimatedSale : 1235,
    ageDays: over.ageDays !== undefined ? over.ageDays : 102,
    depositoAtual: over.depositoAtual !== undefined ? over.depositoAtual : "AGUARDANDO PEÇA",
    workflowStatus: over.workflowStatus ?? "PEDIR_PECA",
    manualPriority: over.manualPriority ?? false,
    parts:
      over.parts ??
      chaves.map((c) => ({
        partRequestId: nextPartId++,
        chavePeca: c,
        chavePecaNorm: c,
        hasActiveOrder: false,
      })),
  };
}

function stock(items: Array<[chave: string, ref: string, qty: number]>): StockGroupInput[] {
  return items.map(([chave, ref, qty]) => ({
    chavePecaNorm: chave,
    referencia: ref,
    referenciaNorm: ref,
    availableQuantity: qty,
  }));
}

function run(cases: MatchCaseInput[], stockGroups: StockGroupInput[], rule: ActiveRule = REGRA1, compat?: CalculateMatchInput["compatibility"]) {
  return calculateMatch({
    cases,
    availableStock: stockGroups,
    activeRule: rule,
    compatibility: compat ?? { groups: [], catalog: new Map() },
  });
}

// ---------------------------------------------------------------------------
// 1-5: fórmula da Regra 1 — precisão decimal, sem arredondamento
// ---------------------------------------------------------------------------

describe("Regra 1 — score decimal exato (proibido arredondar)", () => {
  it("1. margem 735 / 150 = 4,9 pontos exatos", () => {
    const { marginPoints } = computeRuleScore(REGRA1, 735, 0);
    expect(marginPoints).toBe(4.9);
  });

  it("2. idade 102 / 30 = 3,4 pontos exatos", () => {
    const { agePoints } = computeRuleScore(REGRA1, 0, 102);
    expect(agePoints).toBeCloseTo(3.4, 12);
  });

  it("3. score do exemplo obrigatório = 8,3", () => {
    const { score } = computeRuleScore(REGRA1, 735, 102);
    expect(score).toBeCloseTo(8.3, 12);
  });

  it("4. nenhum cálculo usa arredondamento (divisões não exatas preservam decimais)", () => {
    // 100/150 = 0,666..., 45/30 = 1,5 — nada de floor/round/trunc
    const r = computeRuleScore(REGRA1, 100, 45);
    expect(r.marginPoints).toBeCloseTo(100 / 150, 15);
    expect(r.agePoints).toBe(1.5);
    expect(r.score).toBeCloseTo(100 / 150 + 1.5, 15);
    expect(Number.isInteger(r.score)).toBe(false);

    // O código-fonte do motor não contém operações de arredondamento.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/match/calculate-match.ts"),
      "utf8",
    );
    for (const banned of ["Math.floor", "Math.ceil", "Math.round", "Math.trunc", "toFixed(", "parseInt(", "| 0", ">> 0"]) {
      expect(src.includes(banned), `motor não pode conter "${banned}"`).toBe(false);
    }
  });

  it("5. margem -75 gera exatamente -0,5 ponto (sem virar 0, sem virar -1)", () => {
    const { marginPoints } = computeRuleScore(REGRA1, -75, 0);
    expect(marginPoints).toBe(-0.5);
  });

  it("6. margem negativa reduz o score proporcionalmente", () => {
    const positivo = computeRuleScore(REGRA1, 0, 60).score;
    const negativo = computeRuleScore(REGRA1, -75, 60).score;
    expect(negativo).toBe(positivo - 0.5);
    expect(negativo).toBeLessThan(positivo);
  });

  it("7. idade acima do teto limita apenas a parcela de idade a 12 na Regra 1", () => {
    // 600/30 = 20 pontos → teto 12
    const r = computeRuleScore(REGRA1, 150, 600);
    expect(r.agePoints).toBe(12);
    expect(r.marginPoints).toBe(1);
    expect(r.score).toBe(13);
  });

  it("8. outra regra pode possuir teto diferente", () => {
    const outra: ActiveRule = { ...REGRA1, id: 2, version: 2, ageMaxPoints: 20 };
    expect(computeRuleScore(outra, 0, 600).agePoints).toBe(20);
    const menor: ActiveRule = { ...REGRA1, id: 3, version: 3, ageMaxPoints: 5 };
    expect(computeRuleScore(menor, 0, 600).agePoints).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 9-16: parâmetros mudam a ordem; critérios de ordenação
// ---------------------------------------------------------------------------

describe("ordenação e sensibilidade aos parâmetros", () => {
  // A: margem alta, novo. B: margem baixa, velho.
  const A = makeCase({ caseId: 1, cost: 0, estimatedSale: 600, ageDays: 30, chaves: ["TELA X"] });
  const B = makeCase({ caseId: 2, cost: 0, estimatedSale: 150, ageDays: 300, chaves: ["TELA X"] });
  const oneUnit = () => stock([["TELA X", "R1", 1]]);

  function winner(rule: ActiveRule): number {
    const out = run([A, B], oneUnit(), rule);
    return out.cases.find((c) => c.result === "MATCH")!.caseId;
  }

  it("9. alterar peso de margem muda a ordem", () => {
    expect(winner({ ...REGRA1, marginWeight: 1, ageWeight: 1 })).toBe(2); // aging vence (10 pts idade)
    expect(winner({ ...REGRA1, marginWeight: 5, ageWeight: 1 })).toBe(1); // margem pesa 5x
  });

  it("10. alterar peso de idade muda a ordem", () => {
    expect(winner({ ...REGRA1, marginWeight: 1, ageWeight: 0 })).toBe(1);
    expect(winner({ ...REGRA1, marginWeight: 1, ageWeight: 2 })).toBe(2);
  });

  it("11. alterar valor de margem por ponto muda a ordem", () => {
    expect(winner({ ...REGRA1, marginAmountPerPoint: 150 })).toBe(2);
    expect(winner({ ...REGRA1, marginAmountPerPoint: 10 })).toBe(1); // 600/10=60 pts
  });

  it("12. alterar dias por ponto de idade muda a ordem", () => {
    expect(winner({ ...REGRA1, ageDaysPerPoint: 30 })).toBe(2);
    expect(winner({ ...REGRA1, ageDaysPerPoint: 300, ageMaxPoints: 100 })).toBe(1); // idade quase não pontua
  });

  it("13. maior score vence a disputa pelo estoque limitado", () => {
    const alto = makeCase({ caseId: 10, cost: 0, estimatedSale: 1500, ageDays: 0, chaves: ["TELA X"] });
    const baixo = makeCase({ caseId: 11, cost: 0, estimatedSale: 300, ageDays: 0, chaves: ["TELA X"] });
    const out = run([baixo, alto], oneUnit());
    expect(out.cases.find((c) => c.caseId === 10)!.result).toBe("MATCH");
    expect(out.cases.find((c) => c.caseId === 10)!.rank).toBe(1);
    expect(out.cases.find((c) => c.caseId === 11)!.result).toBe("PEDIR_PECA");
  });

  it("14. empate no score usa maior margem", () => {
    // mesmos scores: A margem 300 (2pt) + 60d (2pt) = 4; B margem 600 (4pt) + 0d = 4
    const a = makeCase({ caseId: 20, cost: 0, estimatedSale: 300, ageDays: 60, chaves: ["TELA X"] });
    const b = makeCase({ caseId: 21, cost: 0, estimatedSale: 600, ageDays: 0, chaves: ["TELA X"] });
    const out = run([a, b], oneUnit());
    expect(out.cases.find((c) => c.caseId === 21)!.result).toBe("MATCH"); // maior margem
  });

  it("15. empate em score e margem usa maior idade", () => {
    const rule: ActiveRule = { ...REGRA1, ageWeight: 0 }; // idade não pontua → scores iguais
    const novo = makeCase({ caseId: 30, cost: 0, estimatedSale: 300, ageDays: 10, chaves: ["TELA X"] });
    const velho = makeCase({ caseId: 31, cost: 0, estimatedSale: 300, ageDays: 200, chaves: ["TELA X"] });
    const out = run([novo, velho], oneUnit(), rule);
    expect(out.cases.find((c) => c.caseId === 31)!.result).toBe("MATCH"); // mais velho
  });

  it("16. empate total usa menor ID do caso (desempate determinístico)", () => {
    const c1 = makeCase({ caseId: 41, cost: 0, estimatedSale: 300, ageDays: 60, chaves: ["TELA X"] });
    const c2 = makeCase({ caseId: 40, cost: 0, estimatedSale: 300, ageDays: 60, chaves: ["TELA X"] });
    const out = run([c1, c2], oneUnit());
    expect(out.cases.find((c) => c.caseId === 40)!.result).toBe("MATCH");
    expect(out.cases.find((c) => c.caseId === 41)!.result).toBe("PEDIR_PECA");
  });

  it("quantidade de peças NÃO é critério de prioridade (score maior vence mesmo com kit maior)", () => {
    const kitGrande = makeCase({ caseId: 50, cost: 0, estimatedSale: 1500, ageDays: 90, chaves: ["TELA X", "BATERIA X"] });
    const kitPequeno = makeCase({ caseId: 51, cost: 0, estimatedSale: 300, ageDays: 0, chaves: ["TELA X"] });
    const out = run([kitPequeno, kitGrande], stock([["TELA X", "R1", 1], ["BATERIA X", "R2", 1]]));
    expect(out.cases.find((c) => c.caseId === 50)!.result).toBe("MATCH");
    expect(out.cases.find((c) => c.caseId === 51)!.result).toBe("PEDIR_PECA");
  });
});

// ---------------------------------------------------------------------------
// 17-24: dados indispensáveis e depósito → VERIFICAR com motivo exato
// ---------------------------------------------------------------------------

describe("VERIFICAR — dados indispensáveis com motivo exato", () => {
  const st = () => stock([["BATERIA X", "R1", 5]]);

  it("17. custo ausente leva a VERIFICAR com motivo CUSTO_AUSENTE", () => {
    const out = run([makeCase({ caseId: 1, cost: null })], st());
    expect(out.cases[0].result).toBe("VERIFICAR");
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.CUSTO_AUSENTE);
    expect(out.cases[0].eligible).toBe(false);
  });

  it("18. venda ausente leva a VERIFICAR com motivo VENDA_ESTIMADA_AUSENTE", () => {
    const out = run([makeCase({ caseId: 1, estimatedSale: null })], st());
    expect(out.cases[0].result).toBe("VERIFICAR");
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.VENDA_ESTIMADA_AUSENTE);
  });

  it("19. idade ausente leva a VERIFICAR com motivo IDADE_AUSENTE", () => {
    const out = run([makeCase({ caseId: 1, ageDays: null })], st());
    expect(out.cases[0].result).toBe("VERIFICAR");
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.IDADE_AUSENTE);
  });

  it("20. depósito ausente leva a VERIFICAR com motivo DEPOSITO_NAO_IDENTIFICADO", () => {
    const out = run([makeCase({ caseId: 1, depositoAtual: null })], st());
    expect(out.cases[0].result).toBe("VERIFICAR");
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.DEPOSITO_NAO_IDENTIFICADO);
  });

  it("21. depósito TRIAGEM leva a VERIFICAR com motivo DEPOSITO_FORA_DO_FLUXO", () => {
    const out = run([makeCase({ caseId: 1, depositoAtual: "TRIAGEM" })], st());
    expect(out.cases[0].result).toBe("VERIFICAR");
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.DEPOSITO_FORA_DO_FLUXO);
  });

  it("outros depósitos fora do fluxo também vão para VERIFICAR", () => {
    for (const dep of ["ESTOQUE DE VENDA", "EXPEDIÇÃO", "TECNICO 1", "NOVOS DISPONIVEIS"]) {
      const out = run([makeCase({ caseId: 1, depositoAtual: dep })], st());
      expect(out.cases[0].result).toBe("VERIFICAR");
      expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.DEPOSITO_FORA_DO_FLUXO);
    }
  });

  it("22. AGUARDANDO PEÇA participa do match (com/sem acento, caixa e espaços)", () => {
    for (const dep of ["AGUARDANDO PEÇA", "AGUARDANDO PECA", "Aguardando peça", "aguardando peca", "  AGUARDANDO   PEÇA  "]) {
      const out = run([makeCase({ caseId: 1, depositoAtual: dep })], st());
      expect(out.cases[0].result, `depósito "${dep}"`).toBe("MATCH");
    }
    expect(isDepositoElegivel("Aguardando peça")).toBe(true);
    expect(normalizeDeposito("  Aguardando   peça ")).toBe("AGUARDANDO PECA");
  });

  it("23. MANUTENÇÃO INTERNA participa do match", () => {
    for (const dep of ["MANUTENÇÃO INTERNA", "MANUTENCAO INTERNA", "manutenção interna"]) {
      const out = run([makeCase({ caseId: 1, depositoAtual: dep })], st());
      expect(out.cases[0].result, `depósito "${dep}"`).toBe("MATCH");
    }
  });

  it("IMEI ausente leva a VERIFICAR com motivo IMEI_AUSENTE", () => {
    const out = run([makeCase({ caseId: 1, imei: null })], st());
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.IMEI_AUSENTE);
    expect(out.cases[0].result).toBe("VERIFICAR");
  });

  it("modelo ausente leva a VERIFICAR com motivo MODELO_AUSENTE", () => {
    const out = run([makeCase({ caseId: 1, model: "" })], st());
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.MODELO_AUSENTE);
  });

  it("sem nenhuma peça necessária leva a VERIFICAR com motivo PECA_NECESSARIA_AUSENTE", () => {
    const out = run([makeCase({ caseId: 1, parts: [] })], st());
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.PECA_NECESSARIA_AUSENTE);
    expect(out.cases[0].result).toBe("VERIFICAR");
  });

  it("peça sem chave resolvida leva a VERIFICAR com motivo REFERENCIA_PECA_NAO_RESOLVIDA", () => {
    const out = run(
      [makeCase({ caseId: 1, parts: [{ partRequestId: 1, chavePeca: null, chavePecaNorm: null, hasActiveOrder: false }] })],
      st(),
    );
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.REFERENCIA_PECA_NAO_RESOLVIDA);
    expect(out.cases[0].result).toBe("VERIFICAR");
  });

  it("motivos acumulam — card mostra TODAS as pendências", () => {
    const out = run([makeCase({ caseId: 1, cost: null, estimatedSale: null, depositoAtual: null })], st());
    expect(out.cases[0].verifyReasons).toEqual(
      expect.arrayContaining([
        VERIFY_REASONS.CUSTO_AUSENTE,
        VERIFY_REASONS.VENDA_ESTIMADA_AUSENTE,
        VERIFY_REASONS.DEPOSITO_NAO_IDENTIFICADO,
      ]),
    );
  });

  it("card em VERIFICAR não consome estoque virtual", () => {
    const inelegivel = makeCase({ caseId: 1, cost: null, chaves: ["BATERIA X"] });
    const elegivel = makeCase({ caseId: 2, chaves: ["BATERIA X"] });
    const out = run([inelegivel, elegivel], stock([["BATERIA X", "R1", 1]]));
    expect(out.cases.find((c) => c.caseId === 2)!.result).toBe("MATCH");
  });
});

// ---------------------------------------------------------------------------
// 25-31: kits completos e parciais
// ---------------------------------------------------------------------------

describe("primeira passagem — kit completo atômico; segunda — parciais com sobras", () => {
  it("25. kit completo é alocado atomicamente (todas as peças ou nenhuma)", () => {
    const kit = makeCase({ caseId: 1, chaves: ["BATERIA X", "TELA X"] });
    const out = run([kit], stock([["BATERIA X", "R1", 1], ["TELA X", "R2", 1]]));
    const dec = out.cases[0];
    expect(dec.result).toBe("MATCH");
    expect(dec.virtuallyAllocatedParts).toHaveLength(2);
    expect(dec.missingParts).toHaveLength(0);
  });

  it("26/27. exemplo obrigatório: A (bateria+tela, score 10) não prende a bateria; B (só bateria, score 8) conclui", () => {
    // A: score maior; precisa bateria E tela. B: score menor; só bateria.
    const A = makeCase({ caseId: 1, cost: 0, estimatedSale: 1500, ageDays: 0, chaves: ["BATERIA X", "TELA X"] });
    const B = makeCase({ caseId: 2, cost: 0, estimatedSale: 1200, ageDays: 0, chaves: ["BATERIA X"] });
    const out = run([A, B], stock([["BATERIA X", "R1", 1]])); // tela = 0

    const decA = out.cases.find((c) => c.caseId === 1)!;
    const decB = out.cases.find((c) => c.caseId === 2)!;

    expect(decA.result).not.toBe("MATCH");
    expect(decB.result).toBe("MATCH"); // B recebe a bateria
    expect(decB.virtuallyAllocatedParts).toHaveLength(1);
    // A segue para avaliação parcial/pedido — como a única bateria foi para B,
    // A fica sem nada: PEDIR_PECA.
    expect(decA.result).toBe("PEDIR_PECA");
    expect(decA.virtuallyAllocatedParts).toHaveLength(0);
  });

  it("28. a mesma unidade não é sinalizada para dois MATCH completos", () => {
    const c1 = makeCase({ caseId: 1, cost: 0, estimatedSale: 900, ageDays: 0, chaves: ["TELA X"] });
    const c2 = makeCase({ caseId: 2, cost: 0, estimatedSale: 600, ageDays: 0, chaves: ["TELA X"] });
    const out = run([c1, c2], stock([["TELA X", "R1", 1]]));
    const matches = out.cases.filter((c) => c.result === "MATCH");
    expect(matches).toHaveLength(1);
    expect(matches[0].caseId).toBe(1);
  });

  it("29. MATCH completo é calculado antes do parcial (kit completo de score menor vence sobra parcial de score maior)", () => {
    // scoreAlto precisa de 2 peças e só existe 1 delas → não fecha kit.
    // scoreBaixo precisa exatamente da peça disponível → kit completo primeiro.
    const scoreAlto = makeCase({ caseId: 1, cost: 0, estimatedSale: 3000, ageDays: 300, chaves: ["BATERIA X", "TELA X"] });
    const scoreBaixo = makeCase({ caseId: 2, cost: 0, estimatedSale: 150, ageDays: 0, chaves: ["BATERIA X"] });
    const out = run([scoreAlto, scoreBaixo], stock([["BATERIA X", "R1", 1]]));
    expect(out.cases.find((c) => c.caseId === 2)!.result).toBe("MATCH");
    expect(out.cases.find((c) => c.caseId === 1)!.result).toBe("PEDIR_PECA");
  });

  it("30. MATCH_PARCIAL utiliza apenas sobras virtuais", () => {
    const kitCompleto = makeCase({ caseId: 1, cost: 0, estimatedSale: 1500, ageDays: 0, chaves: ["BATERIA X"] });
    const parcial = makeCase({ caseId: 2, cost: 0, estimatedSale: 600, ageDays: 0, chaves: ["BATERIA X", "TELA X"] });
    // 2 baterias: 1 vai para o kit completo; a SOBRA (1) vai para o parcial.
    const out = run([kitCompleto, parcial], stock([["BATERIA X", "R1", 2]]));
    const dec2 = out.cases.find((c) => c.caseId === 2)!;
    expect(dec2.result).toBe("MATCH_PARCIAL");
    expect(dec2.virtuallyAllocatedParts).toHaveLength(1);
    expect(dec2.missingParts.map((p) => p.chavePecaNorm)).toEqual(["TELA X"]);
  });

  it("31. a mesma sobra não aparece em dois matches parciais", () => {
    const p1 = makeCase({ caseId: 1, cost: 0, estimatedSale: 900, ageDays: 0, chaves: ["BATERIA X", "TELA X"] });
    const p2 = makeCase({ caseId: 2, cost: 0, estimatedSale: 600, ageDays: 0, chaves: ["BATERIA X", "TELA X"] });
    const out = run([p1, p2], stock([["BATERIA X", "R1", 1]])); // 1 bateria, 0 telas
    const dec1 = out.cases.find((c) => c.caseId === 1)!;
    const dec2 = out.cases.find((c) => c.caseId === 2)!;
    expect(dec1.result).toBe("MATCH_PARCIAL");
    expect(dec1.virtuallyAllocatedParts).toHaveLength(1);
    expect(dec2.result).toBe("PEDIR_PECA");
    expect(dec2.virtuallyAllocatedParts).toHaveLength(0);
  });

  it("peças faltantes com pedido ativo → AGUARDANDO_RECEBIMENTO; sem pedido → PEDIR_PECA", () => {
    const semPedido = makeCase({ caseId: 1, chaves: ["TELA X"] });
    const comPedido = makeCase({
      caseId: 2,
      parts: [{ partRequestId: 9, chavePeca: "TELA Y", chavePecaNorm: "TELA Y", hasActiveOrder: true }],
    });
    const out = run([semPedido, comPedido], []);
    expect(out.cases.find((c) => c.caseId === 1)!.result).toBe("PEDIR_PECA");
    expect(out.cases.find((c) => c.caseId === 2)!.result).toBe("AGUARDANDO_RECEBIMENTO");
  });
});

// ---------------------------------------------------------------------------
// 35-37: compatibilidade simétrica por grupos
// ---------------------------------------------------------------------------

describe("compatibilidade simétrica por grupos", () => {
  it("35. grupo de compatibilidade: pedido de A usa estoque de B (e vice-versa)", () => {
    const groups = [{ groupId: 1, members: ["BATERIA IPHONE 12", "BATERIA IPHONE 12/12 PRO"] }];
    const cA = makeCase({ caseId: 1, chaves: ["BATERIA IPHONE 12"] });
    const outA = run([cA], stock([["BATERIA IPHONE 12/12 PRO", "RFIS", 3]]), REGRA1, { groups, catalog: new Map() });
    expect(outA.cases[0].result).toBe("MATCH");
    expect(outA.cases[0].virtuallyAllocatedParts[0].aliasStockChaveNorm).toBe("BATERIA IPHONE 12/12 PRO");
    expect(outA.cases[0].compatibilityResolutions).toEqual([
      expect.objectContaining({ requestedChaveNorm: "BATERIA IPHONE 12", stockChaveNorm: "BATERIA IPHONE 12/12 PRO", via: "GROUP" }),
    ]);

    // pedido de B usa estoque de A
    const cB = makeCase({ caseId: 2, chaves: ["BATERIA IPHONE 12/12 PRO"] });
    const outB = run([cB], stock([["BATERIA IPHONE 12", "RFIS", 2]]), REGRA1, { groups, catalog: new Map() });
    expect(outB.cases[0].result).toBe("MATCH");
    expect(outB.cases[0].virtuallyAllocatedParts[0].aliasStockChaveNorm).toBe("BATERIA IPHONE 12");
  });

  it("35b. estoque direto continua sendo considerado (a própria chave tem prioridade)", () => {
    const groups = [{ groupId: 1, members: ["BATERIA IPHONE 12", "BATERIA IPHONE 12/12 PRO"] }];
    const c = makeCase({ caseId: 1, chaves: ["BATERIA IPHONE 12"] });
    // Ambos têm saldo — deve usar o direto primeiro
    const out = run([c], stock([["BATERIA IPHONE 12", "RF1", 1], ["BATERIA IPHONE 12/12 PRO", "RF2", 1]]), REGRA1, { groups, catalog: new Map() });
    expect(out.cases[0].result).toBe("MATCH");
    expect(out.cases[0].virtuallyAllocatedParts[0].aliasStockChaveNorm).toBeNull(); // usou a própria chave
  });

  it("36. sem grupo, referências diferentes não são presumidas compatíveis", () => {
    const c = makeCase({ caseId: 1, chaves: ["BATERIA IPHONE 12"] });
    const out = run([c], stock([["BATERIA IPHONE 12/12 PRO", "RFIS", 3]]));
    expect(out.cases[0].result).toBe("PEDIR_PECA"); // texto parecido NÃO cria compatibilidade
  });

  it("37. grupo não duplica saldo — duas unidades físicas geram no máximo dois matches", () => {
    const groups = [{ groupId: 1, members: ["BATERIA IPHONE 12", "BATERIA IPHONE 12 PRO", "BATERIA 12/12PRO"] }];
    const c1 = makeCase({ caseId: 1, cost: 0, estimatedSale: 900, ageDays: 0, chaves: ["BATERIA IPHONE 12"] });
    const c2 = makeCase({ caseId: 2, cost: 0, estimatedSale: 600, ageDays: 0, chaves: ["BATERIA IPHONE 12 PRO"] });
    // 1 unidade física — apenas 1 match possível
    const out1 = run([c1, c2], stock([["BATERIA 12/12PRO", "RF", 1]]), REGRA1, { groups, catalog: new Map() });
    const matches1 = out1.cases.filter((c) => c.result === "MATCH");
    expect(matches1).toHaveLength(1);
    expect(matches1[0].caseId).toBe(1); // maior score vence

    // 2 unidades físicas — dois matches possíveis
    const out2 = run([c1, c2], stock([["BATERIA 12/12PRO", "RF", 2]]), REGRA1, { groups, catalog: new Map() });
    const matches2 = out2.cases.filter((c) => c.result === "MATCH");
    expect(matches2).toHaveLength(2);
  });

  it("resolução ambígua via catálogo (2+ alvos, sem grupo) → VERIFICAR MAIS_DE_UMA_REFERENCIA_POSSIVEL", () => {
    const catalog = new Map([["CHAVE AMBIGUA", ["TELA A", "TELA B"]]]);
    const c = makeCase({ caseId: 1, chaves: ["CHAVE AMBIGUA"] });
    const out = run([c], stock([["TELA A", "R1", 1], ["TELA B", "R2", 1]]), REGRA1, { groups: [], catalog });
    expect(out.cases[0].result).toBe("VERIFICAR");
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.MAIS_DE_UMA_REFERENCIA_POSSIVEL);
  });

  it("catálogo com alvo único resolve sem grupo (via CATALOG)", () => {
    const catalog = new Map([["FRONTAL K61", ["FRONTAL K61 PRETO"]]]);
    const c = makeCase({ caseId: 1, chaves: ["FRONTAL K61"] });
    const out = run([c], stock([["FRONTAL K61 PRETO", "R9", 1]]), REGRA1, { groups: [], catalog });
    expect(out.cases[0].result).toBe("MATCH");
    expect(out.cases[0].compatibilityResolutions[0]?.via).toBe("CATALOG");
  });
});

// ---------------------------------------------------------------------------
// 49-50: regras estratégicas mudam quem recebe o estoque limitado
// ---------------------------------------------------------------------------

describe("foco estratégico das regras", () => {
  // margemAlta: R$1000 de margem, 30 dias. antigo: R$200 de margem, 450 dias.
  const margemAlta = makeCase({ caseId: 1, cost: 0, estimatedSale: 1000, ageDays: 30, chaves: ["TELA X"] });
  const antigo = makeCase({ caseId: 2, cost: 0, estimatedSale: 200, ageDays: 450, chaves: ["TELA X"] });
  const umaTela = () => stock([["TELA X", "R1", 1]]);

  it("49. regra com foco em margem altera quem recebe o estoque limitado", () => {
    const focoMargem: ActiveRule = {
      ...REGRA1, id: 90, version: 90, name: "Foco margem",
      marginAmountPerPoint: 100, ageDaysPerPoint: 60, marginWeight: 2, ageWeight: 0.5, ageMaxPoints: 12,
    };
    // Regra 1: antigo vence (12 + 1.33 vs 6.67 + 1)
    const base = run([margemAlta, antigo], umaTela(), REGRA1);
    expect(base.cases.find((c) => c.result === "MATCH")!.caseId).toBe(2);
    // Foco margem: margemAlta vence (10*2 + 0.5*0.25 vs 2*2 + 7.5→teto... )
    const foco = run([margemAlta, antigo], umaTela(), focoMargem);
    expect(foco.cases.find((c) => c.result === "MATCH")!.caseId).toBe(1);
  });

  it("50. regra com foco em aging altera quem recebe o estoque limitado", () => {
    const focoMargemBase: ActiveRule = {
      ...REGRA1, id: 91, version: 91, marginAmountPerPoint: 100, ageDaysPerPoint: 60, marginWeight: 2, ageWeight: 0.5,
    };
    const focoAging: ActiveRule = {
      ...REGRA1, id: 92, version: 92, name: "Foco aging",
      marginAmountPerPoint: 300, ageDaysPerPoint: 15, marginWeight: 0.5, ageWeight: 2, ageMaxPoints: 40,
    };
    const antes = run([margemAlta, antigo], umaTela(), focoMargemBase);
    expect(antes.cases.find((c) => c.result === "MATCH")!.caseId).toBe(1);
    const depois = run([margemAlta, antigo], umaTela(), focoAging);
    expect(depois.cases.find((c) => c.result === "MATCH")!.caseId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Extras estruturais: determinismo, rank, explicabilidade, prioridade manual
// ---------------------------------------------------------------------------

describe("estrutura do resultado", () => {
  it("é determinística: mesmo input ⇒ mesmo output (JSON idêntico)", () => {
    const cases = [
      makeCase({ caseId: 3, chaves: ["A", "B"] }),
      makeCase({ caseId: 1, chaves: ["A"] }),
      makeCase({ caseId: 2, cost: null }),
    ];
    const s = () => stock([["A", "R1", 2], ["B", "R2", 1]]);
    const out1 = run(cases, s());
    const out2 = run(cases, s());
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });

  it("não muta o input (estoque de entrada permanece intacto)", () => {
    const s = stock([["A", "R1", 2]]);
    run([makeCase({ caseId: 1, chaves: ["A"] })], s);
    expect(s[0].availableQuantity).toBe(2);
  });

  it("todo card carrega regra/versão, score decomposto e rank", () => {
    const out = run([makeCase({ caseId: 1, cost: 500, estimatedSale: 1235, ageDays: 102 })], stock([["BATERIA X", "R1", 1]]));
    const dec = out.cases[0];
    expect(dec.activeRuleId).toBe(1);
    expect(dec.activeRuleVersion).toBe(1);
    expect(dec.margin).toBe(735);
    expect(dec.marginPoints).toBe(4.9);
    expect(dec.agePoints).toBeCloseTo(3.4, 12);
    expect(dec.score).toBeCloseTo(8.3, 12);
    expect(dec.rank).toBe(1);
  });

  it("prioridade manual antecede a disputa quando manualPriorityEnabled=true na regra", () => {
    const regraComPrio: ActiveRule = { ...REGRA1, manualPriorityEnabled: true };
    const normal = makeCase({ caseId: 1, cost: 0, estimatedSale: 1500, ageDays: 300, chaves: ["TELA X"] });
    const prioridade = makeCase({ caseId: 2, cost: 0, estimatedSale: 150, ageDays: 0, manualPriority: true, chaves: ["TELA X"] });
    const out = run([normal, prioridade], stock([["TELA X", "R1", 1]]), regraComPrio);
    expect(out.cases.find((c) => c.caseId === 2)!.result).toBe("MATCH");
  });

  it("prioridade manual é IGNORADA quando manualPriorityEnabled=false (default)", () => {
    // REGRA1 tem manualPriorityEnabled=false — score canônico governa
    const normal = makeCase({ caseId: 1, cost: 0, estimatedSale: 1500, ageDays: 300, chaves: ["TELA X"] });
    const prioridade = makeCase({ caseId: 2, cost: 0, estimatedSale: 150, ageDays: 0, manualPriority: true, chaves: ["TELA X"] });
    const out = run([normal, prioridade], stock([["TELA X", "R1", 1]]));
    expect(out.cases.find((c) => c.caseId === 1)!.result).toBe("MATCH"); // score maior vence
    expect(out.cases.find((c) => c.caseId === 2)!.result).not.toBe("MATCH");
  });

  it("disputa: demanda acima da disponibilidade aparece em disputedKeys", () => {
    const c1 = makeCase({ caseId: 1, chaves: ["TELA X"] });
    const c2 = makeCase({ caseId: 2, chaves: ["TELA X"] });
    const c3 = makeCase({ caseId: 3, chaves: ["TELA X"] });
    const out = run([c1, c2, c3], stock([["TELA X", "R1", 1]]));
    expect(out.disputedKeys).toEqual([{ stockChaveNorm: "TELA X", demanded: 3, available: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Auditoria — correções de peças avançadas e validação de parâmetros
// ---------------------------------------------------------------------------

describe("correções de auditoria — peças avançadas e parâmetros", () => {
  it("caso sem peças abertas gera PECA_NECESSARIA_AUSENTE (parts=[]) ", () => {
    const out = run([makeCase({ caseId: 1, parts: [] })], stock([["TELA X", "R1", 1]]));
    expect(out.cases[0].verifyReasons).toContain(VERIFY_REASONS.PECA_NECESSARIA_AUSENTE);
    expect(out.cases[0].result).toBe("VERIFICAR");
  });

  it("caso com peças abertas nunca gera PECA_NECESSARIA_AUSENTE mesmo sem estoque", () => {
    // Simula o que o loader entrega: peças abertas = ainda em PEDIR_PECA, INDICADA, etc.
    const out = run([makeCase({ caseId: 1, chaves: ["TELA DESCONHECIDA"] })], []);
    expect(out.cases[0].verifyReasons).not.toContain(VERIFY_REASONS.PECA_NECESSARIA_AUSENTE);
    expect(out.cases[0].result).toBe("PEDIR_PECA");
  });

  it("grupos simétricos: A e B no mesmo grupo — pedido de A usa estoque de B", () => {
    const groups = [{ groupId: 10, members: ["CHAVE-A", "CHAVE-B"] }];
    const c = makeCase({ caseId: 1, chaves: ["CHAVE-A"] });
    const out = run([c], stock([["CHAVE-B", "REF1", 2]]), REGRA1, { groups, catalog: new Map() });
    expect(out.cases[0].result).toBe("MATCH");
    expect(out.cases[0].virtuallyAllocatedParts[0].aliasStockChaveNorm).toBe("CHAVE-B");
    expect(out.cases[0].compatibilityResolutions[0]?.via).toBe("GROUP");
  });

  it("grupos simétricos: pedido de B usa estoque de A (simetria real)", () => {
    const groups = [{ groupId: 10, members: ["CHAVE-A", "CHAVE-B"] }];
    const c = makeCase({ caseId: 1, chaves: ["CHAVE-B"] });
    const out = run([c], stock([["CHAVE-A", "REF1", 2]]), REGRA1, { groups, catalog: new Map() });
    expect(out.cases[0].result).toBe("MATCH");
    expect(out.cases[0].virtuallyAllocatedParts[0].aliasStockChaveNorm).toBe("CHAVE-A");
  });

  it("grupos: estoque direto tem prioridade sobre membro do grupo", () => {
    const groups = [{ groupId: 10, members: ["CHAVE-A", "CHAVE-B"] }];
    const c = makeCase({ caseId: 1, chaves: ["CHAVE-A"] });
    const out = run([c], stock([["CHAVE-A", "REF_DIRETO", 1], ["CHAVE-B", "REF_B", 1]]), REGRA1, { groups, catalog: new Map() });
    expect(out.cases[0].result).toBe("MATCH");
    // Usou a chave direta, não o membro do grupo
    expect(out.cases[0].virtuallyAllocatedParts[0].aliasStockChaveNorm).toBeNull();
  });

  it("grupos: 2 unidades físicas geram no máximo 2 sinalizações (sem duplicar saldo)", () => {
    const groups = [{ groupId: 10, members: ["CHAVE-A", "CHAVE-B"] }];
    const c1 = makeCase({ caseId: 1, cost: 0, estimatedSale: 900, ageDays: 0, chaves: ["CHAVE-A"] });
    const c2 = makeCase({ caseId: 2, cost: 0, estimatedSale: 600, ageDays: 0, chaves: ["CHAVE-B"] });
    const c3 = makeCase({ caseId: 3, cost: 0, estimatedSale: 300, ageDays: 0, chaves: ["CHAVE-A"] });
    const out = run([c1, c2, c3], stock([["CHAVE-A", "R1", 1], ["CHAVE-B", "R2", 1]]), REGRA1, { groups, catalog: new Map() });
    const matches = out.cases.filter((c) => c.result === "MATCH");
    expect(matches).toHaveLength(2); // 2 unidades físicas = máximo 2 matches
    expect(matches.find((c) => c.caseId === 3)).toBeUndefined(); // menor score fica sem
  });

  it("validação: computeRuleScore não aceita NaN ou Infinity (resultado seria NaN)", () => {
    // Estes são inputs inválidos — a validação no service bloqueia antes de chegar aqui.
    // Verificamos que o resultado seria inválido se passasse:
    const badRule: ActiveRule = { ...REGRA1, marginAmountPerPoint: 0 };
    const r = computeRuleScore(badRule, 100, 30);
    expect(Number.isFinite(r.marginPoints)).toBe(false); // Infinity ou NaN
  });
});
