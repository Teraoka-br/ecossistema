import type { Db } from "../db/database.js";
import {
  WF_APTO_REPARO, WF_COM_TECNICO, WF_EM_ANALISE,
  WF_VENDA_ESTADO, WF_FINALIZADOS, WF_ENCERRADOS,
  sumGroup,
} from "../domain/workflow-groups.js";

export interface BaseMetrics {
  /** repair_cases por workflow_status */
  workflowMap: Map<string, number>;
  /** part_requests por status (excluindo canceladas) */
  partMap: Map<string, number>;
  /** Contagens derivadas por grupo canônico */
  aptoReparo: number;
  comTecnico: number;
  emAnalise: number;
  vendaEstado: number;
  finalizados: number;
  totalCases: number;
  totalUniqueImeis: number;
  activeCases: number;
  activeUniqueImeis: number;
}

/**
 * Executa as queries de métricas base uma única vez.
 * Usado por overview-service e snapshot-service para evitar queries duplicadas.
 * Os grupos são definidos em src/domain/workflow-groups.ts.
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

  const aptoReparo  = sumGroup(workflowMap, WF_APTO_REPARO);
  const comTecnico  = sumGroup(workflowMap, WF_COM_TECNICO);
  const emAnalise   = sumGroup(workflowMap, WF_EM_ANALISE);
  const vendaEstado = sumGroup(workflowMap, WF_VENDA_ESTADO);
  const finalizados = sumGroup(workflowMap, WF_FINALIZADOS);
  const totalCases  = [...workflowMap.values()].reduce((s, v) => s + v, 0);

  const encerradosPlaceholders = WF_ENCERRADOS.map(() => "?").join(",");
  const activeRow = db
    .prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT imei) as u FROM repair_cases WHERE workflow_status NOT IN (${encerradosPlaceholders})`)
    .get(...WF_ENCERRADOS) as { c: number; u: number };

  return {
    workflowMap,
    partMap,
    aptoReparo,
    comTecnico,
    emAnalise,
    vendaEstado,
    finalizados,
    totalCases,
    totalUniqueImeis: (db.prepare(`SELECT COUNT(DISTINCT imei) as c FROM repair_cases`).get() as { c: number }).c,
    activeCases: activeRow.c,
    activeUniqueImeis: activeRow.u,
  };
}
