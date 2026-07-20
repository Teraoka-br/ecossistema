/**
 * Orquestrador do motor de match — camada de PERSISTÊNCIA.
 *
 * A decisão vive exclusivamente em calculateMatch (função pura). Este módulo:
 *   1. carrega os dados (engine-loader);
 *   2. chama calculateMatch;
 *   3. persiste os resultados de forma transacional e idempotente;
 *   4. atualiza part_requests/repair_cases preservando estados protegidos;
 *   5. registra a regra/versão que gerou cada resultado.
 *
 * O motor NUNCA cria reservas, movimentações ou pedidos — apenas sinaliza.
 *
 * requestMatchRecompute: registra uma solicitação na fila persistente.
 * processPendingRecompute: consolida as solicitações pendentes em uma execução.
 */

import type { Db } from "../db/database.js";
import { calculateMatch, type CaseDecision } from "./calculate-match.js";
import { applyPeacsToRepairCases } from "../import-central/operational-sync-service.js";
import {
  loadActiveRuleStrict,
  loadEngineInput,
  MatchRuleStateError,
  type LoadedEngineInput,
} from "./engine-loader.js";

// ---------------------------------------------------------------------------
// Fila de recálculo
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

export interface RepairMatchRunResult {
  runId: number;
  casesEvaluated: number;
  fullKitsFound: number;
  partialKitsFound: number;
  verificarCount: number;
  casesChanged: number;
  durationMs: number;
  /** Casos com todas as peças em status avançado (SEPARADA/RESERVADA/CONSUMIDA) — protegidos, não alterados. */
  advancedProtectedCount: number;
  /** Desses, quantos têm workflow inconsistente com o status avançado das peças. */
  inconsistentWorkflowCount: number;
}

export async function processPendingRecompute(db: Db): Promise<RepairMatchRunResult | null> {
  const pending = (db.prepare(
    "SELECT COUNT(*) AS c FROM match_recompute_requests WHERE processed_at IS NULL"
  ).get() as { c: number }).c;

  if (pending === 0) return null;

  // Consolida todas as solicitações pendentes em UMA execução
  const requests = db.prepare(
    "SELECT id, reason FROM match_recompute_requests WHERE processed_at IS NULL ORDER BY requested_at LIMIT 50"
  ).all() as Array<{ id: number; reason: string }>;

  const reason = requests.map(r => r.reason).join("; ");
  const result = await runRepairMatchEngine(db, { triggerReason: reason });

  const ids = requests.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE match_recompute_requests SET processed_at = datetime('now'), run_id = ? WHERE id IN (${placeholders})`
  ).run(result.runId, ...ids);

  return result;
}

// ---------------------------------------------------------------------------
// Execução do motor
// ---------------------------------------------------------------------------

export async function runRepairMatchEngine(
  db: Db,
  opts: { triggerReason?: string; userId?: number | null } = {},
): Promise<RepairMatchRunResult> {
  const startMs = Date.now();

  // Impede execuções concorrentes
  const state = getEngineState(db);
  if (state.status === "RUNNING") {
    throw new Error("Motor já em execução.");
  }

  // Regra ativa estrita: 0 ou >1 aborta SEM criar run e SEM alterar cards.
  let rule;
  try {
    rule = loadActiveRuleStrict(db);
  } catch (err) {
    if (err instanceof MatchRuleStateError) throw err;
    throw new Error("Falha ao carregar a regra de match ativa.");
  }

  const runRes = db.prepare(`
    INSERT INTO repair_match_runs
      (rule_set_id, rule_set_version, status, trigger_reason, triggered_by_user_id)
    VALUES (?,?,?,?,?)
  `).run(rule.id, rule.version, "RUNNING", opts.triggerReason ?? "MANUAL", opts.userId ?? null);
  const runId = runRes.lastInsertRowid as number;

  db.prepare(
    "UPDATE match_engine_state SET status = 'RUNNING', updated_at = datetime('now') WHERE id = 1"
  ).run();

  try {
    applyPeacsToRepairCases(db);

    const input = loadEngineInput(db, rule);
    const output = calculateMatch(input);
    const persisted = persistDecisions(db, runId, input, output.cases);

    // Manter exatamente 10 casos em VENDA_ESTADO (vagas abertas por conclusão manual)
    // VENDA_ESTADO é permanente — nunca revertido automaticamente.
    // A cada run, preenche vagas com os próximos piores pontuadores.
    const activeVendaCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM repair_cases WHERE workflow_status = 'VENDA_ESTADO'"
    ).get() as { n: number }).n;

    const vagas = Math.max(0, 10 - activeVendaCount);
    if (vagas > 0) {
      const toAdd = (db.prepare(`
        SELECT rmcr.repair_case_id
        FROM repair_match_case_results rmcr
        JOIN repair_cases rc ON rc.id = rmcr.repair_case_id
        WHERE rmcr.run_id = ?
          AND rmcr.eligible = 1
          AND rc.workflow_status NOT IN ('CONCLUIDO','CANCELADO','VENDA_ESTADO')
        ORDER BY rmcr.score ASC NULLS LAST
        LIMIT ?
      `).all(runId, vagas) as { repair_case_id: number }[]).map(r => r.repair_case_id);

      if (toAdd.length > 0) {
        const ph = toAdd.map(() => "?").join(",");
        db.prepare(
          `UPDATE repair_cases SET workflow_status = 'VENDA_ESTADO', updated_at = datetime('now')
           WHERE id IN (${ph})`
        ).run(...toAdd);
      }
    }

    const inconsistentCount = input.advancedOnlyCases.filter((c) => c.workflowInconsistent).length;

    const result = {
      casesEvaluated: output.stats.casesEvaluated,
      fullKitsFound: output.stats.match,
      partialKitsFound: output.stats.matchParcial,
      verificarCount: output.stats.verificar,
      casesChanged: persisted.casesChanged,
      advancedProtectedCount: input.advancedOnlyCases.length,
      inconsistentWorkflowCount: inconsistentCount,
    };

    db.prepare(`
      UPDATE repair_match_runs SET
        status = 'COMPLETED', finished_at = datetime('now'),
        cases_evaluated = ?, full_kits_found = ?, partial_kits_found = ?, cases_changed = ?
      WHERE id = ?
    `).run(result.casesEvaluated, result.fullKitsFound, result.partialKitsFound, result.casesChanged, runId);

    // Registra diagnóstico de casos protegidos com workflow inconsistente.
    if (inconsistentCount > 0) {
      const list = input.advancedOnlyCases
        .filter((c) => c.workflowInconsistent)
        .map((c) => `#${c.caseId}(${c.workflowStatus})`)
        .join(", ");
      db.prepare(
        "INSERT INTO match_recompute_requests (reason, entity_type, entity_id, processed_at) VALUES (?,?,?,datetime('now'))"
      ).run(
        `ADVANCED_PART_STATUS_WITH_INCONSISTENT_WORKFLOW: ${list}`,
        "diagnostic",
        runId,
      );
    }

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
// Persistência transacional das decisões
// ---------------------------------------------------------------------------

