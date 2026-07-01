import { afterEach, describe, expect, it } from "vitest";
import { analyzeFiles } from "../src/import/import-service.js";
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
function fixture(...args: Parameters<typeof makeXlsx>): string {
  const p = makeXlsx(...args);
  created.push(p);
  return p;
}
afterEach(() => {
  while (created.length) cleanup(created.pop()!);
});

function buildFiles(opts: {
  orders: unknown[][];
  inventory?: unknown[][];
  inventoryHeader?: unknown[];
  quotations?: unknown[][];
  ordersErrorCells?: { r: number; c: number }[];
}) {
  const ordersPath = fixture(
    [
      { name: "ALEATORIA", aoa: [["foo", "bar"], [1, 2]] }, // aba "lixo" primeiro (posição não importa)
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, ...opts.orders], errorCells: opts.ordersErrorCells?.map((e) => ({ ...e })) },
      { name: "BIPAGEM DE PEÇAS", aoa: [opts.inventoryHeader ?? BIPAGEM_HEADER, ...(opts.inventory ?? [])] },
    ],
    "PEDIDOS.xlsx",
  );
  const analysisPath = fixture(
    [
      { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER, ...(opts.quotations ?? [])] },
      { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
    ],
    "ANALISE MI.xlsx",
  );
  return analyzeFiles(
    { filePath: ordersPath, fileName: "PEDIDOS.xlsx" },
    { filePath: analysisPath, fileName: "ANALISE MI.xlsx" },
  );
}

describe("detecção por cabeçalho (independente da posição da aba)", () => {
  it("localiza pedidos, estoque e cotações pelo conteúdo dos cabeçalhos", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PED1", imei: "111", chave: "BATERIA 13", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventory: [["PC-1", "BAT 13", "QUARTT", "BATERIA 13", "DISPONÍVEL", "PC-1"]],
      quotations: [["PED1", "BATERIA 13", 5, 50, 250, "2026-06-26", "APROVADO"]],
    });
    expect(out.assignment.orders?.detection.sheetName).toBe("PEDIDOS");
    expect(out.assignment.inventory?.detection.sheetName).toBe("BIPAGEM DE PEÇAS");
    expect(out.assignment.quotations?.detection.sheetName).toBe("PEÇAS A PEDIR");
    expect(out.orders.records).toHaveLength(1);
    expect(out.quotations.records).toHaveLength(1);
  });
});

describe("regras de mapeamento de pedidos", () => {
  it("preserva ID PEDIDO e reconhece status com acento (CONCLUÍDO)", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDABC", imei: "999", chave: "TELA X", status: "Concluído", statusKit: "KIT POSSÍVEL" })],
    });
    const r = out.orders.records[0];
    expect(r.idPedido).toBe("PEDABC");
    expect(r.statusToken).toBe("CONCLUIDO");
    expect(r.statusLabel).toBe("CONCLUÍDO");
  });

  it("CHAVEPEÇA vazia gera warning mas importa a linha", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PED2", imei: "222", chave: "", status: "PEDIR PEÇA", statusKit: "KIT INCOMPLETO" })],
    });
    expect(out.orders.records).toHaveLength(1);
    expect(out.issues.some((i) => i.code === "CHAVEPECA_VAZIA" && i.severity === "WARNING")).toBe(true);
  });

  it("erro de fórmula em campo opcional (CUSTO) vira null + warning", () => {
    // CUSTO é a coluna índice 8 do cabeçalho; linha de dados 0 => row r=2 (após lixo? não: nesta aba header r=0, dado r=1)
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PED3", imei: "333", chave: "BAT", status: "PEDIR PEÇA", statusKit: "KIT POSSÍVEL", venda: 100 })],
      ordersErrorCells: [{ r: 1, c: ORDERS_HEADER.indexOf("CUSTO") }],
    });
    const r = out.orders.records[0];
    expect(r.custo).toBeNull();
    expect(out.issues.some((i) => i.code === "FORMULA_ERROR" && i.severity === "WARNING")).toBe(true);
  });

  it("ID_PEDIDO duplicado no mesmo snapshot é erro e rejeita a linha duplicada", () => {
    const out = buildFiles({
      orders: [
        orderRow({ idPedido: "PEDDUP", imei: "444", chave: "BATERIA 13", status: "PEDIR PEÇA", statusKit: "KIT POSSÍVEL" }),
        orderRow({ idPedido: "PEDDUP", imei: "444", chave: "CARCAÇA 13", status: "PEDIR PEÇA", statusKit: "KIT POSSÍVEL" }),
      ],
    });
    expect(out.orders.records).toHaveLength(1);
    expect(out.issues.some((i) => i.code === "DUPLICATE_ID_PEDIDO" && i.severity === "ERROR")).toBe(true);
  });

  it("mesmo IMEI com ID_PEDIDO diferentes e peças diferentes importa as duas linhas", () => {
    const out = buildFiles({
      orders: [
        orderRow({ idPedido: "PED-A", imei: "555", chave: "BATERIA 13", qtde: 2, status: "PEDIR PEÇA", statusKit: "MATCH PARCIAL" }),
        orderRow({ idPedido: "PED-B", imei: "555", chave: "CARCAÇA 13", qtde: 2, status: "PEDIR PEÇA", statusKit: "MATCH PARCIAL" }),
      ],
    });
    expect(out.orders.records).toHaveLength(2);
    expect(out.orders.records.map((r) => r.idPedido).sort()).toEqual(["PED-A", "PED-B"]);
    expect(out.orders.records.every((r) => r.imei === "555")).toBe(true);
    expect(out.issues.some((i) => i.code === "DUPLICATE_ID_PEDIDO")).toBe(false);
  });
});

