import type { Db } from "../db/database.js";
import {
  WF_APTO_REPARO, WF_COM_TECNICO, WF_EM_ANALISE, WF_AGUARDANDO,
  WF_VENDA_ESTADO, WF_FINALIZADOS, sumGroup,
} from "../domain/workflow-groups.js";

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
  venda_estado_count: number;
  stock_total_units: number;
  stock_total_references: number;
  stock_available_units: number;
  stock_reserved_units: number;
  counting_sessions_count: number;
  updated_at: string;
}

export function createOrUpdateDashboardSnapshot(
  db: Db,
  date: string = todaySaoPaulo(),
): DashboardSnapshot {
  // -- repair_cases workflow counts --------------------------------------------
  type StatusRow = { workflow_status: string; c: number };
  const workflowRows = db
    .prepare(`SELECT workflow_status, COUNT(*) as c FROM repair_cases GROUP BY workflow_status`)
    .all() as StatusRow[];
  const wf = new Map(workflowRows.map((r) => [r.workflow_status, r.c]));

  const matchCount      = wf.get("MATCH") ?? 0;
  const matchPartial    = wf.get("MATCH_PARCIAL") ?? 0;
  const aptoReparo      = sumGroup(wf, WF_APTO_REPARO);
  const verificar       = wf.get("VERIFICAR") ?? 0;
  const emAnalise       = sumGroup(wf, WF_EM_ANALISE);
  const aguardandoPeca  = sumGroup(wf, WF_AGUARDANDO);
  const comTecnico      = sumGroup(wf, WF_COM_TECNICO);
  const vendaEstado     = sumGroup(wf, WF_VENDA_ESTADO);
  const finalizados     = sumGroup(wf, WF_FINALIZADOS);
  const totalCases      = [...wf.values()].reduce((s, v) => s + v, 0);
  const uniqueImeisRow  = db.prepare(`SELECT COUNT(DISTINCT imei) as c FROM repair_cases`).get() as { c: number };

  // -- estoque operacional -----------------------------------------------------
  const lastSnap = db
    .prepare(`SELECT id, total_units, baseline_movement_id_max FROM stock_snapshots WHERE status='OFFICIAL' ORDER BY id DESC LIMIT 1`)
    .get() as { id: number; total_units: number; baseline_movement_id_max: number | null } | undefined;

  let baseUnits = 0;
  let baseRefs  = 0;

  if (lastSnap) {
    baseUnits = lastSnap.total_units;
    baseRefs  = (db.prepare(`SELECT COUNT(DISTINCT chave_peca_norm) as c FROM stock_snapshot_items WHERE snapshot_id=? AND chave_peca_norm IS NOT NULL`).get(lastSnap.id) as { c: number }).c;
  } else {
    const src = db.prepare(`SELECT COUNT(*) as units, COUNT(DISTINCT chave_peca_norm) as refs FROM source_inventory_items`).get() as { units: number; refs: number };
    baseUnits = src.units;
    baseRefs  = src.refs;
  }

  const movCut    = lastSnap?.baseline_movement_id_max ?? 0;
  const movRow    = db.prepare(`SELECT COALESCE(SUM(quantity),0) as q FROM stock_movements WHERE reversed_at IS NULL AND id > ?`).get(movCut) as { q: number };
  const stockTotal = baseUnits + movRow.q;
  const reservedRow = db.prepare(`SELECT COALESCE(SUM(quantity),0) as q FROM operational_reservations WHERE status='ACTIVE'`).get() as { q: number };
  const reserved  = reservedRow.q;

  // -- contagens ---------------------------------------------------------------
  const countRow = db.prepare(`SELECT COUNT(*) as c FROM count_sessions WHERE status='FINALIZED' AND finished_at IS NOT NULL`).get() as { c: number };

  // -- UPSERT ------------------------------------------------------------------
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO dashboard_daily_snapshots
      (snapshot_date, total_cases, total_unique_imeis,
       match_count, match_partial_count, apto_reparo_count,
       verificar_count, em_analise_count, aguardando_peca_count,
       com_tecnico_count, finalizados_count, venda_estado_count,
       stock_total_units, stock_total_references,
       stock_available_units, stock_reserved_units,
       counting_sessions_count, updated_at, recalculated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      venda_estado_count      = excluded.venda_estado_count,
      stock_total_units       = excluded.stock_total_units,
      stock_total_references  = excluded.stock_total_references,
      stock_available_units   = excluded.stock_available_units,
      stock_reserved_units    = excluded.stock_reserved_units,
      counting_sessions_count = excluded.counting_sessions_count,
      updated_at              = excluded.updated_at,
      recalculated_at         = excluded.recalculated_at
  `).run(
    date,
    totalCases,
    uniqueImeisRow.c,
    matchCount,
    matchPartial,
    aptoReparo,
    verificar,
    emAnalise,
    aguardandoPeca,
    comTecnico,
    finalizados,
    vendaEstado,
    stockTotal,
    baseRefs,
    Math.max(0, stockTotal - reserved),
    reserved,
    countRow.c,
    now,
    now,
  );

  return db.prepare(`SELECT * FROM dashboard_daily_snapshots WHERE snapshot_date=?`).get(date) as unknown as DashboardSnapshot;
}
