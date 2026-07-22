/**
 * Avaliação econômica de Venda no Estado (classificação separada do workflow).
 *
 * Regras:
 *   - Classificação nunca move o caso sozinha; somente aprovação humana
 *     (approveAsIs) muda workflow_status para VENDA_ESTADO.
 *   - Casos em estados travados do motor não são avaliados nem movidos.
 *   - Decisões humanas (AS_IS_REJECTED / AS_IS_APPROVED) são preservadas
 *     em reavaliações automáticas.
 *   - Política configurável na regra ativa (as_is_*), sem números hardcoded.
 */

import type { Db } from "../db/database.js";
import { calculateRepairPartsCost } from "../operational/repair-parts-cost-service.js";
import { calculateRepairMargin } from "./repair-margin-service.js";
import { ENGINE_LOCKED_STATUSES } from "./engine-loader.js";

export type EconomicClassification =
  | "NOT_EVALUATED"
  | "INCOMPLETE_COST"
  | "ECONOMICALLY_VIABLE"
  | "ECONOMIC_RISK"
  | "ACTIVE_AS_IS_CANDIDATE"
  | "AS_IS_REJECTED"
  | "AS_IS_APPROVED";

export interface AsIsPolicy {
  maxRepairCostRatio: number;
  maxActiveCandidates: number;
  requireApproval: boolean;
  incompleteCostBehavior: "MARK_INCOMPLETE" | "IGNORE";
}

export interface EconomicEvaluation {
  caseId: number;
  classification: EconomicClassification;
  repairCostRatio: number | null;
  repairMargin: number | null;
  partsCost: number | null;
  partsCostCoverage: number | null;
}

export interface EvaluateEconomicsReport {
  evaluated: number;
  viable: number;
  risk: number;
  activeCandidates: number;
  incompleteCost: number;
  notEvaluated: number;
  preservedDecisions: number;
}

export class EconomicEvaluationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EconomicEvaluationError";
  }
}

/** Lê a política de Venda no Estado da regra de match ativa. */
export function loadAsIsPolicy(db: Db): AsIsPolicy {
  const r = db
    .prepare("SELECT * FROM match_rule_sets WHERE active = 1 ORDER BY id LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  if (!r) {
    throw new EconomicEvaluationError("NO_ACTIVE_RULE", "Nenhuma regra de match ativa.");
  }
  return {
    maxRepairCostRatio: (r.as_is_max_repair_cost_ratio as number | undefined) ?? 0.5,
    maxActiveCandidates: (r.as_is_max_active_candidates as number | undefined) ?? 10,
    requireApproval: ((r.as_is_require_approval as number | undefined) ?? 1) === 1,
    incompleteCostBehavior:
      ((r.as_is_incomplete_cost_behavior as string | undefined) ?? "MARK_INCOMPLETE") as
        | "MARK_INCOMPLETE"
        | "IGNORE",
  };
}

interface CaseRow {
  id: number;
  cost: number | null;
  estimated_sale: number | null;
  age_days: number | null;
}

/**
 * Reavalia a classificação econômica de todos os casos abertos.
 * Determinístico: ranking por maior repairCostRatio, menor repairMargin,
 * menor score persistido, maior idade, menor caseId.
 */
