import type { ImportIssue } from "../shared/types.js";
import { normalizeKey } from "../domain/text.js";
import { orderStatusLabel, orderStatusToken, kitPriority } from "../domain/status.js";
import type { ColumnIndex } from "./columns.js";
import type { SheetDetection } from "./table-detection.js";
import type { SheetMatrix } from "./xlsx-reader.js";
import {
  type RawCell,
  cellDateISO,
  cellInt,
  cellNumber,
  cellText,
  isEmptyCell,
} from "./value.js";

export interface OrderPartRecord {
  idPedido: string;
  imei: string | null;
  os: string | null;
  concatPeca: string | null;
  chavePeca: string | null;
  chavePecaNorm: string;
  referencia: string | null;
  statusToken: string | null;
  statusLabel: string | null;
  statusKitToken: string | null;
  prioridadeKit: number | null;
  quantidadePecas: number | null;
  idade: number | null;
  custo: number | null;
  venda: number | null;
  margem: number | null;
  notaIdade: number | null;
  notaMargem: number | null;
  score: number | null;
  ordemConsumo: number | null;
  qtdEstoque: number | null;
  pecasSemEstoque: number | null;
  rawJson: string;
}

export interface InventoryRecord {
  idPecaEstoque: string | null;
  referencia: string | null;
  referenciaNorm: string;
  descricao: string | null;
  chavePeca: string | null;
  chavePecaNorm: string;
  fornecedor: string | null;
  statusFisico: string | null;
  snapshotRow: number;
  rawJson: string;
}

export interface QuotationRecord {
  idPedido: string | null;
  chavePeca: string | null;
  chavePecaNorm: string;
  quantidade: number | null;
  valorUnitario: number | null;
  valorTotal: number | null;
  dataCotacao: string | null;
  status: string | null;
  rawJson: string;
}

export interface AnalysisRecord {
  idPedido: string | null;
  imei: string | null;
  os: string | null;
  marca: string | null;
  modelo: string | null;
  cor: string | null;
  pecaSolicitada: string | null;
  corNaPeca: string | null;
  dataPedido: string | null;
  status: string | null;
  concatPeca: string | null;
  chavePecaNorm: string;
  deposito: string | null;
  descricao: string | null;
  ref: string | null;
  solicitante: string | null;
  rawJson: string;
}

export interface MapOutput<T> {
  records: T[];
  issues: ImportIssue[];
  rowsFound: number;
}

function rowIsEmpty(row: RawCell[]): boolean {
  return row.every((c) => isEmptyCell(c));
}

function buildRawJson(header: string[], row: RawCell[]): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < header.length; i++) {
    const key = header[i];
    if (!key) continue;
    const cell = row[i];
    if (!cell) continue;
    if (cell.error) obj[key] = cell.error;
    else if (cell.value instanceof Date) obj[key] = cellDateISO(cell);
    else if (cell.value !== null && cell.value !== "") obj[key] = cell.value;
  }
  return JSON.stringify(obj);
}

/** Coleta erros de fórmula em campos opcionais → vira null + warning. */
function collectFormulaWarnings(
  fields: { field: string; idx: number | undefined }[],
  row: RawCell[],
  ctx: { fileName: string; sheetName: string; rowNumber: number; entityKey: string | null },
  entityType: ImportIssue["entityType"],
  issues: ImportIssue[],
): void {
  for (const { field, idx } of fields) {
    if (idx === undefined) continue;
    const cell = row[idx];
    if (cell?.error) {
      issues.push({
        fileName: ctx.fileName,
        sheetName: ctx.sheetName,
        rowNumber: ctx.rowNumber,
        entityType,
        entityKey: ctx.entityKey,
        severity: "WARNING",
        code: "FORMULA_ERROR",
        message: `Erro de fórmula em "${field}" convertido para vazio (${cell.error}).`,
        rawValue: cell.error,
      });
    }
  }
}

const dataRows = (matrix: SheetMatrix, det: SheetDetection): { row: RawCell[]; rowNumber: number }[] => {
  const out: { row: RawCell[]; rowNumber: number }[] = [];
  for (let i = det.headerRowIndex + 1; i < matrix.rows.length; i++) {
    out.push({ row: matrix.rows[i], rowNumber: matrix.firstRowNumber + i });
  }
  return out;
};

