/**
 * Tipos compartilhados entre backend e frontend.
 * Mantidos sem dependências para poder ser importados dos dois lados.
 */

export type IssueSeverity = "ERROR" | "WARNING" | "CONFLICT";

export type EntityType =
  | "ORDER_PART"
  | "INVENTORY_ITEM"
  | "QUOTATION"
  | "ORDER_ANALYSIS";

export interface ImportIssue {
  fileName: string;
  sheetName: string | null;
  rowNumber: number | null;
  entityType: EntityType | null;
  entityKey: string | null;
  severity: IssueSeverity;
  code: string;
  message: string;
  rawValue: string | null;
}

export type BatchStatus =
  | "PREVIEW"
  | "COMPLETED"
  | "COMPLETED_WITH_WARNINGS"
  | "FAILED";

/** Resultado da etapa de pré-visualização da importação. */
export interface ImportPreview {
  previewBatchId: number;
  analysisFileName: string;
  ordersFileName: string;
  analysisFileHash: string;
  ordersFileHash: string;
  /** Quando os mesmos arquivos já foram importados (idempotência). */
  alreadyImported: boolean;
  existingBatchId: number | null;
  /** Pode confirmar? Falso quando há erros estruturais fatais. */
  canConfirm: boolean;
  /** Quantidade de ocorrências fatais (que bloqueiam a confirmação). */
  fatalIssuesCount: number;
  sheets: {
    fileName: string;
    sheetNames: string[];
    detected: DetectedTable[];
  }[];
  counts: {
    ordersFound: number;
    ordersValid: number;
    inventoryFound: number;
    inventoryValid: number;
    quotationsFound: number;
    quotationsValid: number;
    analysisFound: number;
    analysisValid: number;
  };
  /** Duração da pré-visualização (detecção + mapeamento), em milissegundos. */
  durationMs: number;
  issues: ImportIssue[];
  issueSummary: Record<string, number>;
}

export interface DetectedTable {
  role: TableRole;
  sheetName: string;
  headerRow: number;
  matchedHeaders: string[];
  missingRequired: string[];
}

export type TableRole =
  | "ORDERS"
  | "INVENTORY"
  | "QUOTATIONS"
  | "ANALYSIS"
  | "ORDERS_SECONDARY";

export interface ImportResult {
  batchId: number;
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
  alreadyImported: boolean;
}

/** Linha de pedido (peça solicitada para um aparelho). */
export interface OrderPart {
  id: number;
  idPedido: string;
  imei: string | null;
  os: string | null;
  concatPeca: string | null;
  chavePeca: string | null;
  referencia: string | null;
  statusAtual: string | null;
  statusAtualLabel: string | null;
  statusKit: string | null;
  prioridadeKit: number | null;
  quantidadePecasAparelho: number | null;
  idade: number | null;
  custo: number | null;
  venda: number | null;
  margem: number | null;
  notaIdade: number | null;
  notaMargem: number | null;
  score: number | null;
  ordemConsumo: number | null;
  quantidadeEstoque: number | null;
  pecasSemEstoque: number | null;
}

/** Aparelho agrupado por IMEI com suas peças. */
export interface DeviceGroup {
  imei: string | null;
  /** Chave de agrupamento (IMEI, ou ID_PEDIDO quando o IMEI for nulo). */
  groupKey: string;
  /** OS distintas observadas nas peças deste aparelho. */
  osValues: string[];
  /** Verdadeiro quando o mesmo IMEI aparece com OS diferentes (inconsistência). */
  osConflict: boolean;
  quantidadePecasAparelho: number | null;
  score: number | null;
  parts: OrderPart[];
}

export interface InventoryItem {
  id: number;
  idPecaEstoque: string | null;
  referencia: string | null;
  descricao: string | null;
  chavePeca: string | null;
  fornecedor: string | null;
  statusFisico: string | null;
}

