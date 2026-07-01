import type { Db } from "./database.js";
import type { BatchStatus, ImportIssue } from "../shared/types.js";
import type {
  AnalysisRecord,
  InventoryRecord,
  OrderPartRecord,
  QuotationRecord,
} from "../import/mappers.js";

export interface BatchRow {
  id: number;
  analysis_file_name: string;
  orders_file_name: string;
  analysis_file_hash: string;
  orders_file_hash: string;
  status: BatchStatus;
  started_at: string;
  finished_at: string | null;
  orders_found: number;
  orders_imported: number;
  inventory_found: number;
  inventory_imported: number;
  quotations_found: number;
  quotations_imported: number;
  analysis_found: number;
  analysis_imported: number;
  warnings_count: number;
  errors_count: number;
  conflicts_count: number;
}

export function createPreviewBatch(
  db: Db,
  p: { analysisFileName: string; ordersFileName: string; analysisHash: string; ordersHash: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO import_batches
        (analysis_file_name, orders_file_name, analysis_file_hash, orders_file_hash, status)
       VALUES (?, ?, ?, ?, 'PREVIEW')`,
    )
    .run(p.analysisFileName, p.ordersFileName, p.analysisHash, p.ordersHash);
  return Number(r.lastInsertRowid);
}

export function getBatch(db: Db, id: number): BatchRow | null {
  return (db.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as unknown as BatchRow) ?? null;
}

export function findCompletedBatchByHashes(
  db: Db,
  ordersHash: string,
  analysisHash: string,
): BatchRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM import_batches
         WHERE orders_file_hash = ? AND analysis_file_hash = ?
           AND status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(ordersHash, analysisHash) as unknown as BatchRow) ?? null
  );
}

export function getActiveBatch(db: Db): BatchRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM import_batches
         WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as unknown as BatchRow) ?? null
  );
}

export function deleteBatch(db: Db, id: number): void {
  db.prepare("DELETE FROM import_batches WHERE id = ?").run(id);
}

export function updateBatchOnComplete(
  db: Db,
  id: number,
  data: {
    status: BatchStatus;
    ordersFound: number;
    ordersImported: number;
    inventoryFound: number;
    inventoryImported: number;
    quotationsFound: number;
    quotationsImported: number;
    analysisFound: number;
    analysisImported: number;
    warningsCount: number;
    errorsCount: number;
    conflictsCount: number;
  },
): void {
  db.prepare(
    `UPDATE import_batches SET
       status = ?, finished_at = datetime('now'),
       orders_found = ?, orders_imported = ?,
       inventory_found = ?, inventory_imported = ?,
       quotations_found = ?, quotations_imported = ?,
       analysis_found = ?, analysis_imported = ?,
       warnings_count = ?, errors_count = ?, conflicts_count = ?
     WHERE id = ?`,
  ).run(
    data.status,
    data.ordersFound, data.ordersImported,
    data.inventoryFound, data.inventoryImported,
    data.quotationsFound, data.quotationsImported,
    data.analysisFound, data.analysisImported,
    data.warningsCount, data.errorsCount, data.conflictsCount,
    id,
  );
}

export function insertIssues(db: Db, batchId: number, issues: ImportIssue[]): void {
  if (issues.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO import_issues
      (import_batch_id, file_name, sheet_name, row_number, entity_type, entity_key, severity, code, message, raw_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const i of issues) {
    stmt.run(
      batchId, i.fileName, i.sheetName, i.rowNumber, i.entityType,
      i.entityKey, i.severity, i.code, i.message, i.rawValue,
    );
  }
}

export function insertOrderParts(db: Db, batchId: number, records: OrderPartRecord[]): number {
  const stmt = db.prepare(
    `INSERT INTO source_order_parts
      (import_batch_id, id_pedido, imei, os, concat_peca, chave_peca, chave_peca_norm, referencia,
       status_atual_legado, status_atual_label, status_kit_legado, prioridade_kit_legado,
       quantidade_pecas_aparelho, idade, custo, venda, margem_legada,
       nota_idade_legada, nota_margem_legada, score_legado, ordem_consumo_legada,
       quantidade_estoque_legada, pecas_sem_estoque_legada, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const r of records) {
    stmt.run(
      batchId, r.idPedido, r.imei, r.os, r.concatPeca, r.chavePeca, r.chavePecaNorm, r.referencia,
      r.statusToken, r.statusLabel, r.statusKitToken, r.prioridadeKit,
      r.quantidadePecas, r.idade, r.custo, r.venda, r.margem,
      r.notaIdade, r.notaMargem, r.score, r.ordemConsumo,
      r.qtdEstoque, r.pecasSemEstoque, r.rawJson,
    );
    n++;
  }
  return n;
}

export function insertInventory(db: Db, batchId: number, records: InventoryRecord[]): number {
  const stmt = db.prepare(
    `INSERT INTO source_inventory_items
      (import_batch_id, id_peca_estoque, referencia, referencia_norm, descricao,
       chave_peca, chave_peca_norm, fornecedor, status_fisico, snapshot_row, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const r of records) {
    stmt.run(
      batchId, r.idPecaEstoque, r.referencia, r.referenciaNorm, r.descricao,
      r.chavePeca, r.chavePecaNorm, r.fornecedor, r.statusFisico, r.snapshotRow, r.rawJson,
    );
    n++;
  }
  return n;
}

export function insertQuotations(db: Db, batchId: number, records: QuotationRecord[]): number {
  const stmt = db.prepare(
    `INSERT INTO source_quotations
      (import_batch_id, id_pedido, chave_peca, chave_peca_norm, quantidade,
       valor_unitario, valor_total, data_cotacao, status, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const r of records) {
    stmt.run(
      batchId, r.idPedido, r.chavePeca, r.chavePecaNorm, r.quantidade,
      r.valorUnitario, r.valorTotal, r.dataCotacao, r.status, r.rawJson,
    );
    n++;
  }
  return n;
}

export function insertAnalysis(db: Db, batchId: number, records: AnalysisRecord[]): number {
  const stmt = db.prepare(
    `INSERT INTO source_order_analysis
      (import_batch_id, id_pedido, imei, os, marca, modelo, cor, peca_solicitada, cor_na_peca,
       data_pedido, status, concat_peca, chave_peca_norm, deposito, descricao, ref, solicitante, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const r of records) {
    stmt.run(
      batchId, r.idPedido, r.imei, r.os, r.marca, r.modelo, r.cor, r.pecaSolicitada, r.corNaPeca,
      r.dataPedido, r.status, r.concatPeca, r.chavePecaNorm, r.deposito, r.descricao, r.ref, r.solicitante, r.rawJson,
    );
    n++;
  }
  return n;
}

export function listIssues(db: Db, batchId: number): ImportIssue[] {
  const rows = db
    .prepare(
      `SELECT file_name, sheet_name, row_number, entity_type, entity_key, severity, code, message, raw_value
       FROM import_issues WHERE import_batch_id = ? ORDER BY id`,
    )
    .all(batchId) as Record<string, unknown>[];
  return rows.map((r) => ({
    fileName: r.file_name as string,
    sheetName: (r.sheet_name as string) ?? null,
    rowNumber: (r.row_number as number) ?? null,
    entityType: (r.entity_type as ImportIssue["entityType"]) ?? null,
    entityKey: (r.entity_key as string) ?? null,
    severity: r.severity as ImportIssue["severity"],
    code: r.code as string,
    message: r.message as string,
    rawValue: (r.raw_value as string) ?? null,
  }));
}

export function issueSummary(db: Db, batchId: number): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT severity || ':' || code AS k, COUNT(*) AS c
       FROM import_issues WHERE import_batch_id = ? GROUP BY k ORDER BY c DESC`,
    )
    .all(batchId) as { k: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k] = r.c;
  return out;
}

/** Conta linhas operacionais (eventos) — usado para garantir preservação. */
export function countOperationalEvents(db: Db): number {
  const r = db.prepare("SELECT COUNT(*) AS c FROM operational_events").get() as { c: number };
  return r.c;
}