export function mapOrders(matrix: SheetMatrix, det: SheetDetection, cols: ColumnIndex): MapOutput<OrderPartRecord> {
  const issues: ImportIssue[] = [];
  const records: OrderPartRecord[] = [];
  const seen = new Set<string>();
  const header = det.normalizedHeader;
  let rowsFound = 0;

  for (const { row, rowNumber } of dataRows(matrix, det)) {
    if (rowIsEmpty(row)) continue;
    rowsFound++;
    const idPedido = cellText(row[cols.idPedido]);
    const chaveRaw = cols.chavePeca !== undefined ? cellText(row[cols.chavePeca]) : null;
    const chaveNorm = normalizeKey(chaveRaw);

    if (!idPedido) {
      issues.push({
        fileName: det.fileName, sheetName: det.sheetName, rowNumber,
        entityType: "ORDER_PART", entityKey: chaveRaw,
        severity: "ERROR", code: "MISSING_ID_PEDIDO",
        message: "Linha de pedido sem ID PEDIDO (não importada).",
        rawValue: null,
      });
      continue;
    }

    // ID_PEDIDO é a identidade ESTÁVEL da linha (única por solicitação de peça).
    // O aparelho é o IMEI; o mesmo IMEI em várias linhas NÃO é duplicidade.
    if (seen.has(idPedido)) {
      issues.push({
        fileName: det.fileName, sheetName: det.sheetName, rowNumber,
        entityType: "ORDER_PART", entityKey: idPedido,
        severity: "ERROR", code: "DUPLICATE_ID_PEDIDO",
        message: `ID PEDIDO duplicado no mesmo snapshot: ${idPedido} (linha rejeitada).`,
        rawValue: null,
      });
      continue;
    }
    seen.add(idPedido);

    if (!chaveRaw) {
      issues.push({
        fileName: det.fileName, sheetName: det.sheetName, rowNumber,
        entityType: "ORDER_PART", entityKey: idPedido,
        severity: "WARNING", code: "CHAVEPECA_VAZIA",
        message: "CHAVEPEÇA vazia nesta linha de pedido.",
        rawValue: null,
      });
    }

    collectFormulaWarnings(
      [
        { field: "CUSTO", idx: cols.custo },
        { field: "VENDA", idx: cols.venda },
        { field: "MARGEM", idx: cols.margem },
        { field: "IDADE", idx: cols.idade },
      ],
      row,
      { fileName: det.fileName, sheetName: det.sheetName, rowNumber, entityKey: idPedido },
      "ORDER_PART",
      issues,
    );

    const statusRaw = cols.status !== undefined ? cellText(row[cols.status]) : null;
    const statusKitRaw = cols.statusKit !== undefined ? cellText(row[cols.statusKit]) : null;
    const prioridadeKit =
      cols.prioridadeKit !== undefined && !isEmptyCell(row[cols.prioridadeKit])
        ? cellInt(row[cols.prioridadeKit])
        : statusKitRaw
          ? kitPriority(statusKitRaw)
          : null;

    records.push({
      idPedido,
      imei: cols.imei !== undefined ? cellText(row[cols.imei]) : null,
      os: cols.os !== undefined ? cellText(row[cols.os]) : null,
      concatPeca: cols.concatPeca !== undefined ? cellText(row[cols.concatPeca]) : null,
      chavePeca: chaveRaw,
      chavePecaNorm: chaveNorm,
      referencia: cols.refPeca !== undefined ? cellText(row[cols.refPeca]) : null,
      statusToken: statusRaw ? orderStatusToken(statusRaw) : null,
      statusLabel: orderStatusLabel(statusRaw),
      statusKitToken: statusKitRaw ? orderStatusToken(statusKitRaw) : null,
      prioridadeKit,
      quantidadePecas: cols.qtdePecas !== undefined ? cellInt(row[cols.qtdePecas]) : null,
      idade: cols.idade !== undefined ? cellInt(row[cols.idade]) : null,
      custo: cols.custo !== undefined ? cellNumber(row[cols.custo]) : null,
      venda: cols.venda !== undefined ? cellNumber(row[cols.venda]) : null,
      margem: cols.margem !== undefined ? cellNumber(row[cols.margem]) : null,
      notaIdade: cols.notaIdade !== undefined ? cellInt(row[cols.notaIdade]) : null,
      notaMargem: cols.notaMargem !== undefined ? cellInt(row[cols.notaMargem]) : null,
      score: cols.score !== undefined ? cellInt(row[cols.score]) : null,
      ordemConsumo: cols.ordemConsumo !== undefined ? cellInt(row[cols.ordemConsumo]) : null,
      qtdEstoque: cols.qtdEstoque !== undefined ? cellInt(row[cols.qtdEstoque]) : null,
      pecasSemEstoque: cols.pecasSemEstoque !== undefined ? cellInt(row[cols.pecasSemEstoque]) : null,
      rawJson: buildRawJson(header, row),
    });
  }
  return { records, issues, rowsFound };
}