describe("estoque físico", () => {
  it("mantém uma linha por unidade e a contagem soma as referências iguais", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDX", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventory: [
        ["PC-QA7345", "FRONTAL 11", "QUARTT", "FRONTAL 11", "DISPONÍVEL", "PC-QA7345"],
        ["PC-QA7345", "FRONTAL 11", "QUARTT", "FRONTAL 11", "DISPONÍVEL", "PC-QA7345"],
        ["PC-QA7345", "FRONTAL 11", "QUARTT", "FRONTAL 11", "DISPONÍVEL", "PC-QA7345"],
      ],
    });
    expect(out.inventory.records).toHaveLength(3); // 3 unidades físicas
    expect(out.inventory.records.every((r) => r.referenciaNorm === "PC-QA7345")).toBe(true);
  });

  it("preserva ID_PECA_ESTOQUE quando a coluna existe e detecta duplicado", () => {
    const header = ["ID PEÇA", ...BIPAGEM_HEADER];
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDY", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventoryHeader: header,
      inventory: [
        ["IDP-1", "PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
        ["IDP-1", "PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"], // id duplicado
        ["IDP-2", "PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
      ],
    });
    const ids = out.inventory.records.map((r) => r.idPecaEstoque);
    expect(ids).toContain("IDP-1");
    expect(ids).toContain("IDP-2");
    expect(out.inventory.records).toHaveLength(2); // a unidade com id duplicado é ignorada
    expect(out.issues.some((i) => i.code === "DUPLICATE_ID_PECA_ESTOQUE")).toBe(true);
    // coluna existe => NÃO emite o aviso de coluna ausente
    expect(out.issues.some((i) => i.code === "INVENTORY_ID_COLUMN_MISSING")).toBe(false);
  });

  it("unidade de estoque sem CHAVEPECA gera warning (entity_key = referência) e importa", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDZ", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventory: [["PC-9", "DESC", "QUARTT", "", "DISPONÍVEL", "PC-9"]],
    });
    expect(out.inventory.records).toHaveLength(1);
    const w = out.issues.find((i) => i.code === "INVENTORY_CHAVEPECA_EMPTY");
    expect(w?.severity).toBe("WARNING");
    expect(w?.entityKey).toBe("PC-9");
  });

  it("coluna ID_PECA_ESTOQUE ausente gera UM único warning com o total", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDW", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventory: [
        ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
        ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
      ],
    });
    const missing = out.issues.filter((i) => i.code === "INVENTORY_ID_COLUMN_MISSING");
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("2");
  });

  it("ID físico vazio (coluna existe) gera warning por linha e importa", () => {
    const header = ["ID PEÇA", ...BIPAGEM_HEADER];
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDV", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventoryHeader: header,
      inventory: [
        ["IDP-1", "PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
        ["", "PC-2", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-2"],
      ],
    });
    expect(out.inventory.records).toHaveLength(2);
    expect(out.issues.some((i) => i.code === "MISSING_ID_PECA_ESTOQUE" && i.severity === "WARNING")).toBe(true);
  });

  it("mesma referência com duas CHAVEPECA diferentes gera REFERENCE_KEY_CONFLICT", () => {
    const out = buildFiles({
      orders: [orderRow({ idPedido: "PEDC", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
      inventory: [
        ["PC-1", "DESC A", "QUARTT", "CHAVE A", "DISPONÍVEL", "PC-1"],
        ["PC-1", "DESC B", "QUARTT", "CHAVE B", "DISPONÍVEL", "PC-1"],
      ],
    });
    const c = out.issues.find((i) => i.code === "REFERENCE_KEY_CONFLICT");
    expect(c?.severity).toBe("CONFLICT");
    expect(c?.entityKey).toBe("PC-1");
  });
});
