import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";
import { requestMatchRecompute } from "../match/engine-orchestrator.js";
import { getCurrentOperationalStock } from "./stock-service.js";

export interface OperationalReservation {
  id: number;
  partRequestId: number;
  repairCaseId: number;
  chavePeca: string;
  chavePecaNorm: string;
  reference: string | null;
  referenceNorm: string | null;
  quantity: number;
  status: "ACTIVE" | "RELEASED" | "CONSUMED";
  cancelReason: string | null;
  cancelReasonCode: string | null;
  createdByUserId: number | null;
  createdAt: string;
  releasedAt: string | null;
  releasedByUserId: number | null;
  consumedAt: string | null;
  stockMovementId: number | null;
}

export class ReservationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReservationError";
  }
}

function toReservation(r: Record<string, unknown>): OperationalReservation {
  return {
    id: r.id as number,
    partRequestId: r.part_request_id as number,
    repairCaseId: r.repair_case_id as number,
    chavePeca: r.chave_peca as string,
    chavePecaNorm: r.chave_peca_norm as string,
    reference: r.reference as string | null,
    referenceNorm: r.reference_norm as string | null,
    quantity: r.quantity as number,
    status: r.status as "ACTIVE" | "RELEASED" | "CONSUMED",
    cancelReason: r.cancel_reason as string | null,
    cancelReasonCode: r.cancel_reason_code as string | null,
    createdByUserId: r.created_by_user_id as number | null,
    createdAt: r.created_at as string,
    releasedAt: r.released_at as string | null,
    releasedByUserId: r.released_by_user_id as number | null,
    consumedAt: r.consumed_at as string | null,
    stockMovementId: r.stock_movement_id as number | null,
  };
}

export function getReservationByPartRequest(db: Db, partRequestId: number): OperationalReservation | null {
  const row = db.prepare(
    "SELECT * FROM operational_reservations WHERE part_request_id = ? AND status = 'ACTIVE'"
  ).get(partRequestId) as Record<string, unknown> | undefined;
  return row ? toReservation(row) : null;
}

export function listReservationsByCase(db: Db, repairCaseId: number): OperationalReservation[] {
  const rows = db.prepare(
    "SELECT * FROM operational_reservations WHERE repair_case_id = ? ORDER BY created_at"
  ).all(repairCaseId) as Record<string, unknown>[];
  return rows.map(toReservation);
}

export function listActiveReservationsByChave(db: Db, chavePecaNorm: string): OperationalReservation[] {
  const rows = db.prepare(
    "SELECT * FROM operational_reservations WHERE chave_peca_norm = ? AND status = 'ACTIVE'"
  ).all(chavePecaNorm) as Record<string, unknown>[];
  return rows.map(toReservation);
}

