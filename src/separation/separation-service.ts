/**
 * Serviço de separação operacional.
 * Regras, transações e integridade. Sem SQL direto — usa o repositório.
 */

import type { Db } from "../db/database.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";
import { isRunStale } from "../match/match-service.js";
import { getMatchRun } from "../match/match-repository.js";
import {
  generateBatchNumber,
  insertSeparationBatch,
  insertSeparationItem,
  getSeparationBatch,
  getSeparationBatchByIdempotencyKey,
  getSeparationItem,
  getItemsByBatch,
  getReservedItemsByDevice,
  getItemsByDevice,
  confirmSeparationItem,
  cancelSeparationItem,
  recalculateAndPersistBatchStatus,
  getBatchTotals,
  listSeparationBatches,
  getActiveReservedIdPedidos,
} from "./separation-repository.js";
import type {
  CreateSeparationBatchInput,
  ConfirmItemInput,
  ConfirmDeviceInput,
  ConfirmAllInput,
  CancelItemInput,
  CancelDeviceInput,
  CancelBatchInput,
  SeparationBatchRow,
  SeparationItemRow,
  SeparationBatchState,
  DeviceSeparationGroup,
  ListSeparationBatchesParams,
} from "./separation-types.js";

export class SeparationError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SeparationError";
  }
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

interface MatchResultDbRow {
  id: number;
  match_run_id: number;
  source_order_part_id: number;
  device_result_id: number | null;
  id_pedido: string;
  imei: string | null;
  os: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  allocated_reference: string | null;
  allocated_reference_norm: string | null;
  result_status: string | null;
  allocation_phase: string | null;
  reserved_units: number;
  ordem_consumo: number | null;
  effective_status_before: string | null;
}

interface MatchDeviceDbRow {
  id: number;
  match_run_id: number;
  imei: string | null;
  os_values_json: string;
  kit_status: string | null;
  allocation_phase: string | null;
  priority_rank: number | null;
}

interface SourceOrderPartDescRow {
  id: number;
  concat_peca: string | null;
}

function loadMatchResult(db: Db, resultId: number): MatchResultDbRow {
  const row = db
    .prepare("SELECT * FROM match_results WHERE id = ?")
    .get(resultId) as MatchResultDbRow | undefined;
  if (!row) throw new SeparationError(404, `match_result ${resultId} não encontrado.`);
  return row;
}

function loadMatchDevice(db: Db, deviceResultId: number): MatchDeviceDbRow {
  const row = db
    .prepare("SELECT * FROM match_device_results WHERE id = ?")
    .get(deviceResultId) as MatchDeviceDbRow | undefined;
  if (!row) throw new SeparationError(404, `match_device_result ${deviceResultId} não encontrado.`);
  return row;
}

/** Carrega todas as linhas abertas e alocadas de um device result. */
function loadFullKitLines(db: Db, matchRunId: number, deviceResultId: number): MatchResultDbRow[] {
  return db
    .prepare(
      `SELECT * FROM match_results
       WHERE match_run_id = ? AND device_result_id = ?
         AND allocation_phase = 'FULL' AND result_status = 'MATCH'
       ORDER BY id_pedido`,
    )
    .all(matchRunId, deviceResultId) as unknown as MatchResultDbRow[];
}

function getSourceDescription(db: Db, sourceOrderPartId: number): string | null {
  const r = db
    .prepare("SELECT concat_peca FROM source_order_parts WHERE id = ?")
    .get(sourceOrderPartId) as SourceOrderPartDescRow | undefined;
  return r?.concat_peca ?? null;
}