export function mapInventory(matrix: SheetMatrix, det: SheetDetection, cols: ColumnIndex): MapOutput<InventoryRecord> {
  const issues: ImportIssue[] = [];
  const records: InventoryRecord[] = [];
  const header = det.normalizedHeader;
  const hasQtde = "qtde" in cols;
  const hasId = "idPecaEstoque" in cols;
  const seenIds = new Set<string>();
  // referência normalizada → chaves (normalizada → original) para detectar conflito.
  const refToChaves = new Map<string, Map<string, string>>();
  const refDisplay = new Map<string, string>();
  let rowsFound = 0;
  let unitsWithoutPhysicalId = 0;

  for (const { row, rowNumber } of dataRows(matrix, det)) {
    if (rowIsEmpty(row)) continue;
    rowsFound++;
    const referencia = cols.referencia !== undefined ? cellText(row[cols.referencia]) : null;
    const chaveRaw = cols.chavePeca !== undefined ? cellText(row[cols.chavePeca]) : null;
    if (!referencia && !chaveRaw) continue;

    const idPeca = hasId ? cellText(row[cols.idPecaEstoque]) : null;
    if (hasId) {
      if (idPeca) {
        if (seenIds.has(idPeca)) {
          issues.push({
            fileName: det.fileName, sheetName: det.sheetName, rowNumber,
            entityType: "INVENTORY_ITEM", entityKey: idPeca,
            severity: "ERROR", code: "DUPLICATE_ID_PECA_ESTOQUE",
            message: `ID de peça de estoque duplicado: ${idPeca} (unidade ignorada).`,
            rawValue: idPeca,
          });
          continue;
        }
        seenIds.add(idPeca);
      } else {
        // Coluna existe, mas esta unidade está sem ID físico.
        issues.push({
          fileName: det.fileName, sheetName: det.sheetName, rowNumber,
          entityType: "INVENTORY_ITEM", entityKey: referencia,
          severity: "WARNING", code: "MISSING_ID_PECA_ESTOQUE",
          message: "Unidade de estoque sem ID físico (linha importada como snapshot).",
          rawValue: null,
        });
      }
    }

    if (!referencia) {
      issues.push({
        fileName: det.fileName, sheetName: det.sheetName, rowNumber,
        entityType: "INVENTORY_ITEM", entityKey: chaveRaw,
        severity: "WARNING", code: "REFERENCIA_VAZIA",
        message: "Unidade de estoque sem REFERENCIA.",
        rawValue: null,
      });
    }

    const chaveNorm = normalizeKey(chaveRaw);
    if (!chaveRaw) {
      // Sem CHAVEPECA a unidade não poderá alimentar o match (precisa ser corrigida).
      issues.push({
        fileName: det.fileName, sheetName: det.sheetName, rowNumber,
        entityType: "INVENTORY_ITEM", entityKey: referencia,
        severity: "WARNING", code: "INVENTORY_CHAVEPECA_EMPTY",
        message: "Unidade de estoque sem CHAVEPECA — não alimentará o match enquanto não for corrigida.",
        rawValue: null,
      });
    } else if (referencia) {
      // Mapeia referência → chaves para detectar conflito estrutural.
      const refNorm = normalizeKey(referencia);
      if (!refToChaves.has(refNorm)) {
        refToChaves.set(refNorm, new Map());
        refDisplay.set(refNorm, referencia);
      }
      refToChaves.get(refNorm)!.set(chaveNorm, chaveRaw);
    }

    // Unidades: 1 por linha (bipagem) ou QTDE (contagem consolidada).
    let units = 1;
    if (hasQtde) {
      const q = cellNumber(row[cols.qtde]);
      units = q === null ? 0 : Math.max(0, Math.round(q));
    }

    const base: Omit<InventoryRecord, "rawJson" | "snapshotRow"> = {
      idPecaEstoque: idPeca,
      referencia,
      referenciaNorm: normalizeKey(referencia),
      descricao: cols.descricao !== undefined ? cellText(row[cols.descricao]) : null,
      chavePeca: chaveRaw,
      chavePecaNorm: chaveNorm,
      fornecedor: cols.fornecedor !== undefined ? cellText(row[cols.fornecedor]) : null,
      statusFisico: cols.status !== undefined ? cellText(row[cols.status]) : null,
    };
    const rawJson = buildRawJson(header, row);
    for (let u = 0; u < units; u++) {
      records.push({ ...base, snapshotRow: rowNumber, rawJson });
      if (!hasId) unitsWithoutPhysicalId++;
    }
  }

  // A coluna inteira de ID físico está ausente: um único aviso, com o total.
  if (!hasId && records.length > 0) {
    issues.push({
      fileName: det.fileName, sheetName: det.sheetName, rowNumber: null,
      entityType: "INVENTORY_ITEM", entityKey: null,
      severity: "WARNING", code: "INVENTORY_ID_COLUMN_MISSING",
      message: `Sem coluna de ID físico (IDPEÇA/ID PEÇA/ID_PECA_ESTOQUE): ${unitsWithoutPhysicalId} unidades importadas como snapshot, sem ID permanente.`,
      rawValue: null,
    });
  }

  // Conflito estrutural: mesma referência vinculada a mais de uma CHAVEPECA.
  for (const [refNorm, chaves] of refToChaves) {
    if (chaves.size >= 2) {
      const lista = [...chaves.values()].join(" | ");
      issues.push({
        fileName: det.fileName, sheetName: det.sheetName, rowNumber: null,
        entityType: "INVENTORY_ITEM", entityKey: refDisplay.get(refNorm) ?? refNorm,
        severity: "CONFLICT", code: "REFERENCE_KEY_CONFLICT",
        message: `Referência "${refDisplay.get(refNorm) ?? refNorm}" vinculada a ${chaves.size} CHAVEPECA diferentes: ${lista}.`,
        rawValue: lista,
      });
    }
  }

  return { records, issues, rowsFound };
}

