/**
 * Vínculo idempotente entre part_request e purchase_request.
 * Uma solicitação ativa por part_request — chamadas repetidas são no-op.
 */

import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";

export class PurchaseRequestLinkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "PurchaseRequestLinkError";
  }
}

export interface EnsureResult {
  purchaseRequestId: number;
  created: boolean;
  alreadyExisted: boolean;
}

/**
 * Garante que existe exatamente uma purchase_request ativa para a part_request indicada.
 * Idempotente: se já existir (e não cancelada), retorna a existente sem criar outra.
 * Solicitação cancelada pode ser recriada apenas via chamada explícita a esta função.
 */
export function ensurePurchaseRequestForPart(
  db: Db,
  partRequestId: number,
  createdByUserId: number | null = null,
): EnsureResult {
  const part = db.prepare(
    `SELECT pr.id, pr.chave_peca, pr.chave_peca_norm, pr.description, pr.status,
            pr.repair_case_id
     FROM part_requests pr WHERE pr.id = ?`,
  ).get(partRequestId) as {
    id: number;
    chave_peca: string | null;
    chave_peca_norm: string | null;
    description: string | null;
    status: string;
    repair_case_id: number;
  } | undefined;

  if (!part) throw new PurchaseRequestLinkError("NOT_FOUND", `Solicitação de peça ${partRequestId} não encontrada.`, 404);
  if (part.status === "CANCELADA") throw new PurchaseRequestLinkError("PART_CANCELLED", "Solicitação de peça cancelada.", 409);

  // Verificar se já existe purchase_request ativa para esta part_request
  const existing = db.prepare(
    `SELECT id, status FROM purchase_requests WHERE part_request_id = ? AND status NOT IN ('CANCELADO','CANCELADA') LIMIT 1`,
  ).get(partRequestId) as { id: number; status: string } | undefined;

  if (existing) {
    return { purchaseRequestId: existing.id, created: false, alreadyExisted: true };
  }

  // Determinar referência e chave
  const referencia = part.chave_peca ?? `PART-${partRequestId}`;
  const chavePeca = part.chave_peca_norm ? normalizeKey(part.chave_peca_norm) : null;

  // Criar nova purchase_request
  const insertRow = db.prepare(
    `INSERT INTO purchase_requests
       (source, referencia, chave_peca, descricao, status, part_request_id, created_at, updated_at)
     VALUES ('PART_REQUEST', ?, ?, ?, 'APROVADO', ?, datetime('now'), datetime('now'))`,
  ).run(referencia, chavePeca, part.description, partRequestId);

  const purchaseRequestId = Number(insertRow.lastInsertRowid);
  void createdByUserId;

  return { purchaseRequestId, created: true, alreadyExisted: false };
}

/**
 * Cria purchase_requests para todas as part_requests de um repair_case que
 * estejam no status PEDIR_PECA e ainda não tenham vínculo ativo.
 */
export function ensurePurchaseRequestsForCase(
  db: Db,
  repairCaseId: number,
  createdByUserId: number | null = null,
): { results: EnsureResult[]; partIds: number[] } {
  const parts = db.prepare(
    `SELECT id FROM part_requests
     WHERE repair_case_id = ? AND status = 'PEDIR_PECA' AND cancelled_at IS NULL`,
  ).all(repairCaseId) as { id: number }[];

  const results: EnsureResult[] = [];
  const partIds: number[] = [];

  db.prepare("BEGIN").run();
  try {
    for (const p of parts) {
      const r = ensurePurchaseRequestForPart(db, p.id, createdByUserId);
      results.push(r);
      partIds.push(p.id);
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return { results, partIds };
}
