import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm, ImportError } from "../src/import/import-service.js";
import { activeBatchId } from "../src/db/queries.js";
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

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

const validOrders = [orderRow({ idPedido: "PED1", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })];
const validInventory = [["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]];

function pairOrders(sheets: { name: string; aoa: unknown[][] }[]) {
  const p = makeXlsx(sheets, "PEDIDOS.xlsx");
  created.push(p);
  return { filePath: p, fileName: "PEDIDOS.xlsx" };
}
function pairAnalysis(sheets: { name: string; aoa: unknown[][] }[] = [{ name: "ANALISEMI", aoa: [ANALYSIS_HEADER] }]) {
  const p = makeXlsx(sheets, "ANALISE MI.xlsx");
  created.push(p);
  return { filePath: p, fileName: "ANALISE MI.xlsx" };
}

describe("ocorrências fatais bloqueiam a confirmação (HTTP 422 via ImportError)", () => {
  it("tabela de pedidos ausente bloqueia confirmação", () => {
    const db = freshDb();
    const orders = pairOrders([
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ...validInventory] },
    ]);
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(false);
    expect(pv.fatalIssuesCount).toBeGreaterThanOrEqual(1);
    expect(pv.issues.some((i) => i.code === "MISSING_ORDERS_TABLE")).toBe(true);

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect(caught?.statusCode).toBe(422);
  });

  it("tabela de estoque ausente bloqueia confirmação", () => {
    const db = freshDb();
    const orders = pairOrders([{ name: "PEDIDOS", aoa: [ORDERS_HEADER, ...validOrders] }]);
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(false);
    expect(pv.issues.some((i) => i.code === "MISSING_INVENTORY_TABLE")).toBe(true);

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught?.statusCode).toBe(422);
  });

  it("zero pedidos encontrados (tabela vazia) bloqueia confirmação", () => {
    const db = freshDb();
    const orders = pairOrders([
      { name: "PEDIDOS", aoa: [ORDERS_HEADER] }, // só cabeçalho, nenhuma linha
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ...validInventory] },
    ]);
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(false);
    expect(pv.issues.some((i) => i.code === "NO_VALID_ORDERS")).toBe(true);

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught?.statusCode).toBe(422);
  });

  it("zero unidades de estoque encontradas (tabela vazia) bloqueia confirmação", () => {
    const db = freshDb();
    const orders = pairOrders([
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, ...validOrders] },
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER] }, // só cabeçalho
    ]);
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(false);
    expect(pv.issues.some((i) => i.code === "NO_VALID_INVENTORY")).toBe(true);

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught?.statusCode).toBe(422);
  });

  it("linhas encontradas mas zero pedidos válidos (todas sem ID_PEDIDO) bloqueia confirmação", () => {
    const db = freshDb();
    // Linha de pedido NÃO vazia (tem peça/status), mas sem ID_PEDIDO -> rejeitada.
    // Linha de estoque NÃO vazia (tem fornecedor/status), mas sem REFERENCIA e sem CHAVEPECA -> ignorada.
    const orders = pairOrders([
      {
        name: "PEDIDOS",
        aoa: [ORDERS_HEADER, orderRow({ idPedido: "", imei: "1", chave: "BAT", status: "PEDIR PEÇA", statusKit: "KIT INCOMPLETO" })],
      },
      {
        name: "BIPAGEM DE PEÇAS",
        aoa: [BIPAGEM_HEADER, ["", "DESC SEM REF NEM CHAVE", "QUARTT", "", "DISPONÍVEL", ""]],
      },
    ]);
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);

    expect(pv.counts.ordersFound).toBeGreaterThan(0);
    expect(pv.counts.ordersValid).toBe(0);
    expect(pv.counts.inventoryFound).toBeGreaterThan(0);
    expect(pv.counts.inventoryValid).toBe(0);
    expect(pv.canConfirm).toBe(false);
    expect(pv.issues.some((i) => i.code === "NO_VALID_ORDERS")).toBe(true);
    expect(pv.issues.some((i) => i.code === "NO_VALID_INVENTORY")).toBe(true);

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect(caught?.statusCode).toBe(422);
    // Nenhum lote inválido pode se tornar ativo.
    expect(activeBatchId(db)).toBeNull();
  });

  it("mesma referência com duas CHAVEPECA diferentes bloqueia confirmação (REFERENCE_KEY_CONFLICT)", () => {
    const db = freshDb();
    const orders = pairOrders([
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, ...validOrders] },
      {
        name: "BIPAGEM DE PEÇAS",
        aoa: [
          BIPAGEM_HEADER,
          ["PC-1", "DESC A", "QUARTT", "CHAVE A", "DISPONÍVEL", "PC-1"],
          ["PC-1", "DESC B", "QUARTT", "CHAVE B", "DISPONÍVEL", "PC-1"],
        ],
      },
    ]);
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(false);
    const issue = pv.issues.find((i) => i.code === "REFERENCE_KEY_CONFLICT");
    expect(issue?.severity).toBe("CONFLICT");
    expect(issue?.entityKey).toBe("PC-1");

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught?.statusCode).toBe(422);
  });

  it("arquivo ilegível/ausente bloqueia a confirmação (canConfirm=false na prévia, 422 na confirmação)", () => {
    const db = freshDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-bad-"));
    // Caminho que nunca existiu: simula arquivo ilegível/ausente no momento da leitura.
    const missingPath = path.join(dir, "PEDIDOS-nao-existe.xlsx");
    created.push(path.join(dir, "placeholder")); // garante que `dir` seja limpo pelo cleanup()
    fs.writeFileSync(path.join(dir, "placeholder"), "");

    const orders = { filePath: missingPath, fileName: "PEDIDOS.xlsx" };
    const analysis = pairAnalysis();
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(false);
    expect(pv.issues.some((i) => i.code === "FILE_UNREADABLE")).toBe(true);

    let caught: ImportError | undefined;
    try {
      confirm(db, pv.previewBatchId);
    } catch (e) {
      caught = e as ImportError;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect(caught?.statusCode).toBe(422);
  });

  it("canConfirm e fatalIssuesCount refletem corretamente um cenário sem ocorrências fatais", () => {
    const db = freshDb();
    const orders = pairOrders([
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, ...validOrders] },
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ...validInventory] },
    ]);
    const analysis = pairAnalysis([{ name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER] }, { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] }]);
    const pv = preview(db, orders, analysis);
    expect(pv.canConfirm).toBe(true);
    expect(pv.fatalIssuesCount).toBe(0);

    // Confirmação não deve lançar.
    expect(() => confirm(db, pv.previewBatchId)).not.toThrow();
  });
});
