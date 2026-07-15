/**
 * Simulação dry-run do motor de match.
 *
 * Roda o mesmo algoritmo de executeEngine em memória, sem escrever no banco:
 * - NÃO cria repair_match_run
 * - NÃO insere repair_match_results
 * - NÃO altera repair_cases
 * - NÃO altera part_requests
 *
 * Opcionalmente compara o resultado com a regra ativa atual.
 */

import type { Db } from "../db/database.js";
import { getActiveRuleSet, getRuleSetById, computeScore, type MatchRuleSet } from "./match-rule-service.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

// Depósitos válidos para MATCH/MATCH_PARCIAL/APTO_REPARO (espelha pós-processamento do motor real)
const DEPOSITOS_MATCH_VALIDOS = new Set(["AGUARDANDO PECA", "MANUTENCAO INTERNA"]);

function resolveStockKey(chaveNorm: string | null, resolver: Map<string, string>): [string | null, boolean] {
  if (!chaveNorm) return [null, false];
  const resolved = resolver.get(chaveNorm);
  if (resolved && resolved !== chaveNorm) return [resolved, true];
  return [chaveNorm, false];
}

interface SimCaseRow {
  id: number;
  workflow_status: string;
  deposito_atual: string | null;
  age_days: number | null;
  margin: number | null;
  manual_priority_active: number;
}

interface SimPartRow {
  id: number;
  repair_case_id: number;
  chave_peca_norm: string | null;
  chave_peca: string | null;
}

type RefStock = Map<string, Map<string, { ref: string; qty: number }>>;

interface SimDecision {
  caseId: number;
  prevStatus: string;
  newStatus: string;
  score: number;
  rank: number;
  depositoAtual: string | null;
}

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface SimulateResult {
  ruleId: number;
  casesEvaluated: number;
  fullKitsFound: number;
  partialKitsFound: number;
  pedirPecaCount: number;
  aguardandoCount: number;
  /** null quando compareWithActive=false ou não há regra ativa */
  changedComparedToActive: number | null;
  changedFullMatchMembership: number | null;
  changedPartialMembership: number | null;
  topChangedCases: Array<{
    caseId: number;
    prevStatusActive: string;
    newStatusSimulated: string;
    scoreActive: number;
    scoreSimulated: number;
  }>;
}

// ---------------------------------------------------------------------------
// Funções auxiliares (duplicam lógica do orchestrator para manter isolamento)
// ---------------------------------------------------------------------------

function buildRefStock(db: Db): { stock: RefStock; resolver: Map<string, string> } {
  const { groups } = getCurrentOperationalStock(db);
  const stock: RefStock = new Map();
  const refToChave = new Map<string, string>();

  for (const g of groups) {
    if (!g.chavePecaNorm || g.availableQuantity <= 0) continue;
    const refNorm = g.referenciaNorm || "";
    let inner = stock.get(g.chavePecaNorm);
    if (!inner) { inner = new Map(); stock.set(g.chavePecaNorm, inner); }
    const prev = inner.get(refNorm);
    if (prev) { prev.qty += g.availableQuantity; }
    else { inner.set(refNorm, { ref: g.referencia || refNorm, qty: g.availableQuantity }); }
    if (g.referencia && !refToChave.has(g.referencia)) {
      refToChave.set(g.referencia, g.chavePecaNorm);
    }
  }

  const catalogRows = db.prepare(
    "SELECT DISTINCT chave_peca_norm, referencia FROM source_inventory_items WHERE chave_peca_norm IS NOT NULL AND referencia IS NOT NULL",
  ).all() as { chave_peca_norm: string; referencia: string }[];
  const resolver = new Map<string, string>();
  for (const r of catalogRows) {
    const stockChave = refToChave.get(r.referencia);
    if (stockChave && !resolver.has(r.chave_peca_norm)) {
      resolver.set(r.chave_peca_norm, stockChave);
    }
  }

  let aliasRows: { requested_chave_peca_norm: string; stock_chave_peca_norm: string }[] = [];
  try {
    aliasRows = db.prepare(
      "SELECT requested_chave_peca_norm, stock_chave_peca_norm FROM part_key_aliases WHERE active = 1",
    ).all() as { requested_chave_peca_norm: string; stock_chave_peca_norm: string }[];
  } catch { /* tabela pode não existir em banco antigo */ }
  for (const a of aliasRows) {
    resolver.set(a.requested_chave_peca_norm, a.stock_chave_peca_norm);
  }

  return { stock, resolver };
}

function cloneStock(stock: RefStock): RefStock {
  const clone: RefStock = new Map();
  for (const [k, inner] of stock) {
    clone.set(k, new Map(Array.from(inner).map(([rk, rv]) => [rk, { ...rv }])));
  }
  return clone;
}

function allocateOne(stock: RefStock, chaveNorm: string): boolean {
  const inner = stock.get(chaveNorm);
  if (!inner) return false;
  for (const [refNorm, entry] of inner) {
    if (entry.qty >= 1) {
      entry.qty--;
      if (entry.qty === 0) inner.delete(refNorm);
      return true;
    }
  }
  return false;
}

