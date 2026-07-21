export interface CardCounts {
  match: number;
  matchParcial: number;
  aptoReparo: number;
  verificar: number;
  emAnalise: number;
  aguardandoPeca: number;
  comTecnico: number;
  vendaEstado: number;
  finalizados: number;
  total: number;
}

export interface StockSummary {
  totalUnits: number;
  totalReferences: number;
  availableUnits: number;
  reservedUnits: number;
  baseType: "OFFICIAL_SNAPSHOT" | "INITIAL_IMPORT";
  lastSnapshotId: number | null;
  lastSnapshotAt: string | null;
  lastSnapshotBy: string | null;
}

export interface Panorama {
  activeCases: number;
  uniqueImeis: number;
  stockUnits: number;
  stockReferences: number;
  availableUnits: number;
  reservedUnits: number;
  pendingPurchaseOrders: number;
  possibleRepairsNow: number;
  lastOfficialCount: string | null;
  lastUpdatedAt: string;
}

export interface TechnicianCases {
  technicianId: number | null;
  technicianName: string;
  totalCases: number;
  uniqueImeis: number;
  inRepair: number;
  oldestCaseDate: string | null;
  lastMovement: string | null;
}

export interface CountingSession {
  id: number;
  responsibleName: string | null;
  countType: string | null;
  totalScanned: number;
  finalizedAt: string | null;
}

export interface CountingDaySummary {
  date: string;
  sessionCount: number;
  totalScanned: number;
  isWeekday: boolean;
  justification: string | null;
  sessions: CountingSession[];
}

export interface CountingBlockData {
  days: CountingDaySummary[];
  currentStreak: number;
  streakStatus: "ok" | "warn" | "late";
  lastSession: CountingSession & { finalizedAt: string | null } | null;
}

export interface OperationalAlert {
  code: string;
  title: string;
  description: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  count: number;
  suggestedAction: string;
  route?: string;
}

export interface IssueReport {
  id: number;
  title: string;
  description: string | null;
  module: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "IN_ANALYSIS" | "RESOLVED" | "DISMISSED";
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

export interface IssueSummary {
  openCount: number;
  criticalCount: number;
  recent: IssueReport[];
  resolved: IssueReport[];
}

export interface FinancialSlice {
  totalCost: number | null;
  totalSale: number | null;
  totalMargin: number | null;
  caseCount: number;
}

export interface FinancialData {
  active: FinancialSlice;
  withTechnician: FinancialSlice;
  waitingPart: FinancialSlice;
  concludedThisMonth: FinancialSlice;
  lostThisMonth: FinancialSlice;
}

export interface FinancialByBucket {
  match:          FinancialSlice;
  matchParcial:   FinancialSlice;
  aptoReparo:     FinancialSlice;
  verificar:      FinancialSlice;
  emAnalise:      FinancialSlice;
  aguardandoPeca: FinancialSlice;
  comTecnico:     FinancialSlice;
  vendaEstado:    FinancialSlice;
  finalizados:    FinancialSlice;
}

export interface HomeData {
  current: CardCounts;
  comparison: Partial<CardCounts> | null;
  stock: StockSummary;
  panorama: Panorama;
  technicians: TechnicianCases[];
  counting: CountingBlockData;
  alerts: OperationalAlert[];
  recentIssues: IssueSummary;
  financial: FinancialData;
  financialByBucket: FinancialByBucket;
  lastUpdatedAt: string;
  _queryMs: number;
}

export type CardMetric = keyof CardCounts;

export const CARD_LABELS: Record<CardMetric, string> = {
  match: "Match",
  matchParcial: "Parcial",
  aptoReparo: "Apto reparo",
  verificar: "Verificar",
  emAnalise: "Em analise",
  aguardandoPeca: "Aguardando peca",
  comTecnico: "Com tecnico",
  vendaEstado: "Venda estado",
  finalizados: "Finalizados",
  total: "Todos",
};
