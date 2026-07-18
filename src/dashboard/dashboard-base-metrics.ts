import type { Db } from "../db/database.js";

export interface BaseMetrics {
  /** repair_cases por workflow_status (inclui ENTREGUE/CANCELADO) */
  workflowMap: Map<string, number>;
  /** part_requests por status (excluindo canceladas) */
  partMap: Map<string, number>;
  /** Contagens derivadas */
  aptoReparo: number;
  comTecnico: number;
  emAnalise: number;
  finalizados: number;
  totalCases: number;
  totalUniqueImeis: number;
  activeCases: number;
  activeUniqueImeis: number;
}

/**
 * Executa as queries de métricas base uma única vez.
 * Usado por overview-service e snapshot-service para evitar queries duplicadas.
 */
export function getBaseMetrics(db: Db): BaseMetrics {
  type WfRow = { workflow_status: string; c: number };
  const wfRows = db
    .prepare(`SELECT workflow_status, COUNT(*) as c FROM repair_cases GROUP BY workflow_status`)
    .all() as WfRow[];
  const workflowMap = new Map(wfRows.map(r => [r.workflow_status, r.c]));

  type PrRow = { status: string; c: number };
  const prRows = db
    .prepare(`SELECT status, COUNT(*) as c FROM part_requests WHERE cancelled_at IS NULL GROUP BY status`)
    .all() as PrRow[];
  const partMap = new Map(prRows.map(r => [r.status, r.c]));

  const get = (m: Map<string, number>, ...keys: string[]) => keys.reduce((s, k) => s + (m.get(k) ?? 0), 0);

  const aptoReparo  = get(workflowMap, "APTO_REPARO", "PECA_DISPONIVEL", "EM_SEPARACAO");
  const comTecnico  = get(workflowMap, "DIRECIONADO_TECNICO", "EM_REPARO", "REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO");
  const emAnalise   = get(workflowMap, "DRAFT", "ANALISE", "ANALYSIS_DRAFT");
  const finalizados = get(workflowMap, "ENTREGUE", "CANCELADO");
  const totalCases  = [...workflowMap.values()].reduce((s, v) => s + v, 0);

  const activeRow = db
    .prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT imei) as u FROM repair_cases WHERE workflow_status NOT IN ('ENTREGUE','CANCELADO')`)
    .get() as { c: number; u: number };

  return {
    workflowMap,
    partMap,
    aptoReparo,
    comTecnico,
    emAnalise,
    finalizados,
    totalCases,
    totalUniqueImeis: (db.prepare(`SELECT COUNT(DISTINCT imei) as c FROM repair_cases`).get() as { c: number }).c,
    activeCases: activeRow.c,
    activeUniqueImeis: activeRow.u,
  };
}
