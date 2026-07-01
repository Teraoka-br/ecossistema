/**
 * Consultas e gravações do motor de match.
 * Sem lógica de negócio — apenas acesso ao banco.
 */

import type { Db } from "../db/database.js";
import type {
  EngineDeviceResult,
  EngineLineResult,
  EngineStats,
  SourceOrderPartRow,
} from "./match-engine.js";
import type { FingerprintComponents } from "./match-fingerprint.js";
import { normalizeStatus } from "../domain/text.js";

// ---------------------------------------------------------------------------
// Tipos públicos (linhas do banco)
// ---------------------------------------------------------------------------

export interface MatchRunRow {
  id: number;
  import_batch_id: number | null;
  decision_rule_id: number | null;
  algorithm_version: string;
  status: "RUNNING" | "COMPLETED" | "COMPLETED_WITH_WARNINGS" | "FAILED";
  input_hash: string | null;
  created_by: string;
  started_at: string;
  finished_at: string | null;
  notes: string | null;
  error_message: string | null;
  stock_base_type: string | null;
  stock_snapshot_id: number | null;
  stock_cutoff_movement_id: number;
  stock_max_movement_id: number;
  stock_state_hash: string | null;
  stock_total_units: number;
  stock_usable_units: number;
  stock_unmapped_units: number;
  rule_age_days_per_point: number | null;
  rule_age_max_points: number | null;
  rule_margin_per_point: number | null;
  rule_margin_allows_negative: number | null;
  devices_total: number;
  devices_considered: number;
  devices_full_match: number;
  devices_partial: number;
  devices_incomplete: number;
  devices_verify: number;
  devices_preserved: number;
  lines_total: number;
  lines_match: number;
  lines_partial: number;
  lines_request_piece: number;
  lines_no_balance: number;
  lines_verify: number;
  lines_preserved: number;
  allocated_units: number;
  remaining_usable_units: number;
  warnings_count: number;
  created_at: string;
}

export interface MatchDeviceRow {
  id: number;
  match_run_id: number;
  device_key: string;
  imei: string | null;
  os_values_json: string;
  os_conflict: number;
  total_parts: number;
  open_parts: number;
  permanent_parts: number;
  score: number;
  margin: number | null;
  age_score: number;
  margin_score: number;
  priority_rank: number | null;
  stable_id: string | null;
  kit_status: string | null;
  kit_priority: number | null;
  allocation_phase: string | null;
  warning_codes_json: string;
  created_at: string;
}