/** Total quantity reserved (ACTIVE) for a given chavePecaNorm. */
export function getReservedQuantity(db: Db, chavePecaNorm: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS qty
    FROM operational_reservations
    WHERE chave_peca_norm = ? AND status = 'ACTIVE'
  `).get(chavePecaNorm) as { qty: number };
  return row.qty;
}

/**
 * Create reservations for a full kit (all part_requests of a repair_case) atomically.
 * Aborts if available stock changes between estimation and commit.
 */
export function reserveKit(
  db: Db,
  repairCaseId: number,
  parts: Array<{
    partRequestId: number;
    chavePeca: string;
    reference: string | null;
    quantity: number;
    availableQty: number;
  }>,
  userId: number | null,
): OperationalReservation[] {
  if (parts.length === 0) throw new ReservationError("NO_PARTS", "Nenhuma peça para reservar.");

  db.exec("BEGIN");
  try {
    const created: OperationalReservation[] = [];

    for (const p of parts) {
      const chavePecaNorm = normalizeKey(p.chavePeca);

      // Check no active reservation for this part_request
      const existing = db.prepare(
        "SELECT id FROM operational_reservations WHERE part_request_id = ? AND status = 'ACTIVE'"
      ).get(p.partRequestId);
      if (existing) throw new ReservationError("ALREADY_RESERVED", `part_request ${p.partRequestId} já tem reserva ativa.`);

      // Re-read available stock inside transaction to detect race conditions
      const currentReserved = (db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS qty
        FROM operational_reservations
        WHERE chave_peca_norm = ? AND status = 'ACTIVE'
      `).get(chavePecaNorm) as { qty: number }).qty;

      const currentPhysical = getPhysicalStock(db, chavePecaNorm);
      const currentAvailable = currentPhysical - currentReserved;

      if (currentAvailable < p.quantity) {
        throw new ReservationError(
          "STOCK_CHANGED",
          `Saldo de ${p.chavePeca} mudou entre a estimativa e a confirmação. Disponível: ${currentAvailable}, necessário: ${p.quantity}. Execute o Match novamente.`,
        );
      }

      const referenceNorm = p.reference ? normalizeKey(p.reference) : null;

      const res = db.prepare(`
        INSERT INTO operational_reservations
          (part_request_id, repair_case_id, chave_peca, chave_peca_norm, reference, reference_norm, quantity, created_by_user_id)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(p.partRequestId, repairCaseId, p.chavePeca, chavePecaNorm, p.reference ?? null, referenceNorm, p.quantity, userId ?? null);

      // Update part_request status to RESERVADA
      db.prepare(
        "UPDATE part_requests SET status = 'RESERVADA', allocated_reference = ?, allocated_reference_norm = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(p.reference ?? null, referenceNorm, p.partRequestId);

      const row = db.prepare("SELECT * FROM operational_reservations WHERE id = ?").get(res.lastInsertRowid as number) as Record<string, unknown>;
      created.push(toReservation(row));
    }

    // Update repair_case to APTO_REPARO (todas as peças reservadas via motor)
    db.prepare(
      "UPDATE repair_cases SET workflow_status = 'APTO_REPARO', updated_at = datetime('now'), updated_by_user_id = ? WHERE id = ?"
    ).run(userId ?? null, repairCaseId);

    db.exec("COMMIT");

    requestMatchRecompute(db, "KIT_RESERVED", "repair_case", repairCaseId);
    return created;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Reserve only the available parts (partial kit).
 */
export function reservePartial(
  db: Db,
  repairCaseId: number,
  parts: Array<{
    partRequestId: number;
    chavePeca: string;
    reference: string | null;
    quantity: number;
  }>,
  userId: number | null,
): OperationalReservation[] {
  if (parts.length === 0) throw new ReservationError("NO_PARTS", "Nenhuma peça para reservar.");

  db.exec("BEGIN");
  try {
    const created: OperationalReservation[] = [];

    for (const p of parts) {
      const chavePecaNorm = normalizeKey(p.chavePeca);
      const existing = db.prepare(
        "SELECT id FROM operational_reservations WHERE part_request_id = ? AND status = 'ACTIVE'"
      ).get(p.partRequestId);
      if (existing) continue; // already reserved — skip

      const currentReserved = (db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS qty FROM operational_reservations WHERE chave_peca_norm = ? AND status = 'ACTIVE'
      `).get(chavePecaNorm) as { qty: number }).qty;
      const currentPhysical = getPhysicalStock(db, chavePecaNorm);
      const currentAvailable = currentPhysical - currentReserved;

      if (currentAvailable < p.quantity) continue; // skip parts no longer available

      const referenceNorm = p.reference ? normalizeKey(p.reference) : null;
      const res = db.prepare(`
        INSERT INTO operational_reservations
          (part_request_id, repair_case_id, chave_peca, chave_peca_norm, reference, reference_norm, quantity, created_by_user_id)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(p.partRequestId, repairCaseId, p.chavePeca, chavePecaNorm, p.reference ?? null, referenceNorm, p.quantity, userId ?? null);

      db.prepare(
        "UPDATE part_requests SET status = 'RESERVADA', allocated_reference = ?, allocated_reference_norm = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(p.reference ?? null, referenceNorm, p.partRequestId);

      const row = db.prepare("SELECT * FROM operational_reservations WHERE id = ?").get(res.lastInsertRowid as number) as Record<string, unknown>;
      created.push(toReservation(row));
    }

    db.exec("COMMIT");
    requestMatchRecompute(db, "PARTIAL_RESERVATION", "repair_case", repairCaseId);
    return created;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Release (cancel) an active reservation.
 * reason must be provided.
 */
export function releaseReservation(
  db: Db,
  partRequestId: number,
  params: { reason: string; reasonCode?: string; userId: number | null },
): void {
  if (!params.reason || params.reason.trim().length < 3) {
    throw new ReservationError("REASON_REQUIRED", "Motivo de cancelamento obrigatório (mínimo 3 caracteres).");
  }

  const row = db.prepare(
    "SELECT * FROM operational_reservations WHERE part_request_id = ? AND status = 'ACTIVE'"
  ).get(partRequestId) as Record<string, unknown> | undefined;

  if (!row) throw new ReservationError("NOT_FOUND", "Reserva ativa não encontrada para esta peça.");

  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE operational_reservations SET
        status = 'RELEASED', cancel_reason = ?, cancel_reason_code = ?,
        released_at = datetime('now'), released_by_user_id = ?
      WHERE id = ?
    `).run(params.reason.trim(), params.reasonCode ?? null, params.userId ?? null, row.id as number);

    // Revert part_request status
    db.prepare(
      "UPDATE part_requests SET status = 'PEDIR_PECA', allocated_reference = NULL, allocated_reference_norm = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(partRequestId);

    // Check if repair_case should revert from EM_SEPARACAO
    const repairCaseId = row.repair_case_id as number;
    const remaining = (db.prepare(
      "SELECT COUNT(*) AS c FROM operational_reservations WHERE repair_case_id = ? AND status = 'ACTIVE'"
    ).get(repairCaseId) as { c: number }).c;

    if (remaining === 0) {
      db.prepare(
        "UPDATE repair_cases SET workflow_status = 'MATCH_PARCIAL', updated_at = datetime('now') WHERE id = ? AND workflow_status IN ('EM_SEPARACAO','APTO_REPARO','MATCH')"
      ).run(repairCaseId);
    }

    db.exec("COMMIT");
    requestMatchRecompute(db, "RESERVATION_RELEASED", "repair_case", repairCaseId);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Consume a reservation (part physically used in repair).
 * Creates a REPAIR_CONSUMPTION stock_movement.
 */
export function consumeReservation(
  db: Db,
  reservationId: number,
  userId: number | null,
): void {
  const row = db.prepare(
    "SELECT * FROM operational_reservations WHERE id = ? AND status = 'ACTIVE'"
  ).get(reservationId) as Record<string, unknown> | undefined;
  if (!row) throw new ReservationError("NOT_FOUND", "Reserva ativa não encontrada.");

  db.exec("BEGIN");
  try {
    // Create REPAIR_CONSUMPTION movement
    const moveRes = db.prepare(`
      INSERT INTO stock_movements
        (movement_type, chave_peca, chave_peca_norm, referencia, referencia_norm, quantity,
         source_type, source_id, reservation_id, created_by_user_id)
      VALUES ('REPAIR_CONSUMPTION',?,?,?,?,-1,'operational_reservation',?,?,?)
    `).run(
      row.chave_peca as string,
      row.chave_peca_norm as string,
      (row.reference as string | null) ?? "",
      (row.reference_norm as string | null) ?? "",
      row.id as number,
      row.id as number,
      userId ?? null,
    );

    db.prepare(`
      UPDATE operational_reservations SET
        status = 'CONSUMED', consumed_at = datetime('now'), consumed_by_user_id = ?, stock_movement_id = ?
      WHERE id = ?
    `).run(userId ?? null, moveRes.lastInsertRowid as number, row.id as number);

    db.prepare(
      "UPDATE part_requests SET status = 'SEPARADA', updated_at = datetime('now') WHERE id = ?"
    ).run(row.part_request_id as number);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Reserva kit completo guiado pelo último resultado do motor (backend-driven).
 * O frontend envia apenas o repairCaseId (URL). Peças, referências e quantidades
 * são determinadas pelo servidor — nunca pelo cliente.
 */
export function reserveKitFromEngine(
  db: Db,
  repairCaseId: number,
  userId: number | null,
): OperationalReservation[] {
  const rc = db.prepare("SELECT * FROM repair_cases WHERE id = ?").get(repairCaseId) as Record<string, unknown> | undefined;
  if (!rc) throw new ReservationError("NOT_FOUND", "Caso de reparo não encontrado.");
  if (rc.workflow_status !== "MATCH") {
    throw new ReservationError(
      "INVALID_STATUS",
      `Apenas casos com status MATCH podem ser reservados via motor (atual: ${rc.workflow_status}).`,
    );
  }

  // Peças ativas ainda não reservadas/separadas
  const pendingParts = db.prepare(`
    SELECT id, chave_peca, chave_peca_norm
    FROM part_requests
    WHERE repair_case_id = ? AND cancelled_at IS NULL
      AND status NOT IN ('CANCELADA','SEPARADA','CONSUMIDA','RESERVADA')
  `).all(repairCaseId) as { id: number; chave_peca: string; chave_peca_norm: string }[];

  if (pendingParts.length === 0) {
    throw new ReservationError("NO_PARTS", "Nenhuma peça pendente de reserva.");
  }

  // Última execução do motor para este caso
  const matchResults = db.prepare(`
    SELECT part_request_id, allocated_reference, allocated_reference_norm, result_status
    FROM repair_match_results
    WHERE repair_case_id = ?
      AND run_id = (SELECT MAX(run_id) FROM repair_match_results WHERE repair_case_id = ?)
      AND result_status = 'MATCH'
  `).all(repairCaseId, repairCaseId) as {
    part_request_id: number;
    allocated_reference: string | null;
    allocated_reference_norm: string | null;
    result_status: string;
  }[];

  if (matchResults.length === 0) {
    throw new ReservationError("NO_MATCH", "Nenhum resultado MATCH encontrado. Execute o motor antes de reservar.");
  }

  const matchByPartId = new Map(matchResults.map(r => [r.part_request_id, r]));

  // Toda peça pendente deve ter resultado MATCH
  for (const p of pendingParts) {
    const m = matchByPartId.get(p.id);
    if (!m) {
      throw new ReservationError(
        "INCOMPLETE_MATCH",
        `Peça ${p.id} (${p.chave_peca}) sem resultado MATCH no motor. Execute o motor e tente novamente.`,
      );
    }
    if (!m.allocated_reference_norm) {
      throw new ReservationError(
        "NO_REFERENCE",
        `Peça ${p.id} (${p.chave_peca}) não tem referência alocada. Execute o motor e tente novamente.`,
      );
    }
  }

  // Verificação prévia de estoque por (chave, ref)
  const { groups } = getCurrentOperationalStock(db);
  const availMap = new Map<string, number>(); // `chaveNorm||refNorm` → qty
  for (const g of groups) {
    if (!g.chavePecaNorm) continue;
    const k = `${g.chavePecaNorm}||${g.referenciaNorm || ""}`;
    availMap.set(k, (availMap.get(k) ?? 0) + g.availableQuantity);
  }

  for (const p of pendingParts) {
    const m = matchByPartId.get(p.id)!;
    const k = `${p.chave_peca_norm}||${m.allocated_reference_norm}`;
    if ((availMap.get(k) ?? 0) < 1) {
      throw new ReservationError(
        "STOCK_CHANGED",
        `Estoque de ${p.chave_peca} / ref ${m.allocated_reference} insuficiente. Execute o motor novamente.`,
      );
    }
  }

  // Transação atômica
  db.exec("BEGIN");
  try {
    const created: OperationalReservation[] = [];

    for (const p of pendingParts) {
      const m = matchByPartId.get(p.id)!;
      const referenceNorm = m.allocated_reference_norm!;

      const existing = db.prepare(
        "SELECT id FROM operational_reservations WHERE part_request_id = ? AND status = 'ACTIVE'"
      ).get(p.id);
      if (existing) throw new ReservationError("ALREADY_RESERVED", `Peça ${p.id} já tem reserva ativa.`);

      // Re-verifica dentro da tx por (chave, ref)
      const reservedInTx = (db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS qty
        FROM operational_reservations
        WHERE chave_peca_norm = ? AND COALESCE(reference_norm,'') = ? AND status = 'ACTIVE'
      `).get(p.chave_peca_norm, referenceNorm) as { qty: number }).qty;

      const physicalInTx = getPhysicalStockByRef(db, p.chave_peca_norm, referenceNorm);
      if (physicalInTx - reservedInTx < 1) {
        throw new ReservationError(
          "STOCK_CHANGED",
          `Saldo de ${p.chave_peca} / ref ${m.allocated_reference} mudou durante a reserva. Reexecute o motor.`,
        );
      }

      const res = db.prepare(`
        INSERT INTO operational_reservations
          (part_request_id, repair_case_id, chave_peca, chave_peca_norm,
           reference, reference_norm, quantity, created_by_user_id)
        VALUES (?,?,?,?,?,?,1,?)
      `).run(p.id, repairCaseId, p.chave_peca, p.chave_peca_norm, m.allocated_reference, referenceNorm, userId ?? null);

      db.prepare(
        "UPDATE part_requests SET status = 'RESERVADA', allocated_reference = ?, allocated_reference_norm = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(m.allocated_reference, referenceNorm, p.id);

      const row = db.prepare("SELECT * FROM operational_reservations WHERE id = ?").get(res.lastInsertRowid as number) as Record<string, unknown>;
      created.push(toReservation(row));
    }

    db.prepare(
      "UPDATE repair_cases SET workflow_status = 'APTO_REPARO', updated_at = datetime('now'), updated_by_user_id = ? WHERE id = ?"
    ).run(userId ?? null, repairCaseId);

    db.exec("COMMIT");
    requestMatchRecompute(db, "KIT_RESERVED", "repair_case", repairCaseId);
    return created;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Direciona caso para técnico — exige APTO_REPARO com todas as peças tratadas. */
export function directToTechnician(
  db: Db,
  repairCaseId: number,
  params: { technicianId: number; userId: number | null; notes?: string | null },
): void {
  const rc = db.prepare("SELECT * FROM repair_cases WHERE id = ?").get(repairCaseId) as Record<string, unknown> | undefined;
  if (!rc) throw new ReservationError("NOT_FOUND", "Caso não encontrado.");

  if (rc.workflow_status !== "APTO_REPARO") {
    throw new ReservationError("INVALID_STATUS", `Caso deve estar em APTO_REPARO para direcionar ao técnico (atual: ${rc.workflow_status}).`);
  }

  // Valida técnico
  const tech = db.prepare("SELECT id, active, type FROM staff_members WHERE id = ?").get(params.technicianId) as { id: number; active: number; type: string } | undefined;
  if (!tech) throw new ReservationError("TECH_NOT_FOUND", "Técnico não encontrado.");
  if (!tech.active) throw new ReservationError("TECH_INACTIVE", "Técnico está inativo.");
  if (tech.type !== "TECHNICIAN") throw new ReservationError("TECH_INVALID_TYPE", "Colaborador não é um técnico.");

  // Conta peças ativas (não canceladas)
  const totalActiveParts = (db.prepare(
    "SELECT COUNT(*) AS c FROM part_requests WHERE repair_case_id = ? AND cancelled_at IS NULL AND status != 'CANCELADA'"
  ).get(repairCaseId) as { c: number }).c;

  // Peças tratadas: RESERVADA (novo fluxo) + SEPARADA/CONSUMIDA (legado — já fisicamente separadas)
  const handledParts = (db.prepare(
    "SELECT COUNT(*) AS c FROM part_requests WHERE repair_case_id = ? AND cancelled_at IS NULL AND status IN ('RESERVADA','SEPARADA','CONSUMIDA')"
  ).get(repairCaseId) as { c: number }).c;

  if (totalActiveParts > 0 && handledParts < totalActiveParts) {
    throw new ReservationError(
      "PARTS_NOT_RESERVED",
      `Ainda há peças pendentes (${totalActiveParts - handledParts} sem reserva/separação).`,
    );
  }

  db.prepare(`
    UPDATE repair_cases SET
      workflow_status = 'DIRECIONADO_TECNICO',
      directed_technician_id = ?,
      directed_at = datetime('now'),
      directed_by_user_id = ?,
      notes = COALESCE(?, notes),
      updated_at = datetime('now'),
      updated_by_user_id = ?
    WHERE id = ?
  `).run(params.technicianId, params.userId ?? null, params.notes ?? null, params.userId ?? null, repairCaseId);

  requestMatchRecompute(db, "DIRECTED_TO_TECHNICIAN", "repair_case", repairCaseId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getPhysicalStock(db: Db, chavePecaNorm: string): number {
  const { groups } = getCurrentOperationalStock(db);
  let total = 0;
  for (const g of groups) {
    if (g.chavePecaNorm === chavePecaNorm) {
      total += g.currentQuantity; // physical (antes de reservas)
    }
  }
  return total;
}

function getPhysicalStockByRef(db: Db, chavePecaNorm: string, referenceNorm: string | null): number {
  const { groups } = getCurrentOperationalStock(db);
  const refNormToMatch = referenceNorm || "";
  for (const g of groups) {
    if (g.chavePecaNorm === chavePecaNorm && (g.referenciaNorm || "") === refNormToMatch) {
      return g.currentQuantity;
    }
  }
  return 0;
}
