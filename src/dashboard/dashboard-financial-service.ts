import type { Db } from "../db/database.js";
import { WF } from "../domain/workflow-groups.js";

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

import type { SQLInputValue } from "node:sqlite";

function querySlice(db: Db, where: string, params: SQLInputValue[] = []): FinancialSlice {
  const row = db.prepare(`
    SELECT
      SUM(cost)           AS totalCost,
      SUM(estimated_sale) AS totalSale,
      SUM(margin)         AS totalMargin,
      COUNT(*)            AS caseCount
    FROM repair_cases
    WHERE ${where}
  `).get(...params) as { totalCost: number|null; totalSale: number|null; totalMargin: number|null; caseCount: number };

  return {
    totalCost:   row.totalCost   ?? null,
    totalSale:   row.totalSale   ?? null,
    totalMargin: row.totalMargin ?? null,
    caseCount:   row.caseCount   ?? 0,
  };
}

export function getFinancialData(db: Db): FinancialData {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthIso = monthStart.toISOString().slice(0, 10);

  return {
    active:             querySlice(db, `workflow_status NOT IN ('CONCLUIDO','CANCELADO','VENDA_ESTADO')`),
    withTechnician:     querySlice(db, `workflow_status IN ('REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO')`),
    waitingPart:        querySlice(db, `workflow_status IN ('PEDIR_PECA','AGUARDANDO_RECEBIMENTO')`),
    concludedThisMonth: querySlice(db, `workflow_status = 'CONCLUIDO' AND updated_at >= '${monthIso}'`),
    lostThisMonth:      querySlice(db, `workflow_status IN ('CANCELADO','VENDA_ESTADO') AND updated_at >= '${monthIso}'`),
  };
}

export function getFinancialByBucket(db: Db): FinancialByBucket {
  const BUCKETS: Record<keyof FinancialByBucket, readonly string[]> = {
    match:          WF.match,
    matchParcial:   WF.matchParcial,
    aptoReparo:     WF.aptoReparo,
    verificar:      WF.verificar,
    emAnalise:      WF.emAnalise,
    aguardandoPeca: WF.aguardandoPeca,
    comTecnico:     WF.comTecnico,
    vendaEstado:    WF.vendaEstado,
    finalizados:    WF.finalizados,
  };
  const result = {} as FinancialByBucket;
  for (const [key, statuses] of Object.entries(BUCKETS) as [keyof FinancialByBucket, string[]][]) {
    const ph = statuses.map(() => "?").join(",");
    result[key] = querySlice(db, `workflow_status IN (${ph})`, statuses);
  }
  return result;
}
