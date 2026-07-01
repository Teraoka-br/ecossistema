import { describe, expect, it } from "vitest";
import { normalizeHeader, normalizeStatus, normalizeKey } from "../src/domain/text.js";
import {
  isPermanentStatus,
  kitPriority,
  orderStatusLabel,
  orderStatusToken,
} from "../src/domain/status.js";
import {
  comparePriority,
  computeMargin,
  computeScore,
  excelInt,
  notaIdade,
  notaMargem,
} from "../src/domain/scoring.js";

describe("normalização de texto", () => {
  it("normaliza cabeçalhos com acento, caixa e separadores", () => {
    expect(normalizeHeader("CHAVEPEÇA")).toBe("CHAVEPECA");
    expect(normalizeHeader("Chave Peca")).toBe("CHAVE PECA");
    expect(normalizeHeader("ID_PECA_ESTOQUE")).toBe("ID PECA ESTOQUE");
    expect(normalizeHeader("  Nota   Idade ")).toBe("NOTA IDADE");
  });
  it("normaliza chaves preservando o conteúdo", () => {
    expect(normalizeKey("CARCAÇA IPHONE 13 Pret ")).toBe("CARCACA IPHONE 13 PRET");
  });
});

describe("status", () => {
  it("reconhece acentos no status (CONCLUÍDO)", () => {
    expect(normalizeStatus("Concluído")).toBe("CONCLUIDO");
    expect(orderStatusToken("concluído")).toBe("CONCLUIDO");
    expect(isPermanentStatus("Concluído")).toBe(true);
    expect(isPermanentStatus("CONCLUIDO")).toBe(true);
  });
  it("status permanentes são protegidos", () => {
    expect(isPermanentStatus("SEPARADO")).toBe(true);
    expect(isPermanentStatus("Cancelado")).toBe(true);
    expect(isPermanentStatus("PEDIR PEÇA")).toBe(false);
  });
  it("rótulo amigável e fallback", () => {
    expect(orderStatusLabel("pedir peça")).toBe("PEDIR PEÇA");
    expect(orderStatusLabel("ALGO NOVO")).toBe("ALGO NOVO");
  });
  it("prioridade do kit", () => {
    expect(kitPriority("KIT POSSÍVEL")).toBe(1);
    expect(kitPriority("MATCH PARCIAL")).toBe(2);
    expect(kitPriority("KIT INCOMPLETO")).toBe(9);
    expect(kitPriority("VERIFICAR")).toBe(9);
  });
});

describe("score (regras configuráveis)", () => {
  it("INT do Excel arredonda para -infinito (margem negativa)", () => {
    expect(excelInt(-0.3)).toBe(-1);
    expect(notaMargem(-50)).toBe(-1);
    expect(notaMargem(669)).toBe(4);
  });
  it("nota de idade tem teto e piso", () => {
    expect(notaIdade(0)).toBe(0);
    expect(notaIdade(96)).toBe(3);
    expect(notaIdade(99999)).toBe(15);
    expect(notaIdade(-10)).toBe(0);
  });
  it("margem ausente => null + warning, nota 0", () => {
    expect(computeMargin(null, 100)).toBeNull();
    const s = computeScore({ idade: 96, custo: null, venda: 100 });
    expect(s.margem).toBeNull();
    expect(s.notaMargem).toBe(0);
    expect(s.warnings).toContain("MARGEM_INDISPONIVEL");
    expect(s.score).toBe(3);
  });
  it("regras configuráveis alteram o resultado", () => {
    const s = computeScore({ idade: 100, custo: 0, venda: 300 }, {
      ageDaysPerPoint: 50, ageMaxPoints: 5, marginPerPoint: 100, marginAllowsNegative: true,
    });
    expect(s.notaIdade).toBe(2); // floor(100/50)
    expect(s.notaMargem).toBe(3); // floor(300/100)
    expect(s.score).toBe(5);
  });
  it("ordem de prioridade: menos peças > maior score > maior margem > id estável", () => {
    const a = { totalParts: 1, score: 5, margem: 100, stableId: "A" };
    const b = { totalParts: 2, score: 9, margem: 999, stableId: "B" };
    expect(comparePriority(a, b)).toBeLessThan(0); // a antes (menos peças)
    const c = { totalParts: 1, score: 5, margem: 50, stableId: "C" };
    expect(comparePriority(a, c)).toBeLessThan(0); // mesma qtd/score, maior margem primeiro
  });
});
