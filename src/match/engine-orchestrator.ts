/**
 * Orquestrador do motor de match para repair_cases.
 *
 * requestMatchRecompute: registra uma solicitação na fila persistente.
 * processPendingRecompute: processa a próxima solicitação pendente.
 * runRepairMatchEngine: executa o motor em duas passagens.
 *
 * A transação operacional que origina a solicitação deve terminar ANTES
 * de chamar requestMatchRecompute. O motor é idempotente e não altera
 * reservas existentes — apenas atualiza workflow_status e repair_match_results.
 */

import type { Db } from "../db/database.js";
import { getActiveRuleSet, computeScore, type MatchRuleSet } from "./match-rule-service.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

export function requestMatchRecompute(
  db: Db,
  reason: string,
  entityType?: string,
  entityId?: number,
): void {
  try {
    db.prepare(`
      INSERT INTO match_recompute_requests (reason, entity_type, entity_id)
      VALUES (?,?,?)
    `).run(reason, entityType ?? null, entityId ?? null);

    db.prepare(`
      UPDATE match_engine_state SET status = 'STALE', stale_since = COALESCE(stale_since, datetime('now')), updated_at = datetime('now')
      WHERE id = 1 AND status != 'RUNNING'
    `).run();
  } catch {
    // Non-blocking — orchestration failure never aborts the caller
  }
}

export function getPendingRequestCount(db: Db): number {
  return (db.prepare(
    "SELECT COUNT(*) AS c FROM match_recompute_requests WHERE processed_at IS NULL"
  ).get() as { c: number }).c;
}

