import type { Db } from "../db/database.js";

export interface CardCounts {
  match: number;
  matchParcial: number;
  aptoReparo: number;
  verificar: number;
  emAnalise: number;
  aguardandoPeca: number;
  comTecnico: number;
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

export interface TechnicianCases {
  technicianId: number | null;
  technicianName: string;
  totalCases: number;
  uniqueImeis: number;
  inRepair: number;
  oldestCaseDate: string | null;
  lastMovement: string | null;
}

export interface OverviewData {
  cards: CardCounts;
  cardComparison: Partial<CardCounts> | null;   // diferenÃ§a vs ontem
  stock: StockSummary;
  panorama: {
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
  };
  technicians: TechnicianCases[];
  lastUpdatedAt: string;
}

export function getDashboardOverview(db: Db): OverviewData {
  const now = new Date().toISOString();

  // â”€â”€ Cards: repair_cases + part_requests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  type WfRow = { workflow_status: string; c: number };
  const wfRows = db
    .prepare(
      `SELECT workflow_status, COUNT(*) as c
       FROM repair_cases GROUP BY workflow_status`,
    )
    .all() as WfRow[];
  const wf = new Map(wfRows.map((r) => [r.workflow_status, r.c]));

  type PrRow = { status: string; c: number };
  const prRows = db
    .prepare(
      `SELECT status, COUNT(*) as c
       FROM part_requests WHERE cancelled_at IS NULL GROUP BY status`,
    )
    .all() as PrRow[];
  const pr = new Map(prRows.map((r) => [r.status, r.c]));

  const aptoReparo =
    (wf.get("APTO_REPARO") ?? 0) +
    (wf.get("PECA_DISPONIVEL") ?? 0) +
    (wf.get("EM_SEPARACAO") ?? 0);
  const comTecnico =
    (wf.get("DIRECIONADO_TECNICO") ?? 0) +
    (wf.get("EM_REPARO") ?? 0) +
    (wf.get("REPARO_EXECUTADO") ?? 0) +
    (wf.get("TRIAGEM_FINAL") ?? 0) +
    (wf.get("RETORNO_TECNICO") ?? 0);
  const finalizados =
    (wf.get("ENTREGUE") ?? 0) + (wf.get("CANCELADO") ?? 0);
  const emAnalise =
    (wf.get("DRAFT") ?? 0) + (wf.get("ANALISE") ?? 0) + (wf.get("ANALYSIS_DRAFT") ?? 0);
  const aguardandoPeca =
    (wf.get("AGUARDANDO_PECA") ?? 0) +
    (pr.get("AGUARDANDO_RECEBIMENTO") ?? 0);
  const total = [...wf.values()].reduce((s, v) => s + v, 0);

  const cards: CardCounts = {
    match: pr.get("MATCH") ?? 0,
    matchParcial: pr.get("MATCH_PARCIAL") ?? 0,
    aptoReparo,
    verificar: pr.get("VERIFICAR") ?? 0,
    emAnalise,
    aguardandoPeca,
    comTecnico,
    finalizados,
    total,
  };

  // â”€â”€ ComparaÃ§Ã£o com ontem (snapshot diÃ¡rio) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const yesterday = db
    .prepare(
      `SELECT * FROM dashboard_daily_snapshots
       ORDER BY snapshot_date DESC LIMIT 1`,
    )
    .get() as Record<string, number> | undefined;

  let cardComparison: Partial<CardCounts> | null = null;
  if (yesterday) {
    cardComparison = {
      match: cards.match - yesterday.match_count,
      matchParcial: cards.matchParcial - yesterday.match_partial_count,
      aptoReparo: cards.aptoReparo - yesterday.apto_reparo_count,
      verificar: cards.verificar - yesterday.verificar_count,
      emAnalise: cards.emAnalise - yesterday.em_analise_count,
      aguardandoPeca: cards.aguardandoPeca - yesterday.aguardando_peca_count,
      comTecnico: cards.comTecnico - yesterday.com_tecnico_count,
      finalizados: cards.finalizados - yesterday.finalizados_count,
      total: cards.total - (yesterday.total_cases as number),
    };
  }

  // â”€â”€ Estoque â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const lastSnap = db
    .prepare(
      `SELECT ss.id, ss.total_units, ss.created_at, ss.baseline_movement_id_max,
              cs.responsible_name, cs.count_type
       FROM stock_snapshots ss
       LEFT JOIN count_sessions cs ON cs.id = ss.count_session_id
       WHERE ss.status='OFFICIAL' ORDER BY ss.id DESC LIMIT 1`,
    )
    .get() as {
      id: number;
      total_units: number;
      created_at: string;
      baseline_movement_id_max: number | null;
      responsible_name: string | null;
      count_type: string | null;
    } | undefined;

  let baseUnits = 0;
  let baseRefs = 0;
  const movCut = lastSnap?.baseline_movement_id_max ?? 0;

  if (lastSnap) {
    baseUnits = lastSnap.total_units;
    baseRefs = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT chave_peca_norm) as c
           FROM stock_snapshot_items WHERE snapshot_id=? AND chave_peca_norm IS NOT NULL`,
        )
        .get(lastSnap.id) as { c: number }
    ).c;
  } else {
    const src = db
      .prepare(`SELECT COUNT(*) as units FROM source_inventory_items`)
      .get() as { units: number };
    baseUnits = src.units;
    baseRefs = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT chave_peca_norm) as c
           FROM source_inventory_items WHERE chave_peca_norm IS NOT NULL`,
        )
        .get() as { c: number }
    ).c;
  }

  const movRow = db
    .prepare(
      `SELECT COALESCE(SUM(quantity),0) as q
       FROM stock_movements WHERE reversed_at IS NULL AND id > ?`,
    )
    .get(movCut) as { q: number };
  const stockTotal = baseUnits + movRow.q;

  const reservedRow = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(quantity)),0) as q
       FROM stock_movements
       WHERE reversed_at IS NULL AND movement_type='REPAIR_RESERVATION'`,
    )
    .get() as { q: number };
  const reserved = reservedRow.q;

  const stock: StockSummary = {
    totalUnits: stockTotal,
    totalReferences: baseRefs,
    availableUnits: Math.max(0, stockTotal - reserved),
    reservedUnits: reserved,
    baseType: lastSnap ? "OFFICIAL_SNAPSHOT" : "INITIAL_IMPORT",
    lastSnapshotId: lastSnap?.id ?? null,
    lastSnapshotAt: lastSnap?.created_at ?? null,
    lastSnapshotBy: lastSnap?.responsible_name ?? null,
  };

  // â”€â”€ Panorama â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const activeCasesRow = db
    .prepare(
      `SELECT COUNT(*) as c, COUNT(DISTINCT imei) as u
       FROM repair_cases WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO')`,
    )
    .get() as { c: number; u: number };

  const pendingPO = db
    .prepare(
      `SELECT COUNT(*) as c FROM purchase_orders
       WHERE status IN ('AWAITING','PARTIALLY_RECEIVED')`,
    )
    .get() as { c: number };

  // Reparos possÃ­veis agora = aparelhos em APTO_REPARO + PECA_DISPONIVEL + EM_SEPARACAO
  const possibleNow = aptoReparo;

  const panorama = {
    activeCases: activeCasesRow.c,
    uniqueImeis: activeCasesRow.u,
    stockUnits: stock.totalUnits,
    stockReferences: stock.totalReferences,
    availableUnits: stock.availableUnits,
    reservedUnits: stock.reservedUnits,
    pendingPurchaseOrders: pendingPO.c,
    possibleRepairsNow: possibleNow,
    lastOfficialCount: lastSnap?.created_at ?? null,
    lastUpdatedAt: now,
  };

  // â”€â”€ TÃ©cnicos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  type TechRow = {
    technician_user_id: number | null;
    technician_name: string | null;
    total_cases: number;
    unique_imeis: number;
    in_repair: number;
    oldest_case_date: string | null;
    last_movement: string | null;
  };
  const techRows = db
    .prepare(
      `SELECT
         rc.directed_technician_id as technician_user_id,
         st.name as technician_name,
         COUNT(*) as total_cases,
         COUNT(DISTINCT rc.imei) as unique_imeis,
         SUM(CASE WHEN rc.workflow_status IN ('EM_REPARO','DIRECIONADO_TECNICO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO') THEN 1 ELSE 0 END) as in_repair,
         MIN(rc.repair_date) as oldest_case_date,
         MAX(rc.updated_at) as last_movement
       FROM repair_cases rc
       LEFT JOIN staff_members st ON st.id = rc.directed_technician_id
       WHERE rc.directed_technician_id IS NOT NULL
         AND rc.workflow_status NOT IN ('ENTREGUE','CANCELADO')
       GROUP BY rc.directed_technician_id`,
    )
    .all() as TechRow[];

  const technicians: TechnicianCases[] = techRows.map((r) => ({
    technicianId: r.technician_user_id,
    technicianName: r.technician_name ?? `TÃ©cnico #${r.technician_user_id}`,
    totalCases: r.total_cases,
    uniqueImeis: r.unique_imeis,
    inRepair: r.in_repair,
    oldestCaseDate: r.oldest_case_date,
    lastMovement: r.last_movement,
  }));

  return {
    cards,
    cardComparison,
    stock,
    panorama,
    technicians,
    lastUpdatedAt: now,
  };
}