export interface MatchResultRow {
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
  effective_status_before: string | null;
  result_status: string | null;
  result_status_label: string | null;
  kit_status: string | null;
  kit_priority: number | null;
  allocation_phase: string | null;
  reserved_units: number;
  ordem_consumo: number | null;
  stock_for_key_initial: number;
  stock_for_key_before: number;
  stock_for_key_after: number;
  margin: number | null;
  nota_idade: number;
  nota_margem: number;
  score: number;
  device_priority_rank: number | null;
  reason_code: string | null;
  warning_codes_json: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Consultas de demanda
// ---------------------------------------------------------------------------

/** Carrega solicitações do lote inicial. */
export function loadDemandLines(db: Db, importBatchId: number): SourceOrderPartRow[] {
  return db
    .prepare(
      `SELECT id, id_pedido, imei, os, chave_peca, chave_peca_norm, referencia,
              status_atual_legado, status_atual_label, status_kit_legado, prioridade_kit_legado,
              quantidade_pecas_aparelho, idade, custo, venda, margem_legada,
              nota_idade_legada, nota_margem_legada, score_legado, ordem_consumo_legada,
              quantidade_estoque_legada
       FROM source_order_parts
       WHERE import_batch_id = ?
       ORDER BY id`,
    )
    .all(importBatchId) as unknown as SourceOrderPartRow[];
}

/**
 * Carrega o evento operacional mais recente por id_pedido (entity_type = ORDER_PART).
 * Inclui reservas ativas (EM SEPARACAO) com precedência sobre eventos.
 * Retorna Map<idPedido, new_status>.
 */
export function loadOperationalEventsForOrders(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT entity_id, new_status
       FROM operational_events
       WHERE entity_type = 'ORDER_PART' AND new_status IS NOT NULL
       ORDER BY id DESC`,
    )
    .all() as { entity_id: string; new_status: string }[];

  const map = new Map<string, string>();
  for (const r of rows) {
    if (!map.has(r.entity_id)) {
      map.set(r.entity_id, r.new_status);
    }
  }

  // Reservas ativas sobrepõem o status efetivo (precedência máxima para demanda não-permanente)
  try {
    const reserved = db
      .prepare(
        `SELECT DISTINCT id_pedido FROM separation_items WHERE status = 'RESERVED'`,
      )
      .all() as { id_pedido: string }[];
    for (const r of reserved) {
      // Só sobrepõe se não for status permanente (CONCLUIDO, SEPARADO, CANCELADO)
      const existing = map.get(r.id_pedido);
      const permanent = new Set(["CONCLUIDO", "SEPARADO", "CANCELADO"]);
      if (!existing || !permanent.has(existing)) {
        map.set(r.id_pedido, "EM SEPARACAO");
      }
    }
  } catch {
    // tabela separation_items ainda não existe
  }

  return map;
}

// ---------------------------------------------------------------------------
// Criação de execução
// ---------------------------------------------------------------------------

export interface CreateMatchRunInput {
  importBatchId: number | null;
  decisionRuleId: number;
  algorithmVersion: string;
  inputHash: string;
  createdBy: string;
  notes: string | null;
  components: FingerprintComponents;
}

/** Cria um match_run como RUNNING. Retorna o id. */
export function createMatchRun(db: Db, input: CreateMatchRunInput): number {
  const result = db
    .prepare(
      `INSERT INTO match_runs
         (import_batch_id, decision_rule_id, algorithm_version, status, input_hash, created_by, notes,
          stock_base_type, stock_snapshot_id, stock_cutoff_movement_id, stock_max_movement_id,
          stock_state_hash,
          rule_age_days_per_point, rule_age_max_points, rule_margin_per_point, rule_margin_allows_negative)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.importBatchId,
      input.decisionRuleId,
      input.algorithmVersion,
      "RUNNING",
      input.inputHash,
      input.createdBy,
      input.notes,
      input.components.stockBaseType,
      input.components.stockSnapshotId,
      input.components.stockCutoffMovementId,
      input.components.stockMaxMovementId,
      input.components.stockStateHash,
      input.components.ruleAgeDaysPerPoint,
      input.components.ruleAgeMaxPoints,
      input.components.ruleMarginPerPoint,
      input.components.ruleMarginAllowsNegative ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

/** Insere um resultado de aparelho e retorna o id. */
export function insertDeviceResult(db: Db, runId: number, device: EngineDeviceResult): number {
  const result = db
    .prepare(
      `INSERT INTO match_device_results
         (match_run_id, device_key, imei, os_values_json, os_conflict,
          total_parts, open_parts, permanent_parts,
          score, margin, age_score, margin_score, priority_rank, stable_id,
          kit_status, kit_priority, allocation_phase, warning_codes_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      runId,
      device.deviceKey,
      device.imei,
      JSON.stringify(device.osValues),
      device.osConflict ? 1 : 0,
      device.totalParts,
      device.openParts,
      device.permanentParts,
      device.score,
      device.margin,
      device.ageScore,
      device.marginScore,
      device.priorityRank,
      device.stableId,
      device.kitStatus,
      device.kitPriority,
      device.allocationPhase,
      JSON.stringify(device.warningCodes),
    );
  return Number(result.lastInsertRowid);
}

/** Insere um resultado de linha. */
export function insertLineResult(
  db: Db,
  runId: number,
  deviceResultId: number | null,
  line: EngineLineResult,
): void {
  db.prepare(
    `INSERT INTO match_results
       (match_run_id, source_order_part_id, device_result_id, id_pedido, imei, os,
        chave_peca, chave_peca_norm, allocated_reference, allocated_reference_norm,
        effective_status_before, result_status, result_status_label, kit_status, kit_priority,
        allocation_phase, reserved_units, ordem_consumo,
        stock_for_key_initial, stock_for_key_before, stock_for_key_after,
        margin, nota_idade, nota_margem, score, device_priority_rank,
        reason_code, warning_codes_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    runId,
    line.sourceOrderPartId,
    deviceResultId,
    line.idPedido,
    line.imei,
    line.os,
    line.chavePeca,
    line.chavePecaNorm,
    line.allocatedReference,
    line.allocatedReferenceNorm,
    line.effectiveStatusBefore,
    line.resultStatus,
    line.resultStatusLabel,
    line.kitStatus,
    line.kitPriority,
    line.allocationPhase,
    line.reservedUnits,
    line.ordemConsumo,
    line.stockForKeyInitial,
    line.stockForKeyBefore,
    line.stockForKeyAfter,
    line.margin,
    line.notaIdade,
    line.notaMargem,
    line.score,
    line.devicePriorityRank,
    line.reasonCode,
    JSON.stringify(line.warningCodes),
  );
}

/** Atualiza o match_run ao concluir com sucesso. */
export function completeMatchRun(
  db: Db,
  runId: number,
  stats: EngineStats,
  stockStats: { total: number; usable: number; unmapped: number; maxMovementId: number },
  hasWarnings: boolean,
): void {
  const status = hasWarnings ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
  db.prepare(
    `UPDATE match_runs SET
       status = ?, finished_at = datetime('now'),
       stock_total_units = ?, stock_usable_units = ?, stock_unmapped_units = ?,
       stock_max_movement_id = ?,
       devices_total = ?, devices_considered = ?, devices_full_match = ?,
       devices_partial = ?, devices_incomplete = ?, devices_verify = ?, devices_preserved = ?,
       lines_total = ?, lines_match = ?, lines_partial = ?,
       lines_request_piece = ?, lines_no_balance = ?, lines_verify = ?, lines_preserved = ?,
       allocated_units = ?, remaining_usable_units = ?, warnings_count = ?
     WHERE id = ?`,
  ).run(
    status,
    stockStats.total,
    stockStats.usable,
    stockStats.unmapped,
    stockStats.maxMovementId,
    stats.devicesTotal,
    stats.devicesConsidered,
    stats.devicesFullMatch,
    stats.devicesPartial,
    stats.devicesIncomplete,
    stats.devicesVerify,
    stats.devicesPreserved,
    stats.linesTotal,
    stats.linesMatch,
    stats.linesPartial,
    stats.linesRequestPiece,
    stats.linesNoBalance,
    stats.linesVerify,
    stats.linesPreserved,
    stats.allocatedUnits,
    stats.remainingUsableUnits,
    stats.warningsCount,
    runId,
  );
}

/** Marca uma execução como FAILED com mensagem de erro. */
export function failMatchRun(db: Db, runId: number, message: string): void {
  db.prepare(
    `UPDATE match_runs SET status = 'FAILED', finished_at = datetime('now'), error_message = ? WHERE id = ?`,
  ).run(message.substring(0, 1000), runId);
}

// ---------------------------------------------------------------------------
// Consultas de leitura
// ---------------------------------------------------------------------------

export function getMatchRun(db: Db, id: number): MatchRunRow | null {
  return (
    (db.prepare("SELECT * FROM match_runs WHERE id = ?").get(id) as unknown as MatchRunRow) ?? null
  );
}

/** Encontra execução concluída com o mesmo hash (para reutilização). */
export function findCompletedRunByHash(db: Db, hash: string): MatchRunRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM match_runs
         WHERE input_hash = ? AND status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(hash) as unknown as MatchRunRow) ?? null
  );
}