export function mapQuotations(matrix: SheetMatrix, det: SheetDetection, cols: ColumnIndex): MapOutput<QuotationRecord> {
  const issues: ImportIssue[] = [];
  const records: QuotationRecord[] = [];
  const header = det.normalizedHeader;
  let rowsFound = 0;

  for (const { row, rowNumber } of dataRows(matrix, det)) {
    if (rowIsEmpty(row)) continue;
    rowsFound++;
    const chaveRaw = cols.chavePeca !== undefined ? cellText(row[cols.chavePeca]) : null;
    collectFormulaWarnings(
      [
        { field: "VALOR UN", idx: cols.valorUnitario },
        { field: "VALOR TOTAL", idx: cols.valorTotal },
        { field: "QTDE", idx: cols.quantidade },
      ],
      row,
      { fileName: det.fileName, sheetName: det.sheetName, rowNumber, entityKey: chaveRaw },
      "QUOTATION",
      issues,
    );
    records.push({
      idPedido: cols.idPedido !== undefined ? cellText(row[cols.idPedido]) : null,
      chavePeca: chaveRaw,
      chavePecaNorm: normalizeKey(chaveRaw),
      quantidade: cols.quantidade !== undefined ? cellNumber(row[cols.quantidade]) : null,
      valorUnitario: cols.valorUnitario !== undefined ? cellNumber(row[cols.valorUnitario]) : null,
      valorTotal: cols.valorTotal !== undefined ? cellNumber(row[cols.valorTotal]) : null,
      dataCotacao: cols.dataCotacao !== undefined ? cellDateISO(row[cols.dataCotacao]) : null,
      status: cols.status !== undefined ? cellText(row[cols.status]) : null,
      rawJson: buildRawJson(header, row),
    });
  }
  return { records, issues, rowsFound };
}

