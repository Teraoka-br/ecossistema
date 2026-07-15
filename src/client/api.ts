import type {
  CountScan,
  CountSession,
  DiagnosticReport,
  FinalizeSummary,
  ImportPreview,
  ImportResult,
  InventoryGroup,
  InventoryItem,
  DeviceGroup,
  PendingReferenceGroup,
  Quotation,
} from "../shared/types.js";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function previewImport(ordersFile: File, analysisFile: File): Promise<ImportPreview> {
  const fd = new FormData();
  fd.append("ordersFile", ordersFile);
  fd.append("analysisFile", analysisFile);
  const res = await fetch("/api/importar/preview", { method: "POST", body: fd });
  return handle<ImportPreview>(res);
}

export async function confirmImport(previewBatchId: number): Promise<ImportResult> {
  const res = await fetch("/api/importar/confirmar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewBatchId }),
  });
  return handle<ImportResult>(res);
}

export interface PedidosResponse {
  batchId: number | null;
  statuses: string[];
  devices: DeviceGroup[];
  totalParts: number;
}
export async function getPedidos(search: string, status: string): Promise<PedidosResponse> {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  if (status) qs.set("status", status);
  return handle<PedidosResponse>(await fetch(`/api/pedidos?${qs.toString()}`));
}

export interface OfficialStockGroup {
  referencia: string;
  chavePeca: string | null;
  unidades: number;
  mapeada: boolean;
}
export interface OfficialStock {
  snapshotId: number;
  sessionId: number;
  createdAt: string;
  createdBy: string | null;
  totalUnits: number;
  comparisonBatchId: number | null;
  responsibleName: string;
  groups: OfficialStockGroup[];
}
export interface OperationalStockGroupSummary {
  referencia: string;
  chavePeca: string | null;
  baseQuantity: number;
  movementQuantity: number;
  currentQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  mapeada: boolean;
}
export interface EstoqueResponse {
  origin: "LEGACY" | "OFFICIAL";
  batchId: number | null;
  legacy: { totalUnits: number; groups: InventoryGroup[]; items: InventoryItem[] };
  official: OfficialStock | null;
  operational: {
    base: { type: "INITIAL_IMPORT" | "OFFICIAL_SNAPSHOT"; createdAt: string | null; totalUnits: number };
    baseTotal: number;
    movementsTotal: number;
    currentTotal: number;
    groups: OperationalStockGroupSummary[];
  };
}
export async function getEstoque(search: string): Promise<EstoqueResponse> {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  return handle<EstoqueResponse>(await fetch(`/api/estoque?${qs.toString()}`));
}

export interface CotacoesResponse {
  batchId: number | null;
  quotations: Quotation[];
}
export async function getCotacoes(search: string): Promise<CotacoesResponse> {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  return handle<CotacoesResponse>(await fetch(`/api/cotacoes?${qs.toString()}`));
}

export async function getDiagnostico(): Promise<DiagnosticReport> {
  return handle<DiagnosticReport>(await fetch("/api/diagnostico"));
}

// ===========================================================================
// Bipagem
// ===========================================================================

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

export async function getActiveSession(): Promise<CountSession | null> {
  const r = await handle<{ session: CountSession | null }>(await fetch("/api/count-sessions/active"));
  return r.session;
}

export async function createCountSession(responsibleName: string, notes?: string, countType?: "OFICIAL" | "PARCIAL_TESTE"): Promise<CountSession> {
  const r = await postJson<{ session: CountSession }>("/api/count-sessions", { responsibleName, notes, countType });
  return r.session;
}

export async function cancelCountSession(id: number, cancelledBy: string, cancelReason: string): Promise<CountSession> {
  const r = await postJson<{ session: CountSession }>(`/api/count-sessions/${id}/cancel`, { cancelledBy, cancelReason });
  return r.session;
}

export async function registerScan(
  sessionId: number,
  reference: string,
): Promise<{ scan: CountScan; totalForReference: number }> {
  return postJson(`/api/count-sessions/${sessionId}/scans`, { reference });
}