export interface ListMatchRunsParams {
  limit?: number;
  offset?: number;
  status?: string;
}

export function listMatchRuns(
  db: Db,
  params: ListMatchRunsParams = {},
): { runs: MatchRunRow[]; total: number } {
  const where: string[] = [];
  const args: (string | number | null)[] = [];
  if (params.status) {
    where.push("status = ?");
    args.push(params.status);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM match_runs ${whereClause}`).get(...args) as { c: number }
  ).c;
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const runs = db
    .prepare(`SELECT * FROM match_runs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as unknown as MatchRunRow[];
  return { runs, total };
}

export function getLatestCompletedRun(db: Db): MatchRunRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM match_runs WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as unknown as MatchRunRow) ?? null
  );
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

export interface ListResultsParams {
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
  kitStatus?: string;
  phase?: string;
  onlyDivergent?: boolean;
}

export function listDeviceResults(
  db: Db,
  runId: number,
  params: ListResultsParams = {},
): { devices: MatchDeviceRow[]; total: number } {
  const where: string[] = ["d.match_run_id = ?"];
  const args: (string | number | null)[] = [runId];

  if (params.kitStatus) {
    where.push("d.kit_status = ?");
    args.push(params.kitStatus);
  }
  if (params.search) {
    where.push("(d.imei LIKE ? OR d.device_key LIKE ?)");
    const p = `%${params.search}%`;
    args.push(p, p);
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM match_device_results d ${whereClause}`)
      .get(...args) as { c: number }
  ).c;

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const devices = db
    .prepare(
      `SELECT d.* FROM match_device_results d ${whereClause}
       ORDER BY d.priority_rank ASC NULLS LAST, d.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as unknown as MatchDeviceRow[];
  return { devices, total };
}

export function listLineResults(
  db: Db,
  runId: number,
  params: ListResultsParams = {},
): { results: MatchResultRow[]; total: number } {
  const where: string[] = ["r.match_run_id = ?"];
  const args: (string | number | null)[] = [runId];

  if (params.status) {
    where.push("r.result_status = ?");
    args.push(params.status);
  }
  if (params.phase) {
    where.push("r.allocation_phase = ?");
    args.push(params.phase);
  }
  if (params.search) {
    where.push("(r.id_pedido LIKE ? OR r.imei LIKE ? OR r.chave_peca LIKE ? OR r.chave_peca_norm LIKE ?)");
    const p = `%${params.search}%`;
    args.push(p, p, p, p);
  }
  if (params.onlyDivergent) {
    where.push(
      `(r.result_status != r.effective_status_before
        AND r.allocation_phase != 'PRESERVED')`,
    );
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM match_results r ${whereClause}`)
      .get(...args) as { c: number }
  ).c;

  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const results = db
    .prepare(
      `SELECT r.* FROM match_results r ${whereClause}
       ORDER BY r.device_priority_rank ASC NULLS LAST, r.id_pedido ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as unknown as MatchResultRow[];
  return { results, total };
}

/** Resultados de linhas para um aparelho específico (com concat_peca do legado). */
export function getLineResultsForDevice(
  db: Db,
  runId: number,
  deviceResultId: number,
): (MatchResultRow & { concat_peca: string | null })[] {
  return db
    .prepare(
      `SELECT r.*, sop.concat_peca
       FROM match_results r
       JOIN source_order_parts sop ON sop.id = r.source_order_part_id
       WHERE r.match_run_id = ? AND r.device_result_id = ?
       ORDER BY r.id_pedido`,
    )
    .all(runId, deviceResultId) as unknown as (MatchResultRow & { concat_peca: string | null })[];
}

/** Insere uma linha em match_stock_results. */
export function insertStockResult(
  db: Db,
  runId: number,
  row: {
    chavePeca: string | null;
    chavePecaNorm: string;
    reference: string;
    referenceNorm: string;
    initialQuantity: number;
    allocatedFull: number;
    allocatedPartial: number;
    remainingQuantity: number;
  },
): void {
  db.prepare(
    `INSERT INTO match_stock_results
       (match_run_id, chave_peca, chave_peca_norm, reference, reference_norm,
        initial_quantity, allocated_full, allocated_partial, remaining_quantity)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    runId,
    row.chavePeca,
    row.chavePecaNorm,
    row.reference,
    row.referenceNorm,
    row.initialQuantity,
    row.allocatedFull,
    row.allocatedPartial,
    row.remainingQuantity,
  );
}

/** Resumo de estoque por CHAVEPECA — lê de match_stock_results (inclui itens sem demanda). */
export function getStockSummaryFromResults(
  db: Db,
  runId: number,
): Array<{
  chave_peca_norm: string;
  chave_peca: string | null;
  stock_initial: number;
  allocated_full: number;
  allocated_partial: number;
  allocated_total: number;
  remaining: number;
}> {
  return db
    .prepare(
      `SELECT
         chave_peca_norm,
         MAX(chave_peca) AS chave_peca,
         SUM(initial_quantity)  AS stock_initial,
         SUM(allocated_full)    AS allocated_full,
         SUM(allocated_partial) AS allocated_partial,
         SUM(allocated_full + allocated_partial) AS allocated_total,
         SUM(remaining_quantity) AS remaining
       FROM match_stock_results
       WHERE match_run_id = ?
       GROUP BY chave_peca_norm
       ORDER BY chave_peca_norm`,
    )
    .all(runId) as unknown as ReturnType<typeof getStockSummaryFromResults>;
}

/** Dados de comparação com o legado para um run. */
export function getComparisonData(
  db: Db,
  runId: number,
  params: ListResultsParams = {},
): { results: MatchResultRow[]; total: number } {
  const where: string[] = ["r.match_run_id = ?"];
  const args: (string | number | null)[] = [runId];

  if (params.status) {
    where.push("r.result_status = ?");
    args.push(params.status);
  }
  if (params.search) {
    where.push("(r.id_pedido LIKE ? OR r.imei LIKE ? OR r.chave_peca_norm LIKE ?)");
    const p = `%${params.search}%`;
    args.push(p, p, p);
  }
  if (params.onlyDivergent) {
    // Comparação normalizada: remove acentos comparando tokens
    where.push(
      `(r.allocation_phase != 'PRESERVED'
        AND UPPER(REPLACE(REPLACE(REPLACE(REPLACE(r.result_status,'Ç','C'),'Ã','A'),'Á','A'),'É','E'))
            != UPPER(REPLACE(REPLACE(REPLACE(REPLACE(r.effective_status_before,'Ç','C'),'Ã','A'),'Á','A'),'É','E')))`,
    );
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM match_results r ${whereClause}`)
      .get(...args) as { c: number }
  ).c;

  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const results = db
    .prepare(
      `SELECT r.*, sop.status_kit_legado, sop.prioridade_kit_legado, sop.score_legado,
              sop.ordem_consumo_legada, sop.quantidade_estoque_legada
       FROM match_results r
       JOIN source_order_parts sop ON sop.id = r.source_order_part_id
       ${whereClause}
       ORDER BY r.id_pedido
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as unknown as MatchResultRow[];
  return { results, total };
}

// ---------------------------------------------------------------------------
// Comparação completa com legado (item 6/7 — normalização em TS)
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  id_pedido: string;
  imei: string | null;
  os: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  concat_peca: string | null;
  // Status
  legacy_status: string | null;
  effective_status_before: string | null;
  calculated_status: string | null;
  result_status_label: string | null;
  status_equal: boolean;
  // Kit status
  legacy_kit_status: string | null;
  calculated_kit_status: string | null;
  kit_status_equal: boolean;
  // Kit priority
  legacy_kit_priority: number | null;
  calculated_kit_priority: number | null;
  kit_priority_equal: boolean;
  // Score
  legacy_score: number | null;
  calculated_score: number;
  score_equal: boolean;
  // Consumption order
  legacy_consumption_order: number | null;
  calculated_consumption_order: number | null;
  consumption_order_equal: boolean;
  // Stock (informativo)
  legacy_stock_quantity: number | null;
  operational_stock_initial: number;
  stock_quantity_equal: boolean;
  // Match fields
  allocation_phase: string | null;
  reserved_units: number;
  allocated_reference: string | null;
  reason_code: string | null;
  warning_codes: string[];
  device_priority_rank: number | null;
}

export interface ComparisonSummary {
  totalLines: number;
  fullyEqualLines: number;
  divergentLines: number;
  statusDifferences: number;
  kitStatusDifferences: number;
  kitPriorityDifferences: number;
  scoreDifferences: number;
  consumptionOrderDifferences: number;
  stockQuantityDifferences: number;
}

function buildComparisonRow(
  r: MatchResultRow & {
    status_atual_legado: string | null;
    status_kit_legado: string | null;
    prioridade_kit_legado: number | null;
    score_legado: number | null;
    ordem_consumo_legada: number | null;
    quantidade_estoque_legada: number | null;
    concat_peca: string | null;
  },
): ComparisonRow {
  return {
    id_pedido: r.id_pedido,
    imei: r.imei,
    os: r.os,
    chave_peca: r.chave_peca,
    chave_peca_norm: r.chave_peca_norm,
    concat_peca: r.concat_peca,
    legacy_status: r.status_atual_legado,
    effective_status_before: r.effective_status_before,
    calculated_status: r.result_status,
    result_status_label: r.result_status_label,
    status_equal: normalizeStatus(r.status_atual_legado) === normalizeStatus(r.result_status),
    legacy_kit_status: r.status_kit_legado,
    calculated_kit_status: r.kit_status,
    kit_status_equal: normalizeStatus(r.status_kit_legado) === normalizeStatus(r.kit_status),
    legacy_kit_priority: r.prioridade_kit_legado,
    calculated_kit_priority: r.kit_priority,
    kit_priority_equal: r.prioridade_kit_legado === r.kit_priority,
    legacy_score: r.score_legado,
    calculated_score: r.score,
    score_equal: r.score_legado === r.score,
    legacy_consumption_order: r.ordem_consumo_legada,
    calculated_consumption_order: r.ordem_consumo,
    consumption_order_equal: r.ordem_consumo_legada === r.ordem_consumo,
    legacy_stock_quantity: r.quantidade_estoque_legada,
    operational_stock_initial: r.stock_for_key_initial,
    stock_quantity_equal: r.quantidade_estoque_legada === r.stock_for_key_initial,
    allocation_phase: r.allocation_phase,
    reserved_units: r.reserved_units,
    allocated_reference: r.allocated_reference,
    reason_code: r.reason_code,
    warning_codes: JSON.parse((r.warning_codes_json as string) || "[]") as string[],
    device_priority_rank: r.device_priority_rank,
  };
}

/**
 * Comparação completa com legado — normalização feita em TS (não SQL).
 * Suporta filtro divergente em todos os campos operacionais, não só status.
 */
export function getFullComparisonData(
  db: Db,
  runId: number,
  params: { limit?: number; offset?: number; onlyDivergent?: boolean; search?: string } = {},
): { rows: ComparisonRow[]; total: number; summary: ComparisonSummary } {
  type JoinedResultRow = MatchResultRow & {
    status_atual_legado: string | null;
    status_kit_legado: string | null;
    prioridade_kit_legado: number | null;
    score_legado: number | null;
    ordem_consumo_legada: number | null;
    quantidade_estoque_legada: number | null;
    concat_peca: string | null;
  };
  const rawRows = db
    .prepare(
      `SELECT r.*,
              sop.status_atual_legado, sop.status_kit_legado, sop.prioridade_kit_legado,
              sop.score_legado, sop.ordem_consumo_legada, sop.quantidade_estoque_legada,
              sop.concat_peca
       FROM match_results r
       JOIN source_order_parts sop ON sop.id = r.source_order_part_id
       WHERE r.match_run_id = ?
       ORDER BY r.id_pedido`,
    )
    .all(runId) as unknown as JoinedResultRow[];

  const allRows = rawRows.map(buildComparisonRow);

  // Filtro de busca
  let filtered = allRows;
  if (params.search) {
    const s = params.search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.id_pedido.toLowerCase().includes(s) ||
        (r.imei && r.imei.toLowerCase().includes(s)) ||
        (r.chave_peca_norm && r.chave_peca_norm.includes(s)) ||
        (r.concat_peca && r.concat_peca.toLowerCase().includes(s)),
    );
  }

  // Filtro divergente — considera todos os campos operacionais
  if (params.onlyDivergent) {
    filtered = filtered.filter(
      (r) =>
        !r.status_equal ||
        !r.kit_status_equal ||
        !r.kit_priority_equal ||
        !r.score_equal ||
        !r.consumption_order_equal,
    );
  }

  // Resumo sempre calculado sobre TODAS as linhas (antes do filtro de paginação)
  const isDivergent = (r: ComparisonRow) =>
    !r.status_equal || !r.kit_status_equal || !r.kit_priority_equal ||
    !r.score_equal || !r.consumption_order_equal;

  const summary: ComparisonSummary = {
    totalLines: allRows.length,
    fullyEqualLines: allRows.filter((r) => !isDivergent(r)).length,
    divergentLines: allRows.filter(isDivergent).length,
    statusDifferences: allRows.filter((r) => !r.status_equal).length,
    kitStatusDifferences: allRows.filter((r) => !r.kit_status_equal).length,
    kitPriorityDifferences: allRows.filter((r) => !r.kit_priority_equal).length,
    scoreDifferences: allRows.filter((r) => !r.score_equal).length,
    consumptionOrderDifferences: allRows.filter((r) => !r.consumption_order_equal).length,
    stockQuantityDifferences: allRows.filter((r) => !r.stock_quantity_equal).length,
  };

  const total = filtered.length;
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const rows = filtered.slice(offset, offset + limit);

  return { rows, total, summary };
}

/** Exporta resultados como CSV (sem LIMIT — exportação completa). */
export function exportResultsCsv(db: Db, runId: number, onlyDivergent = false): string {
  // Busca direta sem paginação; onlyDivergent normalizado via TS como em getFullComparisonData.
  type JoinedResultRow = MatchResultRow & {
    status_atual_legado: string | null;
    status_kit_legado: string | null;
    prioridade_kit_legado: number | null;
    score_legado: number | null;
    ordem_consumo_legada: number | null;
    quantidade_estoque_legada: number | null;
    concat_peca: string | null;
  };
  const allRows = db
    .prepare(
      `SELECT r.*,
              sop.status_atual_legado, sop.status_kit_legado, sop.prioridade_kit_legado,
              sop.score_legado, sop.ordem_consumo_legada, sop.quantidade_estoque_legada,
              sop.concat_peca
       FROM match_results r
       JOIN source_order_parts sop ON sop.id = r.source_order_part_id
       WHERE r.match_run_id = ?
       ORDER BY r.id_pedido`,
    )
    .all(runId) as unknown as JoinedResultRow[];

  const rows = onlyDivergent
    ? allRows.filter(
        (r) =>
          normalizeStatus(r.status_atual_legado) !== normalizeStatus(r.result_status) ||
          normalizeStatus(r.status_kit_legado) !== normalizeStatus(r.kit_status) ||
          r.prioridade_kit_legado !== r.kit_priority ||
          r.score_legado !== r.score ||
          r.ordem_consumo_legada !== r.ordem_consumo,
      )
    : allRows;

  const header = [
    "id_pedido", "imei", "os", "chave_peca", "concat_peca",
    "status_legado", "status_efetivo_antes", "status_calculado",
    "kit_status_legado", "kit_status_calculado",
    "prioridade_kit_legado", "prioridade_kit_calculado",
    "score_legado", "score_calculado",
    "ordem_legada", "ordem_calculada",
    "estoque_legado", "estoque_operacional_inicial",
    "allocated_reference", "allocation_phase", "reserved_units",
    "reason_code", "warning_codes", "device_priority_rank",
  ];

  const dataRows = rows.map((r) =>
    [
      r.id_pedido,
      r.imei ?? "",
      r.os ?? "",
      r.chave_peca ?? "",
      r.concat_peca ?? "",
      r.status_atual_legado ?? "",
      r.effective_status_before ?? "",
      r.result_status ?? "",
      r.status_kit_legado ?? "",
      r.kit_status ?? "",
      r.prioridade_kit_legado ?? "",
      r.kit_priority ?? "",
      r.score_legado ?? "",
      r.score,
      r.ordem_consumo_legada ?? "",
      r.ordem_consumo ?? "",
      r.quantidade_estoque_legada ?? "",
      r.stock_for_key_initial,
      r.allocated_reference ?? "",
      r.allocation_phase ?? "",
      r.reserved_units,
      r.reason_code ?? "",
      JSON.parse((r.warning_codes_json as string) || "[]").join("|"),
      r.device_priority_rank ?? "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );

  return [header.join(","), ...dataRows].join("\n");
}
