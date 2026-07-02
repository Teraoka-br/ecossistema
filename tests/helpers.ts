import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import XLSX from "xlsx";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";

/**
 * Cria um banco :memory: com todas as migrations aplicadas.
 * Usar apenas em testes — nunca usa data/app.sqlite.
 */
export async function createDb(): Promise<Db> {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

export interface ErrorCell {
  r: number;
  c: number;
  code?: number;
  w?: string;
}
export interface SheetDef {
  name: string;
  aoa: unknown[][];
  errorCells?: ErrorCell[];
}

/** Cria um .xlsx temporário com as abas/células informadas (inclui erros de fórmula). */
export function makeXlsx(sheets: SheetDef[], fileName = "fixture.xlsx"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-fix-"));
  const filePath = path.join(dir, fileName);
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    for (const e of s.errorCells ?? []) {
      const addr = XLSX.utils.encode_cell({ r: e.r, c: e.c });
      ws[addr] = { t: "e", v: e.code ?? 0x2a, w: e.w ?? "#N/A" };
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  XLSX.writeFile(wb, filePath);
  return filePath;
}

export const ORDERS_HEADER = [
  "ID PEDIDO", "IMEI", "OS", "CONCATPEÇA", "STATUS", "REFPEÇA", "QTDE DE PEÇAS",
  "IDADE", "CUSTO", "VENDA", "MARGEM", "CHAVEPEÇA", "NOTA IDADE", "NOTA MARGEM",
  "SCORE PRIORIDADE", "ORDEMCONSUMO", "QTDESTOQUE", "PEÇAS SEM ESTOQUE",
  "STATUS KIT", "PRIORIDADE KIT",
];

/** Monta uma linha de pedido a partir de um objeto parcial (campos faltantes = ""). */
export function orderRow(o: Partial<Record<string, unknown>>): unknown[] {
  const map: Record<string, unknown> = {
    "ID PEDIDO": o.idPedido ?? "",
    IMEI: o.imei ?? "",
    OS: o.os ?? "",
    "CONCATPEÇA": o.concat ?? "",
    STATUS: o.status ?? "",
    "REFPEÇA": o.ref ?? "",
    "QTDE DE PEÇAS": o.qtde ?? "",
    IDADE: o.idade ?? "",
    CUSTO: o.custo ?? "",
    VENDA: o.venda ?? "",
    MARGEM: o.margem ?? "",
    "CHAVEPEÇA": o.chave ?? "",
    "NOTA IDADE": o.notaIdade ?? "",
    "NOTA MARGEM": o.notaMargem ?? "",
    "SCORE PRIORIDADE": o.score ?? "",
    ORDEMCONSUMO: o.ordem ?? "",
    QTDESTOQUE: o.qtdEstoque ?? "",
    "PEÇAS SEM ESTOQUE": o.semEstoque ?? "",
    "STATUS KIT": o.statusKit ?? "",
    "PRIORIDADE KIT": o.prioridadeKit ?? "",
  };
  return ORDERS_HEADER.map((h) => map[h]);
}

export const BIPAGEM_HEADER = ["REFERENCIA", "DESCRIÇÃO", "FORNECEDOR", "CHAVEPECA", "STATUS", "ARRUMAR"];
export const QUOTATION_HEADER = ["ID PEDIDO", "CHAVEPEÇA", "QTDE", "VALOR UN", "VALOR TOTAL", "DATA COTAÇÃO", "STATUS"];
export const ANALYSIS_HEADER = [
  "IMEI", "OS", "MARCA", "MODELO", "COR", "PEÇASOLICITADA", "CORNAPEÇA", "DATAPEDIDO",
  "STATUS", "CONCATPEÇA", "DEPÓSITO", "DESCRIÇÃO", "REF", "ID PEDIDO", "SOLICITANTE",
];

export function cleanup(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
