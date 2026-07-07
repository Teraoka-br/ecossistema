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
// Core two-pass matching algorithm (REF-based, atomic commit)
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

/** Estoque disponível indexado por chave_peca_norm → referencia_norm → qty */
type RefStock = Map<string, Map<string, { ref: string; qty: number }>>;

/** Resultado de alocação in-memory (antes do commit). */
interface AllocResult {
  partRequestId: number;
  caseId: number;
  chave: string;
  chaveNorm: string;
  refAllocated: string | null;
  refAllocatedNorm: string | null;
  resultStatus: "MATCH" | "MATCH_PARCIAL" | "PEDIR_PECA" | "VERIFICAR";
  marginPoints: number;
  agePoints: number;
  score: number;
  rank: number;
}

interface CaseDecision {
  caseId: number;
  prevStatus: string;
  newStatus: string;
  parts: AllocResult[];
}

/**
 * Monta estoque disponível por (chavePecaNorm → referenciaNorm → qty) a partir do
 * estoque operacional atual (base importada ou snapshot + movimentações − reservas − bloqueios).
 *
 * Não relê stock_movements diretamente para evitar dupla contagem:
 * getCurrentOperationalStock() já representa o saldo líquido disponível.
 */
function buildRefStock(db: Db): RefStock {
  const { groups } = getCurrentOperationalStock(db);
  const refStock: RefStock = new Map();

  for (const g of groups) {
    if (!g.chavePecaNorm || g.availableQuantity <= 0) continue;
    const refNorm = g.referenciaNorm || "";
    let inner = refStock.get(g.chavePecaNorm);
    if (!inner) { inner = new Map(); refStock.set(g.chavePecaNorm, inner); }
    const prev = inner.get(refNorm);
    if (prev) {
      prev.qty += g.availableQuantity;
    } else {
      inner.set(refNorm, { ref: g.referencia || refNorm, qty: g.availableQuantity });
    }
  }

  return refStock;
}

/**
 * Tenta alocar um kit completo em uma CÓPIA do estoque (atômico).
 * Retorna null se qualquer peça falhar (sem alterar workingStock).
 * Em sucesso, substitui as entradas de workingStock pelas alocações efetivadas.
 */
function tryFullKit(
  workingStock: RefStock,
  parts: PartRow[],
  scoreInfo: { marginPoints: number; agePoints: number; score: number },
  caseRow: CaseRow,
): AllocResult[] | null {
  // Kit completo exige que todas as partes tenham chave_peca_norm
  if (parts.some(p => !p.chave_peca_norm)) return null;

  // Clona apenas as chaves necessárias para a simulação
  const neededChaves = new Set(parts.map(p => p.chave_peca_norm!));
  const tempStock: RefStock = new Map();
  for (const chaveNorm of neededChaves) {
    const inner = workingStock.get(chaveNorm);
    if (!inner) {
      tempStock.set(chaveNorm, new Map());
    } else {
      tempStock.set(chaveNorm, new Map(Array.from(inner).map(([k, v]) => [k, { ...v }])));
    }
  }

  const allocations: AllocResult[] = [];
  let rank = 1;
  for (const p of parts) {
    const alloc = allocateOne(tempStock, p.chave_peca_norm!);
    if (!alloc || alloc.refNorm === "") return null; // kit incompleto — descarta
    allocations.push({
      partRequestId: p.id,
      caseId: caseRow.id,
      chave: p.chave_peca ?? p.chave_peca_norm!,
      chaveNorm: p.chave_peca_norm!,
      refAllocated: alloc.ref || alloc.refNorm,
      refAllocatedNorm: alloc.refNorm,
      resultStatus: "MATCH",
      ...scoreInfo,
      rank: rank++,
    });
  }

  // Sucesso — aplica a cópia mutada ao workingStock real
  for (const [chaveNorm, tempInner] of tempStock) {
    workingStock.set(chaveNorm, tempInner);
  }
  return allocations;
}