export async function listScans(sessionId: number, limit = 30): Promise<CountScan[]> {
  const r = await handle<{ scans: CountScan[] }>(
    await fetch(`/api/count-sessions/${sessionId}/scans?limit=${limit}`),
  );
  return r.scans;
}

export async function cancelScan(scanId: number, cancelledBy: string, cancelReason: string): Promise<CountScan> {
  const r = await postJson<{ scan: CountScan }>(`/api/count-scans/${scanId}/cancel`, { cancelledBy, cancelReason });
  return r.scan;
}

export async function getSummary(sessionId: number): Promise<FinalizeSummary> {
  return handle<FinalizeSummary>(await fetch(`/api/count-sessions/${sessionId}/summary`));
}

export interface SessionState {
  session: CountSession;
  summary: FinalizeSummary;
  recentScans: CountScan[];
  totalsByReference: { referenceNorm: string; reference: string; total: number; chavePeca: string | null; chavePecaNorm: string | null }[];
  pending: PendingReferenceGroup[];
}
/** Estado consolidado da sessão — autoridade única (sobrevive a F5/reinício). */
export async function getSessionState(sessionId: number): Promise<SessionState> {
  return handle<SessionState>(await fetch(`/api/count-sessions/${sessionId}/state`));
}

export async function getPending(sessionId: number): Promise<PendingReferenceGroup[]> {
  const r = await handle<{ pending: PendingReferenceGroup[] }>(
    await fetch(`/api/count-sessions/${sessionId}/pending`),
  );
  return r.pending;
}

/** Catálogo de CHAVEPECA vinculado à SESSÃO (não ao lote ativo mais recente). */
export async function getSessionCatalogKeys(
  sessionId: number,
  search?: string,
): Promise<{ chavePeca: string; referencia: string }[]> {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  const r = await handle<{ keys: { chavePeca: string; referencia: string }[] }>(
    await fetch(`/api/count-sessions/${sessionId}/reference-catalog/keys?${qs.toString()}`),
  );
  return r.keys;
}

export async function resolveReference(
  sessionId: number,
  referenceNorm: string,
  chavePeca: string,
  responsibleName: string,
  notes?: string,
  createIfMissing?: boolean,
): Promise<void> {
  await postJson(`/api/count-sessions/${sessionId}/references/resolve`, {
    referenceNorm,
    chavePeca,
    responsibleName,
    notes,
    createIfMissing,
  });
}

export async function cancelPendingScans(
  sessionId: number,
  referenceNorm: string,
  cancelledBy: string,
  cancelReason: string,
): Promise<number> {
  const r = await postJson<{ cancelled: number }>(`/api/count-sessions/${sessionId}/references/cancel-scans`, {
    referenceNorm,
    cancelledBy,
    cancelReason,
  });
  return r.cancelled;
}

export interface FinalizeRequest {
  finalizedBy: string;
  forceIncomplete?: boolean;
  forceReason?: string;
}
export interface FinalizeResponse {
  snapshot: { id: number; totalUnits: number; createdAt: string };
  summary: FinalizeSummary;
  alreadyFinalized: boolean;
}
export async function finalizeSession(sessionId: number, req: FinalizeRequest): Promise<FinalizeResponse> {
  return postJson(`/api/count-sessions/${sessionId}/finalize`, req);
}

export async function getLatestSnapshot(): Promise<import("../shared/types.js").StockSnapshot | null> {
  const r = await handle<{ snapshot: import("../shared/types.js").StockSnapshot | null }>(
    await fetch("/api/stock-snapshots/latest"),
  );
  return r.snapshot;
}

// ===========================================================================
// Inicialização do sistema / compras / recebimento / estoque operacional
// ===========================================================================

export interface SystemState {
  id: number;
  initialized: number;
  initial_import_batch_id: number | null;
  initialized_at: string | null;
  initialized_by: string | null;
  operational_started_at: string | null;
}
export async function getImportState(): Promise<{ state: SystemState; allowLegacyReimport: boolean }> {
  return handle(await fetch("/api/importar/state"));
}

