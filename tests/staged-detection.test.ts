import { afterEach, describe, expect, it } from "vitest";
import { analyzeFiles } from "../src/import/import-service.js";
import { isCandidateSheetName, isHistoricalSheetName } from "../src/import/table-detection.js";
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
afterEach(() => {
  while (created.length) cleanup(created.pop()!);
});
function fixture(...args: Parameters<typeof makeXlsx>): string {
  const p = makeXlsx(...args);
  created.push(p);
  return p;
}

describe("nomes de aba: candidatos vs históricos (heurística de 1ª passagem)", () => {
  it("reconhece os nomes candidatos conhecidos por papel", () => {
    expect(isCandidateSheetName("PEDIDOS")).toBe(true);
    expect(isCandidateSheetName("ANALISE_MI")).toBe(true);
    expect(isCandidateSheetName("ANALISE MI")).toBe(true);
    expect(isCandidateSheetName("PEDIDOS FULL")).toBe(true);
    expect(isCandidateSheetName("BIPAGEM DE PEÇAS")).toBe(true);
    expect(isCandidateSheetName("CONTAGEM DE PEÇAS")).toBe(true);
    expect(isCandidateSheetName("ANALISEMI")).toBe(true);
    expect(isCandidateSheetName("ANALISE")).toBe(true);
    expect(isCandidateSheetName("PEÇAS A PEDIR")).toBe(true);
  });

  it("identifica abas históricas/volumosas conhecidas", () => {
    expect(isHistoricalSheetName("His Estoque")).toBe(true);
    expect(isHistoricalSheetName("TODOS")).toBe(true);
    expect(isHistoricalSheetName("SH")).toBe(true);
    expect(isHistoricalSheetName("COM SALDO")).toBe(true);
    expect(isHistoricalSheetName("DEMONSTRATIVO DE SALDO")).toBe(true);
    expect(isHistoricalSheetName("TABELA DE AVALIAÇÃO (PEACS)")).toBe(true);
  });

  it("aba histórica nunca é candidata, mesmo que o nome pudesse soar relacionado", () => {
    expect(isCandidateSheetName("His Estoque")).toBe(false);
    expect(isCandidateSheetName("TODOS")).toBe(false);
  });

  it("nomes irrelevantes não são candidatos nem históricos", () => {
    expect(isCandidateSheetName("Plan1")).toBe(false);
    expect(isHistoricalSheetName("Plan1")).toBe(false);
  });
});

describe("detecção em etapas — comportamento de ponta a ponta", () => {
  it("prioriza abas candidatas e encontra os papéis sem precisar de fallback", () => {
    const ordersPath = fixture(
      [
        { name: "PEDIDOS", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED1", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })] },
        { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]] },
      ],
      "PEDIDOS.xlsx",
    );
    const analysisPath = fixture(
      [
        { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER] },
        { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
      ],
      "ANALISE MI.xlsx",
    );
    const out = analyzeFiles(
      { filePath: ordersPath, fileName: "PEDIDOS.xlsx" },
      { filePath: analysisPath, fileName: "ANALISE MI.xlsx" },
    );
    expect(out.assignment.orders?.detection.sheetName).toBe("PEDIDOS");
    expect(out.assignment.inventory?.detection.sheetName).toBe("BIPAGEM DE PEÇAS");
  });

  it("não seleciona aba histórica gigante mesmo que ela contenha cabeçalhos de pedidos", () => {
    // "His Estoque" é deny-listada: mesmo tendo o cabeçalho de PEDIDOS dentro
    // dela (cenário de teste deliberadamente adversarial), o sistema nunca a
    // lê — então o papel ORDERS fica ausente, em vez de apontar para ela.
    const ordersPath = fixture(
      [
        { name: "His Estoque", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED-ARMADILHA", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })] },
        { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]] },
      ],
      "PEDIDOS.xlsx",
    );
    const analysisPath = fixture([{ name: "ANALISEMI", aoa: [ANALYSIS_HEADER] }], "ANALISE MI.xlsx");

    const out = analyzeFiles(
      { filePath: ordersPath, fileName: "PEDIDOS.xlsx" },
      { filePath: analysisPath, fileName: "ANALISE MI.xlsx" },
    );
    expect(out.assignment.orders).toBeUndefined();
    expect(out.issues.some((i) => i.code === "MISSING_ORDERS_TABLE")).toBe(true);
    // A aba histórica nunca aparece entre as detecções (prova que não foi lida).
    expect(out.assignment.allDetections.some((d) => d.sheetName === "His Estoque")).toBe(false);
  });

  it("expande para abas não-candidatas (fallback) quando o nome não é reconhecido", () => {
    // Aba de pedidos com nome atípico ("DADOS") — não é candidata por nome,
    // mas também não é histórica, então a 2ª etapa deve encontrá-la pelo
    // conteúdo do cabeçalho.
    const ordersPath = fixture(
      [
        { name: "DADOS", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED-FALLBACK", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })] },
        { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]] },
      ],
      "PEDIDOS.xlsx",
    );
    const analysisPath = fixture([{ name: "ANALISEMI", aoa: [ANALYSIS_HEADER] }], "ANALISE MI.xlsx");

    const out = analyzeFiles(
      { filePath: ordersPath, fileName: "PEDIDOS.xlsx" },
      { filePath: analysisPath, fileName: "ANALISE MI.xlsx" },
    );
    expect(out.assignment.orders?.detection.sheetName).toBe("DADOS");
    expect(out.orders.records).toHaveLength(1);
  });
});