/** Tenta alocar 1 unidade de uma chave (qualquer REF disponível). Muta workingStock. */
function allocateOne(
  workingStock: RefStock,
  chaveNorm: string,
): { ref: string; refNorm: string } | null {
  const inner = workingStock.get(chaveNorm);
  if (!inner) return null;
  for (const [refNorm, entry] of inner) {
    if (entry.qty >= 1) {
      entry.qty--;
      if (entry.qty === 0) inner.delete(refNorm);
      return { ref: entry.ref, refNorm };
    }
  }
  return null;
}

function executeEngine(
  db: Db,
  runId: number,
  ruleSet: MatchRuleSet,
): Omit<RepairMatchRunResult, "runId" | "durationMs"> {
  // Load eligible cases — analysis COMPLETED, not locked/committed
  const cases = db.prepare(`
    SELECT id, workflow_status, analysis_status, age_days, margin, manual_priority_active
    FROM repair_cases
    WHERE analysis_status = 'COMPLETED'
      AND workflow_status NOT IN (
        'APTO_REPARO','EM_SEPARACAO',
        'CONCLUIDO','VENDA_ESTADO','CANCELADO',
        'DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO'
      )
    ORDER BY id
  `).all() as unknown as CaseRow[];

  if (cases.length === 0) {
    return { casesEvaluated: 0, fullKitsFound: 0, partialKitsFound: 0, casesChanged: 0 };
  }

  const caseIds = cases.map(c => c.id);
  const placeholders = caseIds.map(() => "?").join(",");
  const parts = db.prepare(`
    SELECT id, repair_case_id, chave_peca_norm, chave_peca, status, cancelled_at
    FROM part_requests
    WHERE repair_case_id IN (${placeholders})
      AND cancelled_at IS NULL
      AND status NOT IN ('CANCELADA','SEPARADA','CONSUMIDA','RESERVADA')
  `).all(...caseIds) as unknown as PartRow[];

  // Identificar part_requests com pedido ativo (ORDERED + pedido AWAITING/PARTIALLY_RECEIVED)
  const activeOrderPartIds = new Set<number>(
    (db.prepare(`
      SELECT DISTINCT purch.part_request_id
      FROM purchase_requests purch
      JOIN purchase_order_items poi ON poi.purchase_request_id = purch.id
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE purch.part_request_id IS NOT NULL
        AND purch.status = 'ORDERED'
        AND po.status IN ('AWAITING_RECEIPT','PARTIALLY_RECEIVED')
    `).all() as Array<{ part_request_id: number }>).map(r => r.part_request_id)
  );

  const partsByCase = new Map<number, PartRow[]>();
  for (const p of parts) {
    const arr = partsByCase.get(p.repair_case_id) ?? [];
    arr.push(p);
    partsByCase.set(p.repair_case_id, arr);
  }

  // Build REF-aware stock (mutable during simulation)
  const workingStock = buildRefStock(db);

  interface ScoredCase {
    caseRow: CaseRow;
    caseParts: PartRow[];
    score: number;
    margin: number | null;
    openParts: number;
    isManualPriority: boolean;
  }

  const scoredCases: ScoredCase[] = [];
  for (const c of cases) {
    const caseParts = partsByCase.get(c.id) ?? [];
    if (caseParts.length === 0) continue;
    const { score } = computeScore(ruleSet, c.age_days, c.margin);
    scoredCases.push({
      caseRow: c, caseParts, score, margin: c.margin,
      openParts: caseParts.length,
      isManualPriority: c.manual_priority_active === 1,
    });
  }

  scoredCases.sort((a, b) => {
    if (a.isManualPriority !== b.isManualPriority) return a.isManualPriority ? -1 : 1;
    if (a.openParts !== b.openParts) return a.openParts - b.openParts;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.margin ?? -Infinity) !== (a.margin ?? -Infinity)) return (b.margin ?? -Infinity) - (a.margin ?? -Infinity);
    return a.caseRow.id - b.caseRow.id;
  });

  // ── In-memory simulation ────────────────────────────────────────────────
  const decisions: CaseDecision[] = [];
  const fullKitCaseIds = new Set<number>();
  let fullKitsFound = 0;
  let partialKitsFound = 0;
  let casesChanged = 0;

  // Pass 1 — full kits: simulação atômica em cópia do estoque; só confirma se TODAS as peças tiverem REF
  for (const sc of scoredCases) {
    if (sc.caseParts.length === 0) continue;
    const { marginPoints, agePoints, score } = computeScore(ruleSet, sc.caseRow.age_days, sc.margin);
    const allocations = tryFullKit(workingStock, sc.caseParts, { marginPoints, agePoints, score }, sc.caseRow);
    if (!allocations) continue;

    decisions.push({ caseId: sc.caseRow.id, prevStatus: sc.caseRow.workflow_status, newStatus: "MATCH", parts: allocations });
    fullKitCaseIds.add(sc.caseRow.id);
    fullKitsFound++;
  }

  // Pass 2 — partial kits
  for (const sc of scoredCases) {
    if (fullKitCaseIds.has(sc.caseRow.id)) continue;

    const { marginPoints, agePoints, score } = computeScore(ruleSet, sc.caseRow.age_days, sc.margin);
    const allocations: AllocResult[] = [];
    let hasPartial = false;
    let hasAll = true;
    let rank = 1;

    for (const p of sc.caseParts) {
      if (!p.chave_peca_norm) {
        allocations.push({
          partRequestId: p.id, caseId: sc.caseRow.id,
          chave: p.chave_peca ?? "", chaveNorm: "",
          refAllocated: null, refAllocatedNorm: null,
          resultStatus: "VERIFICAR", marginPoints, agePoints, score, rank: rank++,
        });
        hasAll = false;
        continue;
      }
      const alloc = allocateOne(workingStock, p.chave_peca_norm);
      if (alloc && alloc.refNorm !== "") {
        allocations.push({
          partRequestId: p.id, caseId: sc.caseRow.id,
          chave: p.chave_peca ?? p.chave_peca_norm, chaveNorm: p.chave_peca_norm,
          refAllocated: alloc.ref || alloc.refNorm, refAllocatedNorm: alloc.refNorm,
          resultStatus: "MATCH_PARCIAL", marginPoints, agePoints, score, rank: rank++,
        });
        hasPartial = true;
      } else {
        allocations.push({
          partRequestId: p.id, caseId: sc.caseRow.id,
          chave: p.chave_peca ?? p.chave_peca_norm, chaveNorm: p.chave_peca_norm,
          refAllocated: null, refAllocatedNorm: null,
          resultStatus: "PEDIR_PECA", marginPoints, agePoints, score, rank: rank++,
        });
        hasAll = false;
      }
    }

    // Determinar newStatus da passagem 2:
    // - MATCH_PARCIAL se alguma peça foi alocada
    // - AGUARDANDO_RECEBIMENTO se nenhuma alocada mas todas as faltantes têm pedido ativo
    // - PEDIR_PECA caso contrário
    let newStatus: string;
    if (hasAll) {
      newStatus = "MATCH";
    } else if (hasPartial) {
      newStatus = "MATCH_PARCIAL";
    } else {
      const allMissingHaveOrder = allocations
        .filter(a => a.resultStatus === "PEDIR_PECA")
        .every(a => activeOrderPartIds.has(a.partRequestId));
      newStatus = allMissingHaveOrder && allocations.some(a => a.resultStatus === "PEDIR_PECA")
        ? "AGUARDANDO_RECEBIMENTO"
        : "PEDIR_PECA";
    }

    decisions.push({ caseId: sc.caseRow.id, prevStatus: sc.caseRow.workflow_status, newStatus, parts: allocations });
    if (hasPartial) partialKitsFound++;
  }

  // ── Atomic DB commit ────────────────────────────────────────────────────
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM repair_match_results WHERE run_id = ?").run(runId);

    const insertResult = db.prepare(`
      INSERT OR REPLACE INTO repair_match_results
        (run_id, repair_case_id, part_request_id, chave_peca, chave_peca_norm,
         allocated_reference, allocated_reference_norm,
         result_status, allocated_units, margin_points, age_points, score, priority_rank)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const dec of decisions) {
      for (const a of dec.parts) {
        const isAlloc = a.resultStatus === "MATCH" || a.resultStatus === "MATCH_PARCIAL";
        insertResult.run(
          runId, a.caseId, a.partRequestId,
          a.chave, a.chaveNorm || null,
          a.refAllocated, a.refAllocatedNorm,
          a.resultStatus, isAlloc ? 1 : 0,
          a.marginPoints, a.agePoints, a.score, a.rank,
        );
      }

      // Update part_request statuses
      for (const a of dec.parts) {
        const part = parts.find(p => p.id === a.partRequestId);
        if (!part) continue;
        if (a.resultStatus === "MATCH" || a.resultStatus === "MATCH_PARCIAL") {
          // Peça alocada: promover para INDICADA (de PEDIR_PECA, VERIFICAR ou AGUARDANDO_RECEBIMENTO)
          if (part.status === "PEDIR_PECA" || part.status === "VERIFICAR" || part.status === "AGUARDANDO_RECEBIMENTO") {
            db.prepare("UPDATE part_requests SET status = 'INDICADA', updated_at = datetime('now') WHERE id = ?").run(a.partRequestId);
          }
        } else if (a.resultStatus === "PEDIR_PECA") {
          // Peça não alocada
          if (activeOrderPartIds.has(a.partRequestId)) {
            // Tem pedido ativo — manter/definir AGUARDANDO_RECEBIMENTO
            if (part.status === "PEDIR_PECA" || part.status === "INDICADA") {
              db.prepare("UPDATE part_requests SET status = 'AGUARDANDO_RECEBIMENTO', updated_at = datetime('now') WHERE id = ?").run(a.partRequestId);
            }
          } else {
            // Sem pedido ativo — devolve para PEDIR_PECA se estava em INDICADA ou AGUARDANDO_RECEBIMENTO
            if (part.status === "INDICADA" || part.status === "AGUARDANDO_RECEBIMENTO") {
              db.prepare("UPDATE part_requests SET status = 'PEDIR_PECA', updated_at = datetime('now') WHERE id = ?").run(a.partRequestId);
            }
          }
        } else if (a.resultStatus === "VERIFICAR") {
          // Mantém VERIFICAR — não promove nem regride
        }
      }

      // Update workflow_status (do not demote APTO_REPARO/AGUARDANDO_RECEBIMENTO→PEDIR_PECA etc.)
      // AGUARDANDO_RECEBIMENTO é bloqueado: só o recebimento real ou cancelamento de pedido o muda
      const lockedStatuses = new Set(["APTO_REPARO","EM_SEPARACAO","DIRECIONADO_TECNICO","EM_REPARO","REPARO_EXECUTADO","TRIAGEM_FINAL","RETORNO_TECNICO","CONCLUIDO","VENDA_ESTADO","CANCELADO"]);
      // Não regredir AGUARDANDO_RECEBIMENTO para PEDIR_PECA enquanto há pedido ativo
      if (dec.prevStatus === "AGUARDANDO_RECEBIMENTO" && dec.newStatus === "PEDIR_PECA") {
        const caseHasActiveOrder = dec.parts.some(a => activeOrderPartIds.has(a.partRequestId));
        if (caseHasActiveOrder) continue; // skip this case's workflow update
      }
      if (!lockedStatuses.has(dec.prevStatus) && dec.prevStatus !== dec.newStatus) {
        db.prepare(
          "UPDATE repair_cases SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(dec.newStatus, dec.caseId);
        casesChanged++;
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }

  return {
    casesEvaluated: scoredCases.length,
    fullKitsFound,
    partialKitsFound,
    casesChanged,
  };
}