export function evaluateEconomics(db: Db): EvaluateEconomicsReport {
  const policy = loadAsIsPolicy(db);
  const lockedList = ENGINE_LOCKED_STATUSES.map((s) => `'${s}'`).join(",");

  const cases = db
    .prepare(
      `SELECT id, cost, estimated_sale, age_days
       FROM repair_cases
       WHERE analysis_status = 'COMPLETED'
         AND workflow_status NOT IN (${lockedList})
       ORDER BY id`,
    )
    .all() as unknown as CaseRow[];

  // Decisões humanas preservadas
  const decided = new Map<number, string>(
    (
      db
        .prepare(
          `SELECT repair_case_id, classification FROM case_economic_evaluations
           WHERE classification IN ('AS_IS_REJECTED', 'AS_IS_APPROVED')`,
        )
        .all() as Array<{ repair_case_id: number; classification: string }>
    ).map((r) => [r.repair_case_id, r.classification]),
  );

  // Último score persistido por caso (desempate do ranking)
  const scoreByCase = new Map<number, number>(
    (
      db
        .prepare(
          `SELECT r.repair_case_id, r.score
           FROM repair_match_case_results r
           JOIN (SELECT repair_case_id, MAX(id) AS max_id
                 FROM repair_match_case_results GROUP BY repair_case_id) last
             ON last.max_id = r.id
           WHERE r.score IS NOT NULL`,
        )
        .all() as Array<{ repair_case_id: number; score: number }>
    ).map((r) => [r.repair_case_id, r.score]),
  );

  const evals: Array<EconomicEvaluation & { ageDays: number | null; score: number | null; fingerprint: string }> = [];
  let preservedDecisions = 0;

  for (const c of cases) {
    if (decided.has(c.id)) {
      preservedDecisions++;
      continue;
    }

    const partsResult = calculateRepairPartsCost(db, c.id);
    const margin = calculateRepairMargin({
      estimatedSale: c.estimated_sale,
      cost: c.cost,
      partsCostResult: partsResult,
    });

    let classification: EconomicClassification;
    if (
      !margin.hasCompleteCostCoverage &&
      policy.incompleteCostBehavior === "MARK_INCOMPLETE" &&
      partsResult.items.length > 0
    ) {
      classification = "INCOMPLETE_COST";
    } else if (margin.repairCostRatio === null) {
      classification = "NOT_EVALUATED";
    } else if (margin.repairCostRatio <= policy.maxRepairCostRatio) {
      classification = "ECONOMICALLY_VIABLE";
    } else {
      classification = "ECONOMIC_RISK";
    }

    evals.push({
      caseId: c.id,
      classification,
      repairCostRatio: margin.repairCostRatio,
      repairMargin: margin.repairMargin,
      partsCost: margin.partsCost,
      partsCostCoverage: margin.partsCostCoverage,
      ageDays: c.age_days,
      score: scoreByCase.get(c.id) ?? null,
      fingerprint: partsResult.fingerprint,
    });
  }

  // Ranking dos riscos econômicos → no máximo N candidatos ativos
  const risks = evals
    .filter((e) => e.classification === "ECONOMIC_RISK")
    .sort((a, b) => {
      if (a.repairCostRatio !== b.repairCostRatio)
        return (b.repairCostRatio ?? 0) - (a.repairCostRatio ?? 0);
      if (a.repairMargin !== b.repairMargin)
        return (a.repairMargin ?? Infinity) - (b.repairMargin ?? Infinity);
      const sa = a.score ?? Infinity;
      const sb = b.score ?? Infinity;
      if (sa !== sb) return sa - sb;
      const ia = a.ageDays ?? -Infinity;
      const ib = b.ageDays ?? -Infinity;
      if (ia !== ib) return ib - ia;
      return a.caseId - b.caseId;
    });
  for (const r of risks.slice(0, policy.maxActiveCandidates)) {
    r.classification = "ACTIVE_AS_IS_CANDIDATE";
  }

  // Persistir (upsert por caso; decisões humanas nunca são tocadas aqui)
  const upsert = db.prepare(`
    INSERT INTO case_economic_evaluations
      (repair_case_id, classification, repair_cost_ratio, repair_margin,
       parts_cost, parts_cost_coverage, fingerprint, evaluated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(repair_case_id) DO UPDATE SET
      classification = excluded.classification,
      repair_cost_ratio = excluded.repair_cost_ratio,
      repair_margin = excluded.repair_margin,
      parts_cost = excluded.parts_cost,
      parts_cost_coverage = excluded.parts_cost_coverage,
      fingerprint = excluded.fingerprint,
      evaluated_at = excluded.evaluated_at
  `);
  db.exec("BEGIN");
  try {
    for (const e of evals) {
      upsert.run(
        e.caseId, e.classification, e.repairCostRatio, e.repairMargin,
        e.partsCost, e.partsCostCoverage, e.fingerprint,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return {
    evaluated: evals.length,
    viable: evals.filter((e) => e.classification === "ECONOMICALLY_VIABLE").length,
    risk: evals.filter((e) => e.classification === "ECONOMIC_RISK").length,
    activeCandidates: evals.filter((e) => e.classification === "ACTIVE_AS_IS_CANDIDATE").length,
    incompleteCost: evals.filter((e) => e.classification === "INCOMPLETE_COST").length,
    notEvaluated: evals.filter((e) => e.classification === "NOT_EVALUATED").length,
    preservedDecisions,
  };
}

export function getEconomicEvaluation(db: Db, caseId: number): EconomicEvaluation | null {
  const r = db
    .prepare("SELECT * FROM case_economic_evaluations WHERE repair_case_id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    caseId: r.repair_case_id as number,
    classification: r.classification as EconomicClassification,
    repairCostRatio: r.repair_cost_ratio as number | null,
    repairMargin: r.repair_margin as number | null,
    partsCost: r.parts_cost as number | null,
    partsCostCoverage: r.parts_cost_coverage as number | null,
  };
}

/**
 * Aprovação humana: move o caso para workflow VENDA_ESTADO.
 * Exige candidato ativo e caso fora de estado travado.
 */
export function approveAsIs(
  db: Db,
  caseId: number,
  params: { userId: string | null; reason: string },
): void {
  if (!params.reason || params.reason.trim().length < 5) {
    throw new EconomicEvaluationError("REASON_TOO_SHORT", "Justificativa deve ter pelo menos 5 caracteres.");
  }
  const evalRow = getEconomicEvaluation(db, caseId);
  if (!evalRow || evalRow.classification !== "ACTIVE_AS_IS_CANDIDATE") {
    throw new EconomicEvaluationError(
      "NOT_A_CANDIDATE",
      "Somente candidatos ativos de Venda no Estado podem ser aprovados.",
    );
  }
  const wf = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(caseId) as
    | { workflow_status: string }
    | undefined;
  if (!wf) throw new EconomicEvaluationError("NOT_FOUND", "Caso não encontrado.");
  if ((ENGINE_LOCKED_STATUSES as readonly string[]).includes(wf.workflow_status)) {
    throw new EconomicEvaluationError(
      "PROTECTED_STATE",
      `Caso em estado protegido (${wf.workflow_status}) não pode ser movido.`,
    );
  }

  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE repair_cases SET workflow_status = 'VENDA_ESTADO', updated_at = datetime('now') WHERE id = ?",
    ).run(caseId);
    db.prepare(
      `UPDATE case_economic_evaluations
       SET classification = 'AS_IS_APPROVED', decided_by = ?, decided_at = datetime('now'), decision_reason = ?
       WHERE repair_case_id = ?`,
    ).run(params.userId, params.reason.trim(), caseId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Rejeição humana: mantém o caso no fluxo de reparo. */
export function rejectAsIs(
  db: Db,
  caseId: number,
  params: { userId: string | null; reason: string },
): void {
  if (!params.reason || params.reason.trim().length < 5) {
    throw new EconomicEvaluationError("REASON_TOO_SHORT", "Justificativa deve ter pelo menos 5 caracteres.");
  }
  const evalRow = getEconomicEvaluation(db, caseId);
  if (!evalRow || evalRow.classification !== "ACTIVE_AS_IS_CANDIDATE") {
    throw new EconomicEvaluationError(
      "NOT_A_CANDIDATE",
      "Somente candidatos ativos de Venda no Estado podem ser rejeitados.",
    );
  }
  db.prepare(
    `UPDATE case_economic_evaluations
     SET classification = 'AS_IS_REJECTED', decided_by = ?, decided_at = datetime('now'), decision_reason = ?
     WHERE repair_case_id = ?`,
  ).run(params.userId, params.reason.trim(), caseId);
}
