/**
 * Tipos internos do módulo de separação operacional.
 * Não contém lógica — apenas estruturas de dados.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SeparationBatchStatus = "OPEN" | "PARTIALLY_COMPLETED" | "COMPLETED" | "CANCELLED";
export type SeparationItemStatus = "RESERVED" | "CONFIRMED" | "CANCELLED";

// ---------------------------------------------------------------------------
// Linhas do banco (lidas via SQL)
// ---------------------------------------------------------------------------

export interface SeparationBatchRow {
  id: number;
  batch_number: string;
  match_run_id: number;
  status: SeparationBatchStatus;
  idempotency_key: string;
  created_by: string;
  created_at: string;
  notes: string | null;
  completed_at: string | null;
  completed_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  updated_at: string;
}

export interface SeparationItemRow {
  id: number;
  separation_batch_id: number;
  match_run_id: number;
  match_result_id: number;
  match_device_result_id: number | null;
  source_order_part_id: number;
  id_pedido: string;
  imei: string | null;
  os: string | null;
  description: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  reference: string | null;
  reference_norm: string | null;
  quantity: number;
  match_result_status: string | null;
  match_allocation_phase: string | null;
  match_consumption_order: number | null;
  status: SeparationItemStatus;
  reserved_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirmation_notes: string | null;
  confirmation_idempotency_key: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  stock_movement_id: number | null;
  operational_event_id: number | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Inputs de serviço
// ---------------------------------------------------------------------------

export interface CreateSeparationBatchInput {
  createdBy: string;
  notes?: string | null;
  /** IDs de match_device_results com allocation_phase = FULL */
  fullDeviceResultIds?: number[];
  /** IDs de match_results com allocation_phase = PARTIAL */
  partialMatchResultIds?: number[];
  idempotencyKey: string;
  /** ID do match_run a usar (obrigatório) */
  matchRunId: number;
}

export interface ConfirmItemInput {
  itemId: number;
  confirmedBy: string;
  notes?: string | null;
  idempotencyKey: string;
}

export interface ConfirmDeviceInput {
  batchId: number;
  deviceResultId: number;
  confirmedBy: string;
  notes?: string | null;
  idempotencyKey: string;
}

export interface ConfirmAllInput {
  batchId: number;
  confirmedBy: string;
  notes?: string | null;
  idempotencyKey: string;
}

export interface CancelItemInput {
  itemId: number;
  cancelledBy: string;
  cancelReason: string;
}

export interface CancelDeviceInput {
  batchId: number;
  deviceResultId: number;
  cancelledBy: string;
  cancelReason: string;
}

export interface CancelBatchInput {
  batchId: number;
  cancelledBy: string;
  cancelReason: string;
}

// ---------------------------------------------------------------------------
// Saídas estruturadas
// ---------------------------------------------------------------------------

export interface BatchTotals {
  totalItems: number;
  reservedItems: number;
  confirmedItems: number;
  cancelledItems: number;
  totalDevices: number;
  completedDevices: number;
}

export interface SeparationBatchState {
  batch: SeparationBatchRow;
  totals: BatchTotals;
  devices: DeviceSeparationGroup[];
  partialItems: SeparationItemRow[];
  traceability: TraceabilityInfo;
  warnings: string[];
}

export interface DeviceSeparationGroup {
  deviceResultId: number | null;
  imei: string | null;
  os: string | null;
  kitStatus: string | null;
  priorityRank: number | null;
  allocationPhase: string | null;
  items: SeparationItemRow[];
  allConfirmed: boolean;
  allCancelled: boolean;
  hasReserved: boolean;
}

export interface TraceabilityInfo {
  matchRunId: number;
  batchId: number;
  batchNumber: string;
  /** IDs internos para navegação */
  separationItemIds: number[];
  matchResultIds: number[];
  sourceOrderPartIds: number[];
  stockMovementIds: number[];
  operationalEventIds: number[];
}

// ---------------------------------------------------------------------------
// Filtros de listagem
// ---------------------------------------------------------------------------

export interface ListSeparationBatchesParams {
  status?: SeparationBatchStatus;
  batchNumber?: string;
  createdBy?: string;
  imei?: string;
  os?: string;
  idPedido?: string;
  matchRunId?: number;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}