/** Estados que o motor jamais sobrescreve em repair_cases. */
const LOCKED_WORKFLOW = new Set([
  "APTO_REPARO", "EM_SEPARACAO", "DIRECIONADO_TECNICO", "EM_REPARO",
  "REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO",
  "CONCLUIDO", "VENDA_ESTADO", "CANCELADO",
]);

function persistDecisions(
  db: Db,
  runId: number,
  input: LoadedEngineInput,
  decisions: CaseDecision[],
): { casesChanged: number } {
  let casesChanged = 0;

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM repair_match_results WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM repair_match_case_results WHERE run_id = ?").run(runId);

    const insertPartResult = db.prepare(`
      INSERT INTO repair_match_results
        (run_id, repair_case_id, part_request_id, chave_peca, chave_peca_norm,
         allocated_reference, allocated_reference_norm,
         result_status, allocated_units, margin_points, age_points, score, priority_rank,
         alias_stock_chave_norm)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const insertCaseResult = db.prepare(`
      INSERT INTO repair_match_case_results
        (run_id, repair_case_id, eligible, result_status, verify_reasons_json,
         margin, margin_points, age_points, score, priority_rank,
         rule_set_id, rule_set_version, deposito_atual)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const setPartStatus = db.prepare(
      "UPDATE part_requests SET status = ?, updated_at = datetime('now') WHERE id = ?",
    );

    const depositoByCase = new Map(input.cases.map((c) => [c.caseId, c.depositoAtual]));

    for (const dec of decisions) {
      insertCaseResult.run(
        runId, dec.caseId, dec.eligible ? 1 : 0, dec.result,
        dec.verifyReasons.length > 0 ? JSON.stringify(dec.verifyReasons) : null,
        dec.margin, dec.marginPoints, dec.agePoints, dec.score, dec.rank,
        dec.activeRuleId, dec.activeRuleVersion,
        depositoByCase.get(dec.caseId) ?? null,
      );

      for (const p of dec.requiredParts) {
        const isAlloc = p.allocatedReference !== null;
        insertPartResult.run(
          runId, dec.caseId, p.partRequestId,
          p.chavePeca, p.chavePecaNorm,
          p.allocatedReference, p.allocatedReferenceNorm,
          p.resultStatus, isAlloc ? 1 : 0,
          dec.marginPoints ?? 0, dec.agePoints ?? 0, dec.score ?? 0, dec.rank,
          p.aliasStockChaveNorm,
        );

        // Atualização de status da peça (nunca toca peças travadas — o loader
        // já exclui RESERVADA/SEPARADA/CONSUMIDA/CANCELADA)
        const current = input.partStatusById.get(p.partRequestId);
        if (!current) continue;
        if (p.resultStatus === "MATCH" || p.resultStatus === "MATCH_PARCIAL") {
          if (current === "PEDIR_PECA" || current === "VERIFICAR" || current === "AGUARDANDO_RECEBIMENTO") {
            setPartStatus.run("INDICADA", p.partRequestId);
          }
        } else if (p.resultStatus === "AGUARDANDO_RECEBIMENTO") {
          if (current === "PEDIR_PECA" || current === "INDICADA") {
            setPartStatus.run("AGUARDANDO_RECEBIMENTO", p.partRequestId);
          }
        } else if (p.resultStatus === "PEDIR_PECA") {
          if (current === "INDICADA" || current === "AGUARDANDO_RECEBIMENTO") {
            setPartStatus.run("PEDIR_PECA", p.partRequestId);
          }
        }
        // VERIFICAR (caso inelegível): status da peça permanece como está.
      }

      // Workflow do caso — preserva estados travados e nunca regride
      // AGUARDANDO_RECEBIMENTO→PEDIR_PECA enquanto houver pedido ativo.
      const prevStatus = input.workflowByCase.get(dec.caseId);
      if (prevStatus === undefined || LOCKED_WORKFLOW.has(prevStatus)) continue;
      if (prevStatus === dec.result) continue;
      if (prevStatus === "AGUARDANDO_RECEBIMENTO" && dec.result === "PEDIR_PECA") {
        const caseHasActiveOrder = dec.requiredParts.some((p) => input.activeOrderPartIds.has(p.partRequestId));
        if (caseHasActiveOrder) continue;
      }
      db.prepare(
        "UPDATE repair_cases SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(dec.result, dec.caseId);
      casesChanged++;
    }

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }

  return { casesChanged };
}
