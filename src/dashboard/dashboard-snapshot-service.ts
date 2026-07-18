import type { Db } from "../db/database.js";

/** Retorna a data local no fuso America/Sao_Paulo como 'YYYY-MM-DD'. */
export function todaySaoPaulo(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .split("/")
    .reverse()
    .join("-");
}

export interface DashboardSnapshot {
  id: number;
  snapshot_date: string;
  total_cases: number;
  total_unique_imeis: number;
  match_count: number;
  match_partial_count: number;
  apto_reparo_count: number;
  verificar_count: number;
  em_analise_count: number;
  aguardando_peca_count: number;
  com_tecnico_count: number;
  finalizados_count: number;
  stock_total_units: number;
  stock_total_references: number;
  stock_available_units: number;
  stock_reserved_units: number;
  counting_sessions_count: number;
  updated_at: string;
}

/** Agrega os dados atuais do banco e persiste (ou atualiza) o snapshot do dia. Idempotente. */
export function createOrUpdateDashboardSnapshot(
  db: Db,
  date: string = todaySaoPaulo(),
): DashboardSnapshot {
  // â”€â”€ repair_cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const casesRow = db
    .prepare(
      `SELECT COUNT(*) as total_cases,
              COUNT(DISTINCT imei) as total_unique_imeis
       FROM repair_cases
       WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO')`,
    )
    .get() as { total_cases: number; total_unique_imeis: number };

  // â”€â”€ repair_cases workflow counts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  type StatusRow = { workflow_status: string; c: number };
  const workflowRows = db
    .prepare(
      `SELECT workflow_status, COUNT(*) as c
       FROM repair_cases
       WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO')
       GROUP BY workflow_status`,
    )
    .all() as StatusRow[];

  const wf = new Map(workflowRows.map((r) => [r.workflow_status, r.c]));
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
    db
      .prepare(
        `SELECT COUNT(*) as c FROM repair_cases WHERE workflow_status IN ('ENTREGUE','CANCELADO')`,
      )
      .get() as { c: number };

  // â”€â”€ part_requests (match status) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  type PartRow = { status: string; c: number };
  const partRows = db
    .prepare(
      `SELECT status, COUNT(*) as c
       FROM part_requests WHERE cancelled_at IS NULL
       GROUP BY status`,
    )
    .all() as PartRow[];
  const pr = new Map(partRows.map((r) => [r.status, r.c]));

  // â”€â”€ estoque operacional â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Base: Ãºltimo snapshot OFFICIAL ou contagem de source_inventory_items
  const lastSnap = db
    .prepare(
      `SELECT id, total_units, baseline_movement_id_max
       FROM stock_snapshots WHERE status='OFFICIAL' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; total_units: number; baseline_movement_id_max: number | null } | undefined;

  let baseUnits = 0;
  let baseRefs = 0;

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
      .prepare(
        `SELECT COUNT(*) as units, COUNT(DISTINCT chave_peca_norm) as refs
         FROM source_inventory_items`,
      )
      .get() as { units: number; refs: number };
    baseUnits = src.units;
    baseRefs = src.refs;
  }

  // MovimentaÃ§Ãµes posteriores ao corte
  const movCut = lastSnap?.baseline_movement_id_max ?? 0;
  const movRow = db
    .prepare(
      `SELECT COALESCE(SUM(quantity),0) as q
       FROM stock_movements WHERE reversed_at IS NULL AND id > ?`,
    )
    .get(movCut) as { q: number };
  const stockTotal = baseUnits + movRow.q;

  // Reservas ativas
  const reservedRow = db
    .prepare(
      `SELECT COALESCE(SUM(quantity),0) as q
       FROM stock_movements
       WHERE reversed_at IS NULL
         AND movement_type='REPAIR_RESERVATION'`,
    )
    .get() as { q: number };
  const reserved = Math.abs(reservedRow.q);

  // â”€â”€ contagens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM count_sessions WHERE status='FINALIZED'`)
    .get() as { c: number };

  // â”€â”€ UPSERT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO dashboard_daily_snapshots
       (snapshot_date, total_cases, total_unique_imeis,
        match_count, match_partial_count, apto_reparo_count,
        verificar_count, em_analise_count, aguardando_peca_count,
        com_tecnico_count, finalizados_count,
        stock_total_units, stock_total_references,
        stock_available_units, stock_reserved_units,
        counting_sessions_count, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(snapshot_date) DO UPDATE SET
       total_cases             = excluded.total_cases,
       total_unique_imeis      = excluded.total_unique_imeis,
       match_count             = excluded.match_count,
       match_partial_count     = excluded.match_partial_count,
       apto_reparo_count       = excluded.apto_reparo_count,
       verificar_count         = excluded.verificar_count,
       em_analise_count        = excluded.em_analise_count,
       aguardando_peca_count   = excluded.aguardando_peca_count,
       com_tecnico_count       = excluded.com_tecnico_count,
       finalizados_count       = excluded.finalizados_count,
       stock_total_units       = excluded.stock_total_units,
       stock_total_references  = excluded.stock_total_references,
       stock_available_units   = excluded.stock_available_units,
       stock_reserved_units    = excluded.stock_reserved_units,
       counting_sessions_count = excluded.counting_sessions_count,
       updated_at              = excluded.updated_at`,
  ).run(
    date,
    casesRow.total_cases,
    casesRow.total_unique_imeis,
    pr.get("MATCH") ?? 0,
    pr.get("MATCH_PARCIAL") ?? 0,
    aptoReparo,
    pr.get("VERIFICAR") ?? 0,
    (wf.get("DRAFT") ?? 0) + (wf.get("ANALISE") ?? 0),
    (wf.get("AGUARDANDO_PECA") ?? 0) + (pr.get("AGUARDANDO_RECEBIMENTO") ?? 0),
    comTecnico,
    finalizados.c,
    stockTotal,
    baseRefs,
    Math.max(0, stockTotal - reserved),
    reserved,
    countRow.c,
    now,
  );

  return db
    .prepare(`SELECT * FROM dashboard_daily_snapshots WHERE snapshot_date=?`)
    .get(date) as unknown as DashboardSnapshot;
}