export function getEngineState(db: Db): {
  status: string; lastRunId: number | null; staleSince: string | null; lastError: string | null; updatedAt: string;
} {
  const row = db.prepare("SELECT * FROM match_engine_state WHERE id = 1").get() as Record<string, unknown>;
  return {
    status: row.status as string,
    lastRunId: row.last_run_id as number | null,
    staleSince: row.stale_since as string | null,
    lastError: row.last_error as string | null,
    updatedAt: row.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// Engine execution
// ---------------------------------------------------------------------------

export interface RepairMatchRunResult {
  runId: number;
  casesEvaluated: number;
  fullKitsFound: number;
  partialKitsFound: number;
  casesChanged: number;
  durationMs: number;
}

export async function processPendingRecompute(db: Db): Promise<RepairMatchRunResult | null> {
  const pending = (db.prepare(
    "SELECT COUNT(*) AS c FROM match_recompute_requests WHERE processed_at IS NULL"
  ).get() as { c: number }).c;

  if (pending === 0) return null;

  // Collect all pending reasons before running
  const requests = db.prepare(
    "SELECT id, reason, entity_type, entity_id FROM match_recompute_requests WHERE processed_at IS NULL ORDER BY requested_at LIMIT 50"
  ).all() as Array<{ id: number; reason: string; entity_type: string | null; entity_id: number | null }>;

  const reason = requests.map(r => r.reason).join("; ");
  const result = await runRepairMatchEngine(db, { triggerReason: reason });

  // Mark all collected requests as processed
  const ids = requests.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE match_recompute_requests SET processed_at = datetime('now'), run_id = ? WHERE id IN (${placeholders})`
  ).run(result.runId, ...ids);

  return result;
}

export async function runRepairMatchEngine(
  db: Db,
  opts: { triggerReason?: string; userId?: number | null } = {},
): Promise<RepairMatchRunResult> {
  const startMs = Date.now();

  // Prevent concurrent runs
  const state = getEngineState(db);
  if (state.status === "RUNNING") {
    throw new Error("Motor já em execução.");
  }

  let ruleSet: MatchRuleSet;
  try {
    ruleSet = getActiveRuleSet(db);
  } catch {
    throw new Error("Nenhuma regra de match ativa. Configure uma regra antes de executar o motor.");
  }

  // Create run record
  const runRes = db.prepare(`
    INSERT INTO repair_match_runs
      (rule_set_id, rule_set_version, status, trigger_reason, triggered_by_user_id)
    VALUES (?,?,?,?,?)
  `).run(ruleSet.id, ruleSet.version, "RUNNING", opts.triggerReason ?? "MANUAL", opts.userId ?? null);
  const runId = runRes.lastInsertRowid as number;

  db.prepare(
    "UPDATE match_engine_state SET status = 'RUNNING', updated_at = datetime('now') WHERE id = 1"
  ).run();

  try {
    const result = executeEngine(db, runId, ruleSet);

    db.prepare(`
      UPDATE repair_match_runs SET
        status = 'COMPLETED', finished_at = datetime('now'),
        cases_evaluated = ?, full_kits_found = ?, partial_kits_found = ?, cases_changed = ?
      WHERE id = ?
    `).run(result.casesEvaluated, result.fullKitsFound, result.partialKitsFound, result.casesChanged, runId);

    db.prepare(`
      UPDATE match_engine_state SET
        status = 'IDLE', last_run_id = ?, stale_since = NULL, last_error = NULL, updated_at = datetime('now')
      WHERE id = 1
    `).run(runId);

    return { runId, durationMs: Date.now() - startMs, ...result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE repair_match_runs SET status = 'FAILED', finished_at = datetime('now'), error_message = ? WHERE id = ?"
    ).run(msg, runId);
    db.prepare(
      "UPDATE match_engine_state SET status = 'FAILED', last_error = ?, updated_at = datetime('now') WHERE id = 1"
    ).run(msg);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core two-pass matching algorithm
// ---------------------------------------------------------------------------

interface CaseRow {
  id: number;
  workflow_status: string;
  analysis_status: string;
  age_days: number | null;
  margin: number | null;
  manual_priority_active: number;
}

interface PartRow {
  id: number;
  repair_case_id: number;
  chave_peca_norm: string | null;
  chave_peca: string | null;
  status: string;
  cancelled_at: string | null;
}

function executeEngine(
  db: Db,
  runId: number,
  ruleSet: MatchRuleSet,
): Omit<RepairMatchRunResult, "runId" | "durationMs"> {
  // Load eligible cases — only COMPLETED analysis, not terminal
  const cases = db.prepare(`
    SELECT id, workflow_status, analysis_status, age_days, margin, manual_priority_active
    FROM repair_cases
    WHERE analysis_status = 'COMPLETED'
      AND workflow_status NOT IN ('CONCLUIDO','VENDA_ESTADO','CANCELADO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO')
    ORDER BY id
  `).all() as unknown as CaseRow[];

  if (cases.length === 0) {
    return { casesEvaluated: 0, fullKitsFound: 0, partialKitsFound: 0, casesChanged: 0 };
  }

  // Load all active part_requests for these cases
  const caseIds = cases.map(c => c.id);
  const placeholders = caseIds.map(() => "?").join(",");
  const parts = db.prepare(`
    SELECT id, repair_case_id, chave_peca_norm, chave_peca, status, cancelled_at
    FROM part_requests
    WHERE repair_case_id IN (${placeholders})
      AND cancelled_at IS NULL
      AND status NOT IN ('CANCELADA','SEPARADA','CONSUMIDA')
  `).all(...caseIds) as unknown as PartRow[];

  // Group parts by case
  const partsByCase = new Map<number, PartRow[]>();
  for (const p of parts) {
    const arr = partsByCase.get(p.repair_case_id) ?? [];
    arr.push(p);
    partsByCase.set(p.repair_case_id, arr);
  }

  // Get current stock (available = physical - reserved)
  const { groups: stockGroups } = getCurrentOperationalStock(db);
  const availableStock = new Map<string, number>();
  for (const g of stockGroups) {
    if (g.chavePecaNorm) {
      const prev = availableStock.get(g.chavePecaNorm) ?? 0;
      availableStock.set(g.chavePecaNorm, prev + g.availableQuantity);
    }
  }

  // Score each case
  interface ScoredCase {
    caseRow: CaseRow;
    caseParts: PartRow[];
    score: number;
    margin: number | null;
    openParts: number;
    needsChaves: string[];
    isManualPriority: boolean;
  }

  const scoredCases: ScoredCase[] = [];
  for (const c of cases) {
    const caseParts = partsByCase.get(c.id) ?? [];
    if (caseParts.length === 0) continue;

    const { score } = computeScore(ruleSet, c.age_days, c.margin);
    const needsChaves = caseParts
      .filter(p => p.chave_peca_norm)
      .map(p => p.chave_peca_norm!);

    scoredCases.push({
      caseRow: c,
      caseParts,
      score,
      margin: c.margin,
      openParts: caseParts.length,
      needsChaves,
      isManualPriority: c.manual_priority_active === 1,
    });
  }

  // Sort: manual priority first → fewer open parts → higher score → higher margin → lower id
  scoredCases.sort((a, b) => {
    if (a.isManualPriority !== b.isManualPriority) return a.isManualPriority ? -1 : 1;
    if (a.openParts !== b.openParts) return a.openParts - b.openParts;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.margin ?? -Infinity) !== (a.margin ?? -Infinity)) return (b.margin ?? -Infinity) - (a.margin ?? -Infinity);
    return a.caseRow.id - b.caseRow.id;
  });

  // Working stock (mutable during simulation)
  const workingStock = new Map(availableStock);

  let fullKitsFound = 0;
  let partialKitsFound = 0;
  let casesChanged = 0;

  const deleteStmt = db.prepare("DELETE FROM repair_match_results WHERE run_id = ?");
  deleteStmt.run(runId);

  // Pass 1 — full kits
  for (const sc of scoredCases) {
    const neededNorms = sc.needsChaves;
    if (neededNorms.length === 0) continue;

    const allAvailable = neededNorms.every(n => (workingStock.get(n) ?? 0) >= 1);
    if (!allAvailable) continue;

    // Allocate
    for (const n of neededNorms) {
      workingStock.set(n, (workingStock.get(n) ?? 0) - 1);
    }

    // Write results
    const { marginPoints, agePoints, score } = computeScore(ruleSet, sc.caseRow.age_days, sc.margin);
    let rank = 1;
    for (const p of sc.caseParts) {
      if (!p.chave_peca_norm) continue;
      db.prepare(`
        INSERT OR REPLACE INTO repair_match_results
          (run_id, repair_case_id, part_request_id, chave_peca, chave_peca_norm,
           result_status, margin_points, age_points, score, priority_rank)
        VALUES (?,?,?,?,?,'MATCH',?,?,?,?)
      `).run(runId, sc.caseRow.id, p.id, p.chave_peca ?? null, p.chave_peca_norm, marginPoints, agePoints, score, rank++);
    }

    const prevStatus = sc.caseRow.workflow_status;
    if (prevStatus !== "MATCH" && prevStatus !== "EM_SEPARACAO" && prevStatus !== "APTO_REPARO") {
      db.prepare(
        "UPDATE repair_cases SET workflow_status = 'MATCH', updated_at = datetime('now') WHERE id = ?"
      ).run(sc.caseRow.id);
      casesChanged++;
    }

    // Update part_requests to INDICADA
    for (const p of sc.caseParts) {
      if (p.status === "PEDIR_PECA" || p.status === "VERIFICAR") {
        db.prepare("UPDATE part_requests SET status = 'INDICADA', updated_at = datetime('now') WHERE id = ?").run(p.id);
      }
    }

    fullKitsFound++;
  }

  // Pass 2 — partial kits (with remaining stock)
  for (const sc of scoredCases) {
    // Skip cases already handled in pass 1
    const currentStatus = (db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(sc.caseRow.id) as { workflow_status: string }).workflow_status;
    if (currentStatus === "MATCH" || currentStatus === "EM_SEPARACAO" || currentStatus === "APTO_REPARO") continue;

    const { marginPoints, agePoints, score } = computeScore(ruleSet, sc.caseRow.age_days, sc.margin);
    let hasPartial = false;
    let hasAll = true;
    let rank = 1;

    for (const p of sc.caseParts) {
      if (!p.chave_peca_norm) {
        db.prepare(`
          INSERT OR REPLACE INTO repair_match_results
            (run_id, repair_case_id, part_request_id, chave_peca, chave_peca_norm,
             result_status, margin_points, age_points, score, priority_rank)
          VALUES (?,?,?,?,?,'VERIFICAR',?,?,?,?)
        `).run(runId, sc.caseRow.id, p.id, p.chave_peca ?? null, null, marginPoints, agePoints, score, rank++);
        hasAll = false;
        continue;
      }

      const avail = workingStock.get(p.chave_peca_norm) ?? 0;
      if (avail >= 1) {
        workingStock.set(p.chave_peca_norm, avail - 1);
        db.prepare(`
          INSERT OR REPLACE INTO repair_match_results
            (run_id, repair_case_id, part_request_id, chave_peca, chave_peca_norm,
             result_status, allocated_units, margin_points, age_points, score, priority_rank)
          VALUES (?,?,?,?,?,'MATCH_PARCIAL',1,?,?,?,?)
        `).run(runId, sc.caseRow.id, p.id, p.chave_peca ?? null, p.chave_peca_norm, marginPoints, agePoints, score, rank++);
        hasPartial = true;
        if (p.status === "PEDIR_PECA" || p.status === "VERIFICAR") {
          db.prepare("UPDATE part_requests SET status = 'INDICADA', updated_at = datetime('now') WHERE id = ?").run(p.id);
        }
      } else {
        db.prepare(`
          INSERT OR REPLACE INTO repair_match_results
            (run_id, repair_case_id, part_request_id, chave_peca, chave_peca_norm,
             result_status, margin_points, age_points, score, priority_rank)
          VALUES (?,?,?,?,?,'PEDIR_PECA',?,?,?,?)
        `).run(runId, sc.caseRow.id, p.id, p.chave_peca ?? null, p.chave_peca_norm, marginPoints, agePoints, score, rank++);
        hasAll = false;
        // Revert indicada → pedir_peca if no longer available
        if (p.status === "INDICADA") {
          db.prepare("UPDATE part_requests SET status = 'PEDIR_PECA', updated_at = datetime('now') WHERE id = ?").run(p.id);
        }
      }
    }

    const prevStatus = sc.caseRow.workflow_status;
    let newStatus: string;
    if (hasPartial && !hasAll) {
      newStatus = "MATCH_PARCIAL";
    } else if (!hasPartial) {
      newStatus = "PEDIR_PECA";
    } else {
      continue;
    }

    if (prevStatus !== newStatus) {
      db.prepare(
        "UPDATE repair_cases SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newStatus, sc.caseRow.id);
      casesChanged++;
    }
    if (hasPartial) partialKitsFound++;
  }

  return {
    casesEvaluated: scoredCases.length,
    fullKitsFound,
    partialKitsFound,
    casesChanged,
  };
}