/**
 * Estoque agrupado por (referência, chave). Uma mesma referência pode
 * aparecer em mais de um grupo — um para cada CHAVEPECA distinta, incluindo
 * um grupo "sem chave" (chavePeca null, mapeada false) quando houver
 * unidades sem CHAVEPECA. Nunca mistura unidades mapeadas e não-mapeadas
 * no mesmo grupo.
 */
export interface InventoryGroup {
  referencia: string | null;
  descricao: string | null;
  chavePeca: string | null;
  fornecedor: string | null;
  unidades: number;
  /** true quando o grupo tem CHAVEPECA preenchida (apto a alimentar o match futuro). */
  mapeada: boolean;
}

export interface Quotation {
  id: number;
  idPedido: string | null;
  chavePeca: string | null;
  quantidade: number | null;
  valorUnitario: number | null;
  valorTotal: number | null;
  dataCotacao: string | null;
  status: string | null;
}

export interface DiagnosticReport {
  batch: {
    id: number;
    status: BatchStatus;
    analysisFileName: string;
    ordersFileName: string;
    analysisFileHash: string;
    ordersFileHash: string;
    startedAt: string;
    finishedAt: string | null;
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
  } | null;
  issues: ImportIssue[];
  issueSummary: Record<string, number>;
}

// =========================================================================
// Bipagem operacional / snapshot oficial de estoque
// =========================================================================

export type CountSessionStatus = "OPEN" | "FINALIZED" | "CANCELLED";
export type ScanMappingStatus = "RECOGNIZED" | "UNKNOWN_REFERENCE" | "MISSING_KEY" | "CONFLICT";

export interface CountSession {
  id: number;
  importBatchId: number | null;
  responsibleName: string;
  status: CountSessionStatus;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  finalizedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  countType: "OFICIAL" | "PARCIAL_TESTE";
}

export interface CountScan {
  id: number;
  sessionId: number;
  reference: string;
  referenceNorm: string;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  mappingStatus: ScanMappingStatus;
  source: string | null;
  scannedAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
}

/** Pendência: referências bipadas que ainda precisam de resolução manual. */
export interface PendingReferenceGroup {
  referenceNorm: string;
  /** Valor original bipado mais recente (para exibição). */
  reference: string;
  mappingStatus: ScanMappingStatus;
  activeCount: number;
  firstScannedAt: string;
  lastScannedAt: string;
  /** Preenchido só quando mappingStatus === 'CONFLICT'. */
  conflictKeys: string[];
}

export interface FinalizeDifference {
  referenceNorm: string;
  reference: string;
  chavePeca: string | null;
  countedQuantity: number;
  legacyQuantity: number;
  difference: number;
}

export interface FinalizeSummary {
  totalScans: number;
  activeScans: number;
  cancelledScans: number;
  recognizedUnits: number;
  unknownUnits: number;
  missingKeyUnits: number;
  conflictUnits: number;
  distinctReferences: number;
  legacyTotalUnits: number;
  totalDifference: number;
  /** null quando não há base legada para comparar (ex.: lote sem unidades). */
  percentVsLegacy: number | null;
  differencesByReference: FinalizeDifference[];
  canFinalize: boolean;
  blockers: string[];
  warnings: string[];
}

export interface StockSnapshot {
  id: number;
  countSessionId: number;
  importBatchId: number | null;
  status: "OFFICIAL";
  totalUnits: number;
  createdAt: string;
  createdBy: string | null;
  notes: string | null;
}

export interface StockSnapshotItem {
  id: number;
  snapshotId: number;
  reference: string;
  referenceNorm: string;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  countedQuantity: number;
}

/** Regra de decisão configurável (margem/idade → score). */
export interface DecisionRule {
  id: number;
  name: string;
  active: boolean;
  ageDaysPerPoint: number;
  ageMaxPoints: number;
  marginPerPoint: number;
  marginAllowsNegative: boolean;
  createdAt: string;
}