export interface PurchaseRequest {
  id: number;
  source_quotation_id: number | null;
  id_pedido: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  referencia: string | null;
  quantidade: number | null;
  valor_unitario: number | null;
  valor_total: number | null;
  origin_status: string | null;
  status: "APPROVED" | "ORDERED" | "CANCELLED";
}
export async function getPurchaseRequests(status?: string): Promise<PurchaseRequest[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const r = await handle<{ requests: PurchaseRequest[] }>(await fetch(`/api/purchase-requests${qs}`));
  return r.requests;
}

export interface PurchaseOrderItem {
  id: number;
  purchase_order_id: number;
  purchase_request_id: number | null;
  referencia: string;
  chave_peca: string | null;
  quantity_ordered: number;
  quantity_received: number;
}
export interface PurchaseOrder {
  id: number;
  order_number: string;
  supplier: string | null;
  status: "AWAITING_RECEIPT" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";
  notes: string | null;
  created_at: string;
  created_by: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  items: PurchaseOrderItem[];
}
export async function getPurchaseOrders(status?: string): Promise<PurchaseOrder[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const r = await handle<{ orders: PurchaseOrder[] }>(await fetch(`/api/purchase-orders${qs}`));
  return r.orders;
}

export async function createPurchaseOrder(input: {
  supplier?: string | null;
  notes?: string | null;
  items: { purchaseRequestId?: number | null; referencia: string; chavePeca?: string | null; quantity: number }[];
}): Promise<PurchaseOrder> {
  const r = await postJson<{ order: PurchaseOrder }>("/api/purchase-orders", input);
  return r.order;
}

export async function cancelPurchaseOrder(id: number, cancelReason: string): Promise<PurchaseOrder> {
  const r = await postJson<{ order: PurchaseOrder }>(`/api/purchase-orders/${id}/cancel`, { cancelReason });
  return r.order;
}

export interface ReceivePreviewLine {
  purchaseOrderItemId: number;
  referencia: string;
  chavePeca: string | null;
  quantityOrdered: number;
  alreadyReceived: number;
  remaining: number;
  receivingNow: number;
  over: boolean;
}
export async function previewReceipt(
  orderId: number,
  items: { purchaseOrderItemId: number; quantity: number }[],
): Promise<{ orderId: number; orderNumber: string; lines: ReceivePreviewLine[]; anyOverReceipt: boolean }> {
  return postJson(`/api/purchase-orders/${orderId}/receipts/preview`, { items });
}

export async function confirmReceipt(
  orderId: number,
  input: {
    notes?: string | null;
    allowOverReceipt?: boolean;
    justification?: string | null;
    items: { purchaseOrderItemId: number; quantity: number }[];
  },
): Promise<{ receiptId: number; order: PurchaseOrder; movementsCreated: number; unitsReceived: number }> {
  return postJson(`/api/purchase-orders/${orderId}/receipts/confirm`, input);
}

export async function addToPurchase(repairCaseId: number): Promise<{ partIds: number[]; created: number; existing: number; total: number }> {
  return postJson(`/api/fila-reparos/${repairCaseId}/add-to-purchase`, {});
}

export interface OperationalStockGroup {
  referencia: string;
  chavePeca: string | null;
  baseQuantity: number;
  movementQuantity: number;
  currentQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  mapeada: boolean;
}
export interface OperationalStock {
  base: { type: "INITIAL_IMPORT" | "OFFICIAL_SNAPSHOT"; snapshotId: number | null; createdAt: string | null; totalUnits: number };
  baseTotal: number;
  movementsTotal: number;
  currentTotal: number;
  groups: OperationalStockGroup[];
}
export async function getCurrentStock(): Promise<OperationalStock> {
  return handle(await fetch("/api/stock/current"));
}

export interface StockMovement {
  id: number;
  movement_type: string;
  referencia: string;
  chave_peca: string | null;
  quantity: number;
  source_type: string | null;
  created_by: string | null;
  created_at: string;
  notes: string | null;
}
export async function getStockMovements(filters: { type?: string; search?: string } = {}): Promise<StockMovement[]> {
  const qs = new URLSearchParams();
  if (filters.type) qs.set("type", filters.type);
  if (filters.search) qs.set("search", filters.search);
  const r = await handle<{ movements: StockMovement[] }>(await fetch(`/api/stock/movements?${qs.toString()}`));
  return r.movements;
}