/**
 * Núcleo da simulação — puro em memória, não toca o banco.
 * Retorna mapa caseId → SimDecision com o status que o motor atribuiria.
 */
function simulateCore(
  cases: SimCaseRow[],
  partsByCase: Map<number, SimPartRow[]>,
  baseStock: RefStock,
  activeOrderPartIds: Set<number>,
  ruleSet: MatchRuleSet,
  resolver: Map<string, string>,
): Map<number, SimDecision> {
  // Pontuar e filtrar casos com peças abertas
  const scored = cases
    .map(c => {
      const caseParts = partsByCase.get(c.id) ?? [];
      const { score } = computeScore(ruleSet, c.age_days, c.margin);
      return { c, caseParts, score, openParts: caseParts.length, isManual: c.manual_priority_active === 1 };
    })
    .filter(x => x.openParts > 0);

  // Ordenar: manual primeiro, maior score, maior margem, menos peças, menor id
  scored.sort((a, b) => {
    if (a.isManual !== b.isManual) return a.isManual ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const ma = a.c.margin ?? -Infinity;
    const mb = b.c.margin ?? -Infinity;
    if (mb !== ma) return mb - ma;
    if (a.openParts !== b.openParts) return a.openParts - b.openParts;
    return a.c.id - b.c.id;
  });

  const workingStock = cloneStock(baseStock);
  const decisions = new Map<number, SimDecision>();
  const fullKitIds = new Set<number>();
  let rank = 1;

  // Passagem 1: kits completos (atômico por cópia)
  for (const sc of scored) {
    const parts = sc.caseParts;
    if (parts.some(p => !p.chave_peca_norm)) continue;

    const resolvedKeys = parts.map(p => resolveStockKey(p.chave_peca_norm!, resolver));
    const neededKeys = new Set(resolvedKeys.map(([k]) => k!).filter(Boolean));
    const tempStock: RefStock = new Map();
    for (const k of neededKeys) {
      const inner = workingStock.get(k);
      tempStock.set(k, inner ? new Map(Array.from(inner).map(([rk, rv]) => [rk, { ...rv }])) : new Map());
    }

    let canFulfill = true;
    for (let i = 0; i < parts.length; i++) {
      const [stockKey] = resolvedKeys[i];
      if (!stockKey) { canFulfill = false; break; }
      let found = false;
      const inner = tempStock.get(stockKey);
      if (inner) {
        for (const [, entry] of inner) {
          if (entry.qty >= 1) { entry.qty--; found = true; break; }
        }
      }
      if (!found) { canFulfill = false; break; }
    }
    if (!canFulfill) continue;

    // Confirmar: aplicar cópia ao estoque real
    for (const [k, tempInner] of tempStock) workingStock.set(k, tempInner);
    fullKitIds.add(sc.c.id);
    decisions.set(sc.c.id, {
      caseId: sc.c.id, prevStatus: sc.c.workflow_status,
      newStatus: "MATCH", score: sc.score, rank: rank++,
      depositoAtual: sc.c.deposito_atual,
    });
  }

  // Passagem 2: saldo restante (guloso)
  for (const sc of scored) {
    if (fullKitIds.has(sc.c.id)) continue;

    let hasPartial = false;
    let hasPedirPeca = false;
    let allPedirPecaHaveOrder = true;

    for (const p of sc.caseParts) {
      if (!p.chave_peca_norm) continue; // sem chave → VERIFICAR, ignora para status do caso
      const [stockKey2] = resolveStockKey(p.chave_peca_norm, resolver);
      const allocated = stockKey2 ? allocateOne(workingStock, stockKey2) : false;
      if (allocated) {
        hasPartial = true;
      } else {
        hasPedirPeca = true;
        if (!activeOrderPartIds.has(p.id)) allPedirPecaHaveOrder = false;
      }
    }

    let newStatus: string;
    if (hasPartial) {
      newStatus = "MATCH_PARCIAL";
    } else if (hasPedirPeca && allPedirPecaHaveOrder) {
      newStatus = "AGUARDANDO_RECEBIMENTO";
    } else {
      newStatus = "PEDIR_PECA";
    }

    decisions.set(sc.c.id, {
      caseId: sc.c.id, prevStatus: sc.c.workflow_status,
      newStatus, score: sc.score, rank: rank++,
      depositoAtual: sc.c.deposito_atual,
    });
  }

  // Pós-processamento: espelha o motor real
  // MATCH/MATCH_PARCIAL/APTO_REPARO fora dos depósitos válidos → VERIFICAR
  for (const [caseId, dec] of decisions) {
    if (
      (dec.newStatus === "MATCH" || dec.newStatus === "MATCH_PARCIAL" || dec.newStatus === "APTO_REPARO") &&
      dec.depositoAtual != null &&
      !DEPOSITOS_MATCH_VALIDOS.has(dec.depositoAtual)
    ) {
      decisions.set(caseId, { ...dec, newStatus: "VERIFICAR" });
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Função pública de simulação
// ---------------------------------------------------------------------------

export async function simulateMatchRules(
  db: Db,
  opts: {
    ruleSetId?: number;
    compareWithActive?: boolean;
  },
): Promise<SimulateResult> {
  // Resolver regra a simular
  let rule: MatchRuleSet;
  if (opts.ruleSetId != null) {
    const r = getRuleSetById(db, opts.ruleSetId);
    if (!r) throw new Error("Regra não encontrada.");
    rule = r;
  } else {
    rule = getActiveRuleSet(db);
  }

  // Carregar casos elegíveis (mesma query do executeEngine)
  const cases = db.prepare(`
    SELECT id, workflow_status, deposito_atual, age_days, margin, manual_priority_active
    FROM repair_cases
    WHERE analysis_status = 'COMPLETED'
      AND workflow_status NOT IN (
        'APTO_REPARO','EM_SEPARACAO','CONCLUIDO','VENDA_ESTADO','CANCELADO',
        'DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO'
      )
    ORDER BY id
  `).all() as unknown as SimCaseRow[];

  if (cases.length === 0) {
    return {
      ruleId: rule.id,
      casesEvaluated: 0, fullKitsFound: 0, partialKitsFound: 0,
      pedirPecaCount: 0, aguardandoCount: 0,
      changedComparedToActive: null, changedFullMatchMembership: null,
      changedPartialMembership: null, topChangedCases: [],
    };
  }

  const caseIds = cases.map(c => c.id);
  const placeholders = caseIds.map(() => "?").join(",");

  const parts = db.prepare(`
    SELECT id, repair_case_id, chave_peca_norm, chave_peca
    FROM part_requests
    WHERE repair_case_id IN (${placeholders})
      AND cancelled_at IS NULL
      AND status NOT IN ('CANCELADA','SEPARADA','CONSUMIDA','RESERVADA')
  `).all(...caseIds) as unknown as SimPartRow[];

  const activeOrderPartIds = new Set<number>(
    (db.prepare(`
      SELECT DISTINCT purch.part_request_id
      FROM purchase_requests purch
      JOIN purchase_order_items poi ON poi.purchase_request_id = purch.id
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE purch.part_request_id IS NOT NULL
        AND purch.status = 'ORDERED'
        AND po.status IN ('AWAITING_RECEIPT','PARTIALLY_RECEIVED')
    `).all() as Array<{ part_request_id: number }>).map(r => r.part_request_id),
  );

  const partsByCase = new Map<number, SimPartRow[]>();
  for (const p of parts) {
    const arr = partsByCase.get(p.repair_case_id) ?? [];
    arr.push(p);
    partsByCase.set(p.repair_case_id, arr);
  }

  const { stock: baseStock, resolver } = buildRefStock(db);

  // Simulação com a regra proposta
  const decisionsA = simulateCore(cases, partsByCase, baseStock, activeOrderPartIds, rule, resolver);

  const vals = [...decisionsA.values()];
  const fullKitsFound = vals.filter(d => d.newStatus === "MATCH").length;
  const partialKitsFound = vals.filter(d => d.newStatus === "MATCH_PARCIAL").length;
  const pedirPecaCount = vals.filter(d => d.newStatus === "PEDIR_PECA").length;
  const aguardandoCount = vals.filter(d => d.newStatus === "AGUARDANDO_RECEBIMENTO").length;

  let changedComparedToActive: number | null = null;
  let changedFullMatchMembership: number | null = null;
  let changedPartialMembership: number | null = null;
  const topChangedCases: SimulateResult["topChangedCases"] = [];

  if (opts.compareWithActive) {
    let activeRule: MatchRuleSet | null = null;
    try { activeRule = getActiveRuleSet(db); } catch { /* sem regra ativa — sem comparação */ }

    if (activeRule) {
      // Simulação com regra ativa (estoque recriado para evitar interferência)
      const decisionsB = simulateCore(cases, partsByCase, cloneStock(baseStock), activeOrderPartIds, activeRule, resolver);

      let changed = 0;
      let fullChanged = 0;
      let partialChanged = 0;

      for (const [caseId, decA] of decisionsA) {
        const decB = decisionsB.get(caseId);
        if (!decB || decA.newStatus === decB.newStatus) continue;

        changed++;
        if ((decA.newStatus === "MATCH") !== (decB.newStatus === "MATCH")) fullChanged++;
        if ((decA.newStatus === "MATCH_PARCIAL") !== (decB.newStatus === "MATCH_PARCIAL")) partialChanged++;

        if (topChangedCases.length < 10) {
          topChangedCases.push({
            caseId,
            prevStatusActive: decB.newStatus,
            newStatusSimulated: decA.newStatus,
            scoreActive: decB.score,
            scoreSimulated: decA.score,
          });
        }
      }

      changedComparedToActive = changed;
      changedFullMatchMembership = fullChanged;
      changedPartialMembership = partialChanged;
    }
  }

  return {
    ruleId: rule.id,
    casesEvaluated: decisionsA.size,
    fullKitsFound,
    partialKitsFound,
    pedirPecaCount,
    aguardandoCount,
    changedComparedToActive,
    changedFullMatchMembership,
    changedPartialMembership,
    topChangedCases,
  };
}
