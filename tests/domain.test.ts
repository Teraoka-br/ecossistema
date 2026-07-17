import { describe, expect, it } from "vitest";
import { normalizeHeader, normalizeStatus, normalizeKey } from "../src/domain/text.js";
import {
  isPermanentStatus,
  kitPriority,
  orderStatusLabel,
  orderStatusToken,
} from "../src/domain/status.js";

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

// O cálculo de score do domínio legado (domain/scoring.ts, com arredondamento
// estilo Excel) foi aposentado — a única implementação canônica é
// calculateMatch/computeRuleScore, testada em tests/calculate-match.test.ts.