// ===========================================================================
// Separação operacional
// ===========================================================================

export type SeparationBatchStatus = "OPEN" | "PARTIALLY_COMPLETED" | "COMPLETED" | "CANCELLED";
export type SeparationItemStatus = "RESERVED" | "CONFIRMED" | "CANCELLED";

export interface SeparationBatch {
  id: number;
  batch_number: string;
  match_run_id: number;
  status: SeparationBatchStatus;
  idempotency_key: string;
  created_by: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeparationItem {
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
  confirmed_notes: string | null;
  confirm_idempotency_key: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  stock_movement_id: number | null;
  operational_event_id: number | null;
}

export interface DeviceSeparationGroup {
  deviceResultId: number;
  imei: string | null;
  os: string | null;
  allocationPhase: string;
  items: SeparationItem[];
}

export interface BatchTotals {
  totalItems: number;
  reservedItems: number;
  confirmedItems: number;
  cancelledItems: number;
  totalDevices: number;
  completedDevices: number;
}

export interface SeparationBatchState {
  batch: SeparationBatch;
  totals: BatchTotals;
  devices: DeviceSeparationGroup[];
  partialItems: SeparationItem[];
  warnings: string[];
}

export interface ListSeparationBatchesResult {
  batches: SeparationBatch[];
  total: number;
  limit: number;
  offset: number;
}

export async function listSeparationBatches(params: {
  status?: SeparationBatchStatus;
  batchNumber?: string;
  matchRunId?: number;
  limit?: number;
  offset?: number;
} = {}): Promise<ListSeparationBatchesResult> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.batchNumber) qs.set("batchNumber", params.batchNumber);
  if (params.matchRunId != null) qs.set("matchRunId", String(params.matchRunId));
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  return handle(await fetch(`/api/separation-batches?${qs.toString()}`));
}

export async function getSeparationBatchState(batchId: number): Promise<SeparationBatchState> {
  return handle(await fetch(`/api/separation-batches/${batchId}/state`));
}

export async function createSeparationBatch(input: {
  createdBy: string;
  notes?: string | null;
  fullDeviceResultIds: number[];
  partialMatchResultIds: number[];
  idempotencyKey: string;
  matchRunId: number;
}): Promise<{ batch: SeparationBatch }> {
  return postJson(`/api/separation-batches`, input);
}

export async function confirmSeparationAll(batchId: number, input: {
  confirmedBy: string;
  notes?: string | null;
  idempotencyKey: string;
}): Promise<{ message: string; state: SeparationBatchState }> {
  return postJson(`/api/separation-batches/${batchId}/confirm-all`, input);
}

export async function cancelSeparationBatch(batchId: number, input: {
  cancelledBy: string;
  cancelReason: string;
}): Promise<{ batch: SeparationBatch }> {
  return postJson(`/api/separation-batches/${batchId}/cancel`, input);
}

export async function confirmSeparationDevice(batchId: number, deviceResultId: number, input: {
  confirmedBy: string;
  notes?: string | null;
  idempotencyKey: string;
}): Promise<{ message: string; state: SeparationBatchState }> {
  return postJson(`/api/separation-batches/${batchId}/devices/${deviceResultId}/confirm`, input);
}

export async function cancelSeparationDevice(batchId: number, deviceResultId: number, input: {
  cancelledBy: string;
  cancelReason: string;
}): Promise<{ message: string; state: SeparationBatchState }> {
  return postJson(`/api/separation-batches/${batchId}/devices/${deviceResultId}/cancel`, input);
}

export async function confirmSeparationItem(itemId: number, input: {
  confirmedBy: string;
  notes?: string | null;
  idempotencyKey: string;
}): Promise<{ item: SeparationItem }> {
  return postJson(`/api/separation-items/${itemId}/confirm`, input);
}

export async function cancelSeparationItem(itemId: number, input: {
  cancelledBy: string;
  cancelReason: string;
}): Promise<{ item: SeparationItem }> {
  return postJson(`/api/separation-items/${itemId}/cancel`, input);
}