/** Insere um stock_movement de REPAIR_CONSUMPTION e retorna o id. */
function insertRepairConsumption(
  db: Db,
  item: SeparationItemRow,
  confirmedBy: string,
  batchNumber: string,
): number {
  const notes = JSON.stringify({
    batchNumber,
    matchRunId: item.match_run_id,
    matchResultId: item.match_result_id,
    idPedido: item.id_pedido,
    imei: item.imei,
    reference: item.reference,
    chavePeca: item.chave_peca,
  });

  const r = db
    .prepare(
      `INSERT INTO stock_movements
         (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm,
          quantity, source_type, source_id, source_item_id, created_by, notes)
       VALUES ('REPAIR_CONSUMPTION', ?, ?, ?, ?, -1, 'SEPARATION_ITEM', ?, ?, ?, ?)`,
    )
    .run(
      item.reference ?? "",
      item.reference_norm ?? "",
      item.chave_peca ?? null,
      item.chave_peca_norm ?? null,
      item.id,
      item.id,
      confirmedBy,
      notes,
    );
  return r.lastInsertRowid as number;
}

/** Insere um operational_event PART_SEPARATED e retorna o id. */
function insertPartSeparatedEvent(
  db: Db,
  item: SeparationItemRow,
  previousStatus: string,
  confirmedBy: string,
  stockMovementId: number,
): number {
  const r = db
    .prepare(
      `INSERT INTO operational_events
         (entity_type, entity_id, event_type, previous_status, new_status,
          responsible_name, notes,
          separation_batch_id, separation_item_id, match_run_id, match_result_id,
          stock_movement_id)
       VALUES ('ORDER_PART', ?, 'PART_SEPARATED', ?, 'SEPARADO', ?, ?,
               ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id_pedido,
      previousStatus,
      confirmedBy,
      JSON.stringify({
        batchId: item.separation_batch_id,
        separationItemId: item.id,
        matchRunId: item.match_run_id,
        matchResultId: item.match_result_id,
        stockMovementId,
      }),
      item.separation_batch_id,
      item.id,
      item.match_run_id,
      item.match_result_id,
      stockMovementId,
    );
  return r.lastInsertRowid as number;
}

/** Determina o status efetivo anterior de uma solicitação. */
function getPreviousEffectiveStatus(db: Db, idPedido: string, sourceOrderPartId: number): string {
  // Último evento operacional tem precedência
  const ev = db
    .prepare(
      `SELECT new_status FROM operational_events
       WHERE entity_type = 'ORDER_PART' AND entity_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(idPedido) as { new_status: string } | undefined;
  if (ev?.new_status) return ev.new_status;
  // Fallback para status legado
  const part = db
    .prepare("SELECT status_atual_legado FROM source_order_parts WHERE id = ?")
    .get(sourceOrderPartId) as { status_atual_legado: string | null } | undefined;
  return part?.status_atual_legado ?? "";
}

/** Valida linha de resultado como elegível para separação. */
function validateResultEligibility(
  line: MatchResultDbRow,
  activeIdPedidos: Set<string>,
): void {
  const eligibleStatuses = new Set(["MATCH", "MATCH PARCIAL"]);
  if (!line.result_status || !eligibleStatuses.has(line.result_status)) {
    throw new SeparationError(
      422,
      `Resultado ${line.id} (${line.id_pedido}) com status "${line.result_status}" não é elegível.`,
    );
  }
  if (!line.reserved_units || line.reserved_units < 1) {
    throw new SeparationError(
      422,
      `Resultado ${line.id} (${line.id_pedido}) não tem unidades alocadas.`,
    );
  }
  if (!line.allocated_reference_norm || !line.chave_peca_norm) {
    throw new SeparationError(
      422,
      `Resultado ${line.id} (${line.id_pedido}) sem referência ou chave alocada.`,
    );
  }
  if (activeIdPedidos.has(line.id_pedido)) {
    throw new SeparationError(
      409,
      `Solicitação "${line.id_pedido}" já possui separação ativa (RESERVED ou CONFIRMED).`,
      { idPedido: line.id_pedido },
    );
  }
}

// ---------------------------------------------------------------------------
// Criar lote de separação
// ---------------------------------------------------------------------------

export function createSeparationBatch(
  db: Db,
  input: CreateSeparationBatchInput,
): SeparationBatchRow {
  const createdBy = (input.createdBy ?? "").trim();
  if (!createdBy) throw new SeparationError(400, "createdBy é obrigatório.");
  if (!input.idempotencyKey?.trim())
    throw new SeparationError(400, "idempotencyKey é obrigatório.");
  if (!input.matchRunId || input.matchRunId <= 0)
    throw new SeparationError(400, "matchRunId inválido.");

  const hasFullKits =
    Array.isArray(input.fullDeviceResultIds) && input.fullDeviceResultIds.length > 0;
  const hasPartials =
    Array.isArray(input.partialMatchResultIds) && input.partialMatchResultIds.length > 0;
  if (!hasFullKits && !hasPartials)
    throw new SeparationError(400, "Selecione ao menos um kit completo ou uma linha parcial.");

  // Idempotência
  const existing = getSeparationBatchByIdempotencyKey(db, input.idempotencyKey.trim());
  if (existing) return existing;

  db.exec("BEGIN");
  try {
    // 1. Carregar match_run
    const run = getMatchRun(db, input.matchRunId);
    if (!run) throw new SeparationError(404, `match_run ${input.matchRunId} não encontrado.`);
    if (run.status !== "COMPLETED" && run.status !== "COMPLETED_WITH_WARNINGS") {
      throw new SeparationError(
        422,
        `match_run ${run.id} tem status "${run.status}" — somente runs concluídos podem gerar separação.`,
      );
    }

    // 2. Verificar stale
    if (isRunStale(db, run)) {
      throw new SeparationError(
        409,
        `O run de match #${run.id} está desatualizado (stale). Execute um novo match antes de separar.`,
      );
    }

    // 3. Carregar IDs ativos já reservados/confirmados por id_pedido
    const activeIdPedidos = getActiveReservedIdPedidos(db);

    // 4. Coletar linhas a reservar
    const linesToReserve: MatchResultDbRow[] = [];
    const seenResultIds = new Set<number>();

    // 4a. Expandir full kits (backend decide as linhas — não confia no frontend)
    if (hasFullKits) {
      const deviceIds = [...new Set(input.fullDeviceResultIds!)];
      for (const devId of deviceIds) {
        const device = loadMatchDevice(db, devId);
        if (device.match_run_id !== input.matchRunId) {
          throw new SeparationError(
            400,
            `match_device_result ${devId} não pertence ao run ${input.matchRunId}.`,
          );
        }
        if (device.allocation_phase !== "FULL") {
          throw new SeparationError(
            422,
            `Aparelho ${devId} (IMEI ${device.imei}) não é kit completo (phase=${device.allocation_phase}).`,
          );
        }

        const kitLines = loadFullKitLines(db, input.matchRunId, devId);
        if (kitLines.length === 0) {
          throw new SeparationError(
            422,
            `Aparelho ${devId} não possui linhas de kit completo disponíveis.`,
          );
        }
        for (const line of kitLines) {
          if (seenResultIds.has(line.id)) continue;
          validateResultEligibility(line, activeIdPedidos);
          seenResultIds.add(line.id);
          linesToReserve.push(line);
        }
      }
    }

    // 4b. Linhas parciais individuais
    if (hasPartials) {
      const resultIds = [...new Set(input.partialMatchResultIds!)];
      for (const rId of resultIds) {
        if (seenResultIds.has(rId)) continue;
        const line = loadMatchResult(db, rId);
        if (line.match_run_id !== input.matchRunId) {
          throw new SeparationError(
            400,
            `match_result ${rId} não pertence ao run ${input.matchRunId}.`,
          );
        }
        if (line.allocation_phase !== "PARTIAL") {
          throw new SeparationError(
            422,
            `match_result ${rId} (${line.id_pedido}) não é parcial (phase=${line.allocation_phase}).`,
          );
        }
        validateResultEligibility(line, activeIdPedidos);
        seenResultIds.add(rId);
        linesToReserve.push(line);
      }
    }

    if (linesToReserve.length === 0) {
      throw new SeparationError(422, "Nenhuma linha elegível encontrada para separação.");
    }

    // 5. Verificar disponibilidade de estoque (físico - reservado já ativo)
    const stock = getCurrentOperationalStock(db);
    // Montar mapa disponível por (referenceNorm, chavePecaNorm)
    const available = new Map<string, number>();
    for (const g of stock.groups) {
      if (g.chavePecaNorm && g.referenciaNorm) {
        available.set(`${g.referenciaNorm}|${g.chavePecaNorm}`, (g as any).availableQuantity ?? g.currentQuantity);
      }
    }
    // Simular consumo das linhas a reservar
    const needed = new Map<string, number>();
    for (const line of linesToReserve) {
      const k = `${line.allocated_reference_norm}|${line.chave_peca_norm}`;
      needed.set(k, (needed.get(k) ?? 0) + 1);
    }
    for (const [k, qty] of needed) {
      const avail = available.get(k) ?? 0;
      if (avail < qty) {
        const [ref, chave] = k.split("|");
        throw new SeparationError(
          422,
          `Estoque insuficiente para referência "${ref}" / chave "${chave}": ` +
            `disponível=${avail}, necessário=${qty}.`,
          { referenceNorm: ref, chavePecaNorm: chave, available: avail, needed: qty },
        );
      }
    }

    // 6. Gerar número e criar lote
    const batchNumber = generateBatchNumber(db);
    const batchId = insertSeparationBatch(db, {
      batchNumber,
      matchRunId: input.matchRunId,
      createdBy,
      notes: input.notes ?? null,
      idempotencyKey: input.idempotencyKey.trim(),
    });

    // 7. Criar itens como RESERVED
    for (const line of linesToReserve) {
      const desc = getSourceDescription(db, line.source_order_part_id);
      insertSeparationItem(db, {
        separationBatchId: batchId,
        matchRunId: line.match_run_id,
        matchResultId: line.id,
        matchDeviceResultId: line.device_result_id ?? null,
        sourceOrderPartId: line.source_order_part_id,
        idPedido: line.id_pedido,
        imei: line.imei ?? null,
        os: line.os ?? null,
        description: desc,
        chavePeca: line.chave_peca ?? null,
        chavePecaNorm: line.chave_peca_norm ?? null,
        reference: line.allocated_reference ?? null,
        referenceNorm: line.allocated_reference_norm ?? null,
        matchResultStatus: line.result_status ?? null,
        matchAllocationPhase: line.allocation_phase ?? null,
        matchConsumptionOrder: line.ordem_consumo ?? null,
      });
    }

    // 8. Verificação de integridade: reserved <= physical por grupo
    const freshStock = getCurrentOperationalStock(db);
    for (const g of freshStock.groups) {
      if ((g as any).availableQuantity !== undefined && (g as any).availableQuantity < 0) {
        throw new Error(
          `Integridade: availableQuantity negativo para "${g.referencia}" / "${g.chavePeca ?? "(sem chave)"}".`,
        );
      }
    }

    db.exec("COMMIT");
    return getSeparationBatch(db, batchId)!;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao criar lote de separação: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Confirmar item parcial
// ---------------------------------------------------------------------------

export function confirmPartialItem(db: Db, input: ConfirmItemInput): SeparationItemRow {
  const confirmedBy = (input.confirmedBy ?? "").trim();
  if (!confirmedBy) throw new SeparationError(400, "confirmedBy é obrigatório.");
  if (!input.idempotencyKey?.trim())
    throw new SeparationError(400, "idempotencyKey é obrigatório.");

  db.exec("BEGIN");
  try {
    const item = getSeparationItem(db, input.itemId);
    if (!item) throw new SeparationError(404, `Item ${input.itemId} não encontrado.`);

    // Idempotência
    if (
      item.status === "CONFIRMED" &&
      item.confirmation_idempotency_key === input.idempotencyKey.trim()
    ) {
      db.exec("ROLLBACK");
      return item;
    }

    if (item.status === "CONFIRMED") {
      throw new SeparationError(409, `Item ${item.id} já foi confirmado.`);
    }
    if (item.status === "CANCELLED") {
      throw new SeparationError(422, `Item ${item.id} foi cancelado e não pode ser confirmado.`);
    }

    // Somente item parcial pode ser confirmado individualmente
    if (item.match_allocation_phase !== "PARTIAL") {
      throw new SeparationError(
        422,
        `Item ${item.id} pertence a kit completo (phase=${item.match_allocation_phase}). ` +
          `Use o endpoint de confirmação do aparelho.`,
      );
    }

    const batch = getSeparationBatch(db, item.separation_batch_id);
    if (!batch) throw new SeparationError(404, `Lote ${item.separation_batch_id} não encontrado.`);

    _confirmSingleItem(db, item, batch.batch_number, confirmedBy, input.notes ?? null, input.idempotencyKey.trim());

    recalculateAndPersistBatchStatus(db, item.separation_batch_id, { completedBy: confirmedBy });

    db.exec("COMMIT");
    return getSeparationItem(db, item.id)!;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao confirmar item: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Confirmar full kit por aparelho
// ---------------------------------------------------------------------------

export function confirmFullDevice(db: Db, input: ConfirmDeviceInput): void {
  const confirmedBy = (input.confirmedBy ?? "").trim();
  if (!confirmedBy) throw new SeparationError(400, "confirmedBy é obrigatório.");
  if (!input.idempotencyKey?.trim())
    throw new SeparationError(400, "idempotencyKey é obrigatório.");

  db.exec("BEGIN");
  try {
    const batch = getSeparationBatch(db, input.batchId);
    if (!batch) throw new SeparationError(404, `Lote ${input.batchId} não encontrado.`);

    const items = getReservedItemsByDevice(db, input.batchId, input.deviceResultId);
    if (items.length === 0) {
      throw new SeparationError(
        404,
        `Nenhum item reservado para o aparelho ${input.deviceResultId} no lote ${input.batchId}.`,
      );
    }

    // Todos devem ser full kit
    const notFull = items.filter((i) => i.match_allocation_phase !== "FULL");
    if (notFull.length > 0) {
      throw new SeparationError(
        422,
        `Itens misturados: ${notFull.map((i) => i.id_pedido).join(", ")} não são full kit.`,
      );
    }

    // Verificar se já existe confirmação com a mesma idempotency_key em qualquer item
    const alreadyConfirmed = getItemsByDevice(db, input.batchId, input.deviceResultId).filter(
      (i) =>
        i.status === "CONFIRMED" &&
        i.confirmation_idempotency_key === input.idempotencyKey.trim(),
    );
    if (alreadyConfirmed.length === items.length || (alreadyConfirmed.length > 0 && items.length === 0)) {
      db.exec("ROLLBACK");
      return;
    }

    for (const item of items) {
      _confirmSingleItem(db, item, batch.batch_number, confirmedBy, input.notes ?? null, input.idempotencyKey.trim());
    }

    recalculateAndPersistBatchStatus(db, input.batchId, { completedBy: confirmedBy });

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao confirmar kit: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Confirmar lote inteiro
// ---------------------------------------------------------------------------

export function confirmAll(db: Db, input: ConfirmAllInput): void {
  const confirmedBy = (input.confirmedBy ?? "").trim();
  if (!confirmedBy) throw new SeparationError(400, "confirmedBy é obrigatório.");
  if (!input.idempotencyKey?.trim())
    throw new SeparationError(400, "idempotencyKey é obrigatório.");

  db.exec("BEGIN");
  try {
    const batch = getSeparationBatch(db, input.batchId);
    if (!batch) throw new SeparationError(404, `Lote ${input.batchId} não encontrado.`);
    if (batch.status === "CANCELLED") {
      throw new SeparationError(422, `Lote ${input.batchId} está cancelado.`);
    }

    const items = getItemsByBatch(db, input.batchId).filter((i) => i.status === "RESERVED");
    if (items.length === 0) {
      db.exec("ROLLBACK");
      return;
    }

    for (const item of items) {
      _confirmSingleItem(db, item, batch.batch_number, confirmedBy, input.notes ?? null, `${input.idempotencyKey.trim()}:${item.id}`);
    }

    recalculateAndPersistBatchStatus(db, input.batchId, { completedBy: confirmedBy });

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao confirmar lote: ${(err as Error).message}`);
  }
}

/** Confirma um único item dentro de uma transação já aberta. */
function _confirmSingleItem(
  db: Db,
  item: SeparationItemRow,
  batchNumber: string,
  confirmedBy: string,
  notes: string | null,
  idempotencyKey: string,
): void {
  const previousStatus = getPreviousEffectiveStatus(db, item.id_pedido, item.source_order_part_id);

  const stockMovementId = insertRepairConsumption(db, item, confirmedBy, batchNumber);
  const operationalEventId = insertPartSeparatedEvent(
    db,
    item,
    previousStatus,
    confirmedBy,
    stockMovementId,
  );

  confirmSeparationItem(db, item.id, {
    confirmedBy,
    notes,
    idempotencyKey,
    stockMovementId,
    operationalEventId,
  });
}

// ---------------------------------------------------------------------------
// Cancelar item parcial
// ---------------------------------------------------------------------------

export function cancelPartialItem(db: Db, input: CancelItemInput): SeparationItemRow {
  const cancelledBy = (input.cancelledBy ?? "").trim();
  if (!cancelledBy) throw new SeparationError(400, "cancelledBy é obrigatório.");
  if (!input.cancelReason?.trim() || input.cancelReason.trim().length < 10)
    throw new SeparationError(400, "cancelReason deve ter ao menos 10 caracteres.");

  db.exec("BEGIN");
  try {
    const item = getSeparationItem(db, input.itemId);
    if (!item) throw new SeparationError(404, `Item ${input.itemId} não encontrado.`);
    if (item.status === "CONFIRMED")
      throw new SeparationError(422, `Item ${item.id} já confirmado — não pode ser cancelado.`);
    if (item.status === "CANCELLED") {
      db.exec("ROLLBACK");
      return item;
    }
    if (item.match_allocation_phase !== "PARTIAL") {
      throw new SeparationError(
        422,
        `Item ${item.id} pertence a kit completo. Use cancelamento por aparelho.`,
      );
    }

    cancelSeparationItem(db, item.id, { cancelledBy, cancelReason: input.cancelReason.trim() });
    recalculateAndPersistBatchStatus(db, item.separation_batch_id, {
      cancelledBy,
      cancelReason: input.cancelReason.trim(),
    });

    db.exec("COMMIT");
    return getSeparationItem(db, item.id)!;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao cancelar item: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Cancelar full kit por aparelho
// ---------------------------------------------------------------------------

export function cancelFullDevice(db: Db, input: CancelDeviceInput): void {
  const cancelledBy = (input.cancelledBy ?? "").trim();
  if (!cancelledBy) throw new SeparationError(400, "cancelledBy é obrigatório.");
  if (!input.cancelReason?.trim() || input.cancelReason.trim().length < 10)
    throw new SeparationError(400, "cancelReason deve ter ao menos 10 caracteres.");

  db.exec("BEGIN");
  try {
    const batch = getSeparationBatch(db, input.batchId);
    if (!batch) throw new SeparationError(404, `Lote ${input.batchId} não encontrado.`);

    const items = getItemsByDevice(db, input.batchId, input.deviceResultId);
    if (items.length === 0)
      throw new SeparationError(404, `Nenhum item para aparelho ${input.deviceResultId}.`);

    const confirmed = items.filter((i) => i.status === "CONFIRMED");
    if (confirmed.length > 0) {
      throw new SeparationError(
        422,
        `Aparelho ${input.deviceResultId} tem ${confirmed.length} item(s) já confirmado(s) — cancelamento bloqueado.`,
      );
    }

    for (const item of items.filter((i) => i.status === "RESERVED")) {
      cancelSeparationItem(db, item.id, {
        cancelledBy,
        cancelReason: input.cancelReason.trim(),
      });
    }

    recalculateAndPersistBatchStatus(db, input.batchId, {
      cancelledBy,
      cancelReason: input.cancelReason.trim(),
    });

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao cancelar aparelho: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Cancelar lote
// ---------------------------------------------------------------------------

export function cancelBatch(db: Db, input: CancelBatchInput): SeparationBatchRow {
  const cancelledBy = (input.cancelledBy ?? "").trim();
  if (!cancelledBy) throw new SeparationError(400, "cancelledBy é obrigatório.");
  if (!input.cancelReason?.trim() || input.cancelReason.trim().length < 10)
    throw new SeparationError(400, "cancelReason deve ter ao menos 10 caracteres.");

  db.exec("BEGIN");
  try {
    const batch = getSeparationBatch(db, input.batchId);
    if (!batch) throw new SeparationError(404, `Lote ${input.batchId} não encontrado.`);
    if (batch.status === "CANCELLED") {
      db.exec("ROLLBACK");
      return batch;
    }

    const items = getItemsByBatch(db, input.batchId);
    for (const item of items.filter((i) => i.status === "RESERVED")) {
      cancelSeparationItem(db, item.id, {
        cancelledBy,
        cancelReason: input.cancelReason.trim(),
      });
    }

    recalculateAndPersistBatchStatus(db, input.batchId, {
      cancelledBy,
      cancelReason: input.cancelReason.trim(),
    });

    db.exec("COMMIT");
    return getSeparationBatch(db, input.batchId)!;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (err instanceof SeparationError) throw err;
    throw new SeparationError(500, `Falha ao cancelar lote: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export function getBatchState(db: Db, batchId: number): SeparationBatchState {
  const batch = getSeparationBatch(db, batchId);
  if (!batch) throw new SeparationError(404, `Lote ${batchId} não encontrado.`);

  const allItems = getItemsByBatch(db, batchId);
  const totals = getBatchTotals(db, batchId);

  // Agrupar por device (full kit)
  const deviceMap = new Map<number, SeparationItemRow[]>();
  const partialItems: SeparationItemRow[] = [];

  for (const item of allItems) {
    if (item.match_device_result_id !== null && item.match_allocation_phase === "FULL") {
      const list = deviceMap.get(item.match_device_result_id) ?? [];
      list.push(item);
      deviceMap.set(item.match_device_result_id, list);
    } else {
      partialItems.push(item);
    }
  }

  const devices: DeviceSeparationGroup[] = [];
  for (const [devId, devItems] of deviceMap) {
    const devRow = db
      .prepare("SELECT * FROM match_device_results WHERE id = ?")
      .get(devId) as MatchDeviceDbRow | undefined;
    const osValues = devRow ? JSON.parse(devRow.os_values_json || "[]") : [];
    devices.push({
      deviceResultId: devId,
      imei: devItems[0]?.imei ?? null,
      os: osValues[0] ?? null,
      kitStatus: devRow?.kit_status ?? null,
      priorityRank: devRow?.priority_rank ?? null,
      allocationPhase: devRow?.allocation_phase ?? null,
      items: devItems,
      allConfirmed: devItems.every((i) => i.status === "CONFIRMED"),
      allCancelled: devItems.every((i) => i.status === "CANCELLED"),
      hasReserved: devItems.some((i) => i.status === "RESERVED"),
    });
  }

  const warnings: string[] = [];
  // Avisar se run ficou stale desde que o lote foi criado
  const run = getMatchRun(db, batch.match_run_id);
  if (run && isRunStale(db, run)) {
    warnings.push(`O run de match #${run.id} está desatualizado. O estoque pode ter mudado.`);
  }

  return {
    batch,
    totals,
    devices,
    partialItems,
    traceability: {
      matchRunId: batch.match_run_id,
      batchId: batch.id,
      batchNumber: batch.batch_number,
      separationItemIds: allItems.map((i) => i.id),
      matchResultIds: allItems.map((i) => i.match_result_id),
      sourceOrderPartIds: allItems.map((i) => i.source_order_part_id),
      stockMovementIds: allItems.filter((i) => i.stock_movement_id !== null).map((i) => i.stock_movement_id!),
      operationalEventIds: allItems
        .filter((i) => i.operational_event_id !== null)
        .map((i) => i.operational_event_id!),
    },
    warnings,
  };
}

export {
  listSeparationBatches,
  getSeparationBatch,
  getSeparationItem,
  getItemsByBatch,
};
export type { ListSeparationBatchesParams };