export function mapAnalysis(matrix: SheetMatrix, det: SheetDetection, cols: ColumnIndex): MapOutput<AnalysisRecord> {
  const issues: ImportIssue[] = [];
  const records: AnalysisRecord[] = [];
  const header = det.normalizedHeader;
  let rowsFound = 0;

  for (const { row } of dataRows(matrix, det)) {
    if (rowIsEmpty(row)) continue;
    rowsFound++;
    const concat = cols.concatPeca !== undefined ? cellText(row[cols.concatPeca]) : null;
    records.push({
      idPedido: cols.idPedido !== undefined ? cellText(row[cols.idPedido]) : null,
      imei: cols.imei !== undefined ? cellText(row[cols.imei]) : null,
      os: cols.os !== undefined ? cellText(row[cols.os]) : null,
      marca: cols.marca !== undefined ? cellText(row[cols.marca]) : null,
      modelo: cols.modelo !== undefined ? cellText(row[cols.modelo]) : null,
      cor: cols.cor !== undefined ? cellText(row[cols.cor]) : null,
      pecaSolicitada: cols.pecaSolicitada !== undefined ? cellText(row[cols.pecaSolicitada]) : null,
      corNaPeca: cols.corNaPeca !== undefined ? cellText(row[cols.corNaPeca]) : null,
      dataPedido: cols.dataPedido !== undefined ? cellDateISO(row[cols.dataPedido]) : null,
      status: cols.status !== undefined ? cellText(row[cols.status]) : null,
      concatPeca: concat,
      chavePecaNorm: normalizeKey(concat),
      deposito: cols.deposito !== undefined ? cellText(row[cols.deposito]) : null,
      descricao: cols.descricao !== undefined ? cellText(row[cols.descricao]) : null,
      ref: cols.ref !== undefined ? cellText(row[cols.ref]) : null,
      solicitante: cols.solicitante !== undefined ? cellText(row[cols.solicitante]) : null,
      rawJson: buildRawJson(header, row),
    });
  }
  return { records, issues, rowsFound };
}

/** Conflitos de status entre a fonte primária e a secundária de pedidos. */
export function detectStatusConflicts(
  primary: OrderPartRecord[],
  secondaryMatrix: SheetMatrix,
  secondaryDet: SheetDetection,
  secondaryCols: ColumnIndex,
  limit = 1000,
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  // A identidade da linha é o ID_PEDIDO (único por solicitação de peça).
  const primaryByPedido = new Map<string, string | null>();
  for (const r of primary) primaryByPedido.set(r.idPedido, r.statusToken);

  for (const { row, rowNumber } of dataRows(secondaryMatrix, secondaryDet)) {
    if (issues.length >= limit) break;
    if (rowIsEmpty(row)) continue;
    const idPedido = cellText(row[secondaryCols.idPedido]);
    if (!idPedido) continue;
    if (!primaryByPedido.has(idPedido)) continue;
    const secStatus = secondaryCols.status !== undefined
      ? orderStatusToken(cellText(row[secondaryCols.status]))
      : null;
    const priStatus = primaryByPedido.get(idPedido) ?? null;
    if (secStatus && priStatus && secStatus !== priStatus) {
      issues.push({
        fileName: secondaryDet.fileName, sheetName: secondaryDet.sheetName, rowNumber,
        entityType: "ORDER_PART", entityKey: idPedido,
        severity: "CONFLICT", code: "STATUS_CONFLICT",
        message: `Status divergente entre arquivos para ${idPedido}: primário="${priStatus}", secundário="${secStatus}".`,
        rawValue: secStatus,
      });
    }
  }
  return issues;
}
