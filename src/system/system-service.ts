import type { Db } from "../db/database.js";
import { isApprovedQuotationStatus, normalizeQuotationStatus } from "../domain/procurement.js";

export interface SystemStateRow {
  id: number;
  initialized: number;
  initial_import_batch_id: number | null;
  initialized_at: string | null;
  initialized_by: string | null;
  operational_started_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Estado global único (linha id=1, criada na migration 005). */
export function getSystemState(db: Db): SystemStateRow {
  const row = db.prepare("SELECT * FROM system_state WHERE id = 1").get() as unknown as SystemStateRow | undefined;
  if (!row) {
    // Garante a existência da linha única mesmo em bancos parcialmente migrados.
    db.prepare("INSERT OR IGNORE INTO system_state (id, initialized) VALUES (1, 0)").run();
    return db.prepare("SELECT * FROM system_state WHERE id = 1").get() as unknown as SystemStateRow;
  }
  return row;
}

export function isInitialized(db: Db): boolean {
  return getSystemState(db).initialized === 1;
}

/** Reimportação só é permitida em dev/teste, via ALLOW_LEGACY_REIMPORT=true. */
export function allowLegacyReimport(): boolean {
  return process.env.ALLOW_LEGACY_REIMPORT === "true";
}

export interface InitializationResult {
  initialized: boolean;
  approvedRequestsCreated: number;
  quotationStatusCounts: Record<string, number>;
}

/**
 * Inicializa o sistema a partir de um lote recém-importado. Idempotente: se já
 * inicializado, não faz nada. NÃO abre transação própria — é chamada DENTRO da
 * transação de confirmação da importação (confirm()).
 *
 *  - marca system_state como inicializado, fixando o lote inicial;
 *  - cria as solicitações de compra APROVADAS a partir de source_quotations
 *    aprovadas do lote (uma por cotação; sem duplicar — UNIQUE source_quotation_id).
 */
export function initializeSystem(db: Db, batchId: number, initializedBy: string | null): InitializationResult {
  const state = getSystemState(db);
  if (state.initialized === 1) {
    return { initialized: false, approvedRequestsCreated: 0, quotationStatusCounts: {} };
  }

  const quotations = db
    .prepare(
      `SELECT id, id_pedido, chave_peca, chave_peca_norm, quantidade, valor_unitario, valor_total, status
       FROM source_quotations WHERE import_batch_id = ?`,
    )
    .all(batchId) as {
    id: number;
    id_pedido: string | null;
    chave_peca: string | null;
    chave_peca_norm: string | null;
    quantidade: number | null;
    valor_unitario: number | null;
    valor_total: number | null;
    status: string | null;
  }[];

  const quotationStatusCounts: Record<string, number> = {};
  const insert = db.prepare(
    `INSERT OR IGNORE INTO purchase_requests
      (source_quotation_id, import_batch_id, id_pedido, chave_peca, chave_peca_norm,
       quantidade, valor_unitario, valor_total, origin_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')`,
  );

  let approvedRequestsCreated = 0;
  for (const qt of quotations) {
    const norm = normalizeQuotationStatus(qt.status) || "(vazio)";
    quotationStatusCounts[norm] = (quotationStatusCounts[norm] ?? 0) + 1;
    if (!isApprovedQuotationStatus(qt.status)) continue;
    const r = insert.run(
      qt.id,
      batchId,
      qt.id_pedido,
      qt.chave_peca,
      qt.chave_peca_norm,
      qt.quantidade,
      qt.valor_unitario,
      qt.valor_total,
      normalizeQuotationStatus(qt.status),
    );
    approvedRequestsCreated += Number(r.changes);
  }

  db.prepare(
    `UPDATE system_state
     SET initialized = 1, initial_import_batch_id = ?, initialized_at = datetime('now'),
         initialized_by = ?, operational_started_at = datetime('now'), updated_at = datetime('now')
     WHERE id = 1`,
  ).run(batchId, initializedBy);

  return { initialized: true, approvedRequestsCreated, quotationStatusCounts };
}
