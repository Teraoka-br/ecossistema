import crypto from "node:crypto";
import fs from "node:fs";
import XLSX from "xlsx";
import { type RawCell, errorTextFromCode } from "./value.js";

export interface SheetMatrix {
  name: string;
  rows: RawCell[][];
  /** Número da linha do Excel (1-based) correspondente a rows[0]. */
  firstRowNumber: number;
}

/** SHA-256 do conteúdo do arquivo (hex). */
export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function cellToRaw(cell: XLSX.CellObject | undefined): RawCell {
  if (!cell) return { value: null, error: null };
  if (cell.t === "e") {
    const code = typeof cell.v === "number" ? cell.v : 0xff;
    return { value: null, error: errorTextFromCode(code, cell.w) };
  }
  const v = cell.v;
  if (v === undefined) return { value: null, error: null };
  return { value: v as RawCell["value"], error: null };
}

function worksheetToMatrix(ws: XLSX.WorkSheet): { rows: RawCell[][]; firstRowNumber: number } {
  const ref = ws["!ref"];
  if (!ref) return { rows: [], firstRowNumber: 1 };
  const range = XLSX.utils.decode_range(ref);
  const rows: RawCell[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: RawCell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      row.push(cellToRaw(ws[addr] as XLSX.CellObject | undefined));
    }
    rows.push(row);
  }
  return { rows, firstRowNumber: range.s.r + 1 };
}

/** Lista apenas os nomes das abas (leitura leve). */
export function listSheetNames(filePath: string): string[] {
  const wb = XLSX.readFile(filePath, { bookSheets: true });
  return wb.SheetNames;
}

/**
 * Lê apenas as primeiras `maxRows` linhas de cada aba (para detecção de
 * cabeçalhos). Mantém o uso de memória baixo mesmo em arquivos grandes.
 *
 * ATENÇÃO: ainda assim decompacta o XML de TODAS as abas do arquivo (a
 * truncagem só limita as linhas retornadas, não o que é lido do disco/zip).
 * Em arquivos com abas históricas gigantes (centenas de MB de XML), prefira
 * `readTopRowsForSheets` informando só as abas candidatas.
 */
export function readTopRows(filePath: string, maxRows = 15): SheetMatrix[] {
  const wb = XLSX.readFile(filePath, { sheetRows: maxRows, cellDates: true });
  return wb.SheetNames.map((name) => {
    const { rows, firstRowNumber } = worksheetToMatrix(wb.Sheets[name]);
    return { name, rows, firstRowNumber };
  });
}

/**
 * Lê apenas as primeiras `maxRows` linhas, e apenas das abas informadas.
 * Usa a opção `sheets` do xlsx para nunca decompactar/parsear abas fora da
 * lista (ex.: abas históricas gigantes como "His Estoque") — peça central da
 * detecção em etapas: só expande a varredura quando algum papel obrigatório
 * ainda não foi encontrado entre as abas candidatas.
 */
export function readTopRowsForSheets(filePath: string, sheetNames: string[], maxRows = 15): SheetMatrix[] {
  if (sheetNames.length === 0) return [];
  const wb = XLSX.readFile(filePath, { sheets: sheetNames, sheetRows: maxRows, cellDates: true });
  return sheetNames
    .filter((name) => wb.Sheets[name] !== undefined)
    .map((name) => {
      const { rows, firstRowNumber } = worksheetToMatrix(wb.Sheets[name]);
      return { name, rows, firstRowNumber };
    });
}

/**
 * Lê integralmente apenas as abas informadas (usa a opção `sheets` do xlsx
 * para não carregar abas pesadas como "His Estoque").
 */
export function readSheets(filePath: string, sheetNames: string[]): Map<string, SheetMatrix> {
  const result = new Map<string, SheetMatrix>();
  if (sheetNames.length === 0) return result;
  const wb = XLSX.readFile(filePath, { sheets: sheetNames, cellDates: true });
  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const { rows, firstRowNumber } = worksheetToMatrix(ws);
    result.set(name, { name, rows, firstRowNumber });
  }
  return result;
}
