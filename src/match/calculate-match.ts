/**
 * MOTOR ÚNICO DE MATCH — função pura canônica.
 *
 * Esta é a ÚNICA implementação da decisão de match do sistema. É usada por:
 *   - motor real (engine-orchestrator.ts — carrega dados, chama, persiste);
 *   - simulador de regras (simulate-service.ts — dry-run);
 *   - testes automatizados e diagnóstico.
 *
 * Contratos:
 *   - NÃO acessa banco, NÃO faz HTTP, NÃO cria reservas/movimentações,
 *     NÃO altera estados — recebe dados normalizados e retorna decisões.
 *   - Determinística: mesmo input ⇒ mesmo output.
 *   - PROIBIDO ARREDONDAR: score usa o resultado decimal exato das divisões
 *     (sem floor/ceil/round/trunc/divisão inteira). A formatação é problema
 *     da interface, nunca do motor.
 *   - O motor apenas SINALIZA possibilidades sobre uma cópia virtual do
 *     estoque disponível; a reserva real acontece só na separação manual.
 */

import { stripAccents, collapseSpaces } from "../domain/text.js";

// ---------------------------------------------------------------------------
// Regra ativa
// ---------------------------------------------------------------------------

export interface ActiveRule {
  id: number;
  version: number;
  name: string | null;
  /** R$ de margem para somar 1 ponto (ex.: 150). */
  marginAmountPerPoint: number;
  /** Dias de idade para somar 1 ponto (ex.: 30). */
  ageDaysPerPoint: number;
  /** Teto da parcela de idade, em pontos (ex.: 12). */
  ageMaxPoints: number;
  /** Se margem negativa pune o score proporcionalmente. */
  allowNegativeMarginScore: boolean;
  marginWeight: number;
  ageWeight: number;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MatchPartInput {
  partRequestId: number;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  /** Existe pedido de compra ativo aguardando chegada para esta peça. */
  hasActiveOrder: boolean;
}

export interface MatchCaseInput {
  caseId: number;
  imei: string | null;
  model: string | null;
  cost: number | null;
  estimatedSale: number | null;
  ageDays: number | null;
  /** Depósito atual — fonte automática: Rel. Estoque de Seriais com saldo. */
  depositoAtual: string | null;
  workflowStatus: string;
  manualPriority: boolean;
  parts: MatchPartInput[];
}

export interface StockGroupInput {
  chavePecaNorm: string;
  referencia: string;
  referenciaNorm: string;
  availableQuantity: number;
}

/**
 * Resolução de chave solicitada → chave de estoque.
 *  - aliases: vínculos manuais de compatibilidade (prioridade máxima);
 *  - catalog: mapeamento via catálogo (chave → chaves de estoque possíveis,
 *    derivado de referência física). Mais de um alvo distinto sem alias é
 *    ambiguidade ⇒ VERIFICAR (nunca escolher silenciosamente).
 */
export interface CompatibilityInput {
  aliases: ReadonlyMap<string, string>;
  catalog: ReadonlyMap<string, readonly string[]>;
}

export interface CalculateMatchInput {
  cases: MatchCaseInput[];
  availableStock: StockGroupInput[];
  activeRule: ActiveRule;
  compatibility: CompatibilityInput;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const VERIFY_REASONS = {
  IMEI_AUSENTE: "IMEI_AUSENTE",
  MODELO_AUSENTE: "MODELO_AUSENTE",
  CUSTO_AUSENTE: "CUSTO_AUSENTE",
  VENDA_ESTIMADA_AUSENTE: "VENDA_ESTIMADA_AUSENTE",
  IDADE_AUSENTE: "IDADE_AUSENTE",
  DEPOSITO_NAO_IDENTIFICADO: "DEPOSITO_NAO_IDENTIFICADO",
  DEPOSITO_FORA_DO_FLUXO: "DEPOSITO_FORA_DO_FLUXO",
  PECA_NECESSARIA_AUSENTE: "PECA_NECESSARIA_AUSENTE",
  REFERENCIA_PECA_NAO_RESOLVIDA: "REFERENCIA_PECA_NAO_RESOLVIDA",
  MAIS_DE_UMA_REFERENCIA_POSSIVEL: "MAIS_DE_UMA_REFERENCIA_POSSIVEL",
} as const;

export type VerifyReason = (typeof VERIFY_REASONS)[keyof typeof VERIFY_REASONS];

export const VERIFY_REASON_LABELS: Record<VerifyReason, string> = {
  IMEI_AUSENTE: "IMEI ausente",
  MODELO_AUSENTE: "Modelo ausente",
  CUSTO_AUSENTE: "Custo ausente",
  VENDA_ESTIMADA_AUSENTE: "Venda estimada ausente",
  IDADE_AUSENTE: "Idade ausente",
  DEPOSITO_NAO_IDENTIFICADO: "Depósito não identificado",
  DEPOSITO_FORA_DO_FLUXO: "Depósito fora do fluxo",
  PECA_NECESSARIA_AUSENTE: "Peça necessária ausente",
  REFERENCIA_PECA_NAO_RESOLVIDA: "Referência de peça não resolvida",
  MAIS_DE_UMA_REFERENCIA_POSSIVEL: "Mais de uma referência possível",
};

export type CaseResultStatus =
  | "VERIFICAR"
  | "MATCH"
  | "MATCH_PARCIAL"
  | "PEDIR_PECA"
  | "AGUARDANDO_RECEBIMENTO";

export type PartResultStatus =
  | "VERIFICAR"
  | "MATCH"
  | "MATCH_PARCIAL"
  | "PEDIR_PECA"
  | "AGUARDANDO_RECEBIMENTO";

export type ResolutionVia = "DIRECT" | "ALIAS" | "CATALOG" | "NONE" | "AMBIGUOUS" | "MISSING_KEY";

export interface PartDecision {
  partRequestId: number;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  /** Chave de estoque efetivamente consultada (null se não resolvida). */
  resolvedStockKey: string | null;
  resolutionVia: ResolutionVia;
  resultStatus: PartResultStatus;
  allocatedReference: string | null;
  allocatedReferenceNorm: string | null;
  /** Preenchida quando a alocação usou alias/compatibilidade (≠ chave original). */
  aliasStockChaveNorm: string | null;
}

export interface CaseDecision {
  caseId: number;
  eligible: boolean;
  verifyReasons: VerifyReason[];
  margin: number | null;
  marginPoints: number | null;
  agePoints: number | null;
  score: number | null;
  /** Posição na disputa entre os elegíveis (1 = primeiro). null se inelegível. */
  rank: number | null;
  result: CaseResultStatus;
  requiredParts: PartDecision[];
  virtuallyAllocatedParts: PartDecision[];
  missingParts: PartDecision[];
  compatibilityResolutions: Array<{
    partRequestId: number;
    requestedChaveNorm: string;
    stockChaveNorm: string;
    via: ResolutionVia;
  }>;
  activeRuleId: number;
  activeRuleVersion: number;
}

export interface CalculateMatchOutput {
  activeRuleId: number;
  activeRuleVersion: number;
  cases: CaseDecision[];
  stats: {
    casesEvaluated: number;
    eligible: number;
    verificar: number;
    match: number;
    matchParcial: number;
    pedirPeca: number;
    aguardandoRecebimento: number;
  };
  /** Chaves de estoque com demanda maior que a disponibilidade (disputa). */
  disputedKeys: Array<{ stockChaveNorm: string; demanded: number; available: number }>;
}

// ---------------------------------------------------------------------------
// Depósito — normalização apenas para comparação
// ---------------------------------------------------------------------------

/** Únicos depósitos elegíveis para o fluxo de peças (forma normalizada). */
export const DEPOSITOS_VALIDOS = ["AGUARDANDO PECA", "MANUTENCAO INTERNA"] as const;

export function normalizeDeposito(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = collapseSpaces(stripAccents(String(value))).toUpperCase();
  return n === "" ? null : n;
}

export function isDepositoElegivel(value: string | null | undefined): boolean {
  const n = normalizeDeposito(value);
  return n !== null && (DEPOSITOS_VALIDOS as readonly string[]).includes(n);
}

// ---------------------------------------------------------------------------
// Score — precisão decimal completa, SEM arredondamento
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  margin: number;
  marginPoints: number;
  agePoints: number;
  score: number;
}

export function computeRuleScore(
  rule: ActiveRule,
  margin: number,
  ageDays: number,
): ScoreBreakdown {
  let marginPoints = margin / rule.marginAmountPerPoint;
  if (!rule.allowNegativeMarginScore && marginPoints < 0) marginPoints = 0;

  const ageRaw = ageDays / rule.ageDaysPerPoint;
  const agePoints = Math.min(Math.max(ageRaw, 0), rule.ageMaxPoints);

  const score = marginPoints * rule.marginWeight + agePoints * rule.ageWeight;
  return { margin, marginPoints, agePoints, score };
}

// ---------------------------------------------------------------------------
// Estoque virtual
// ---------------------------------------------------------------------------

/** chaveNorm → refNorm → { ref, qty } (ordenado por refNorm para determinismo). */
type VirtualStock = Map<string, Map<string, { ref: string; qty: number }>>;

function buildVirtualStock(groups: StockGroupInput[]): VirtualStock {
  const stock: VirtualStock = new Map();
  const sorted = [...groups].sort(
    (a, b) =>
      a.chavePecaNorm.localeCompare(b.chavePecaNorm) ||
      a.referenciaNorm.localeCompare(b.referenciaNorm),
  );
  for (const g of sorted) {
    if (!g.chavePecaNorm || g.availableQuantity <= 0) continue;
    let inner = stock.get(g.chavePecaNorm);
    if (!inner) {
      inner = new Map();
      stock.set(g.chavePecaNorm, inner);
    }
    const prev = inner.get(g.referenciaNorm);
    if (prev) prev.qty += g.availableQuantity;
    else inner.set(g.referenciaNorm, { ref: g.referencia || g.referenciaNorm, qty: g.availableQuantity });
  }
  return stock;
}

function cloneStockKeys(stock: VirtualStock, keys: Iterable<string>): VirtualStock {
  const copy: VirtualStock = new Map();
  for (const k of keys) {
    const inner = stock.get(k);
    copy.set(k, inner ? new Map(Array.from(inner, ([rk, rv]) => [rk, { ...rv }])) : new Map());
  }
  return copy;
}

/** Aloca 1 unidade da chave (primeira referência disponível, ordem determinística). */
function allocateOne(
  stock: VirtualStock,
  chaveNorm: string,
): { ref: string; refNorm: string } | null {
  const inner = stock.get(chaveNorm);
  if (!inner) return null;
  for (const [refNorm, entry] of inner) {
    if (entry.qty >= 1) {
      entry.qty -= 1;
      if (entry.qty === 0) inner.delete(refNorm);
      return { ref: entry.ref, refNorm };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolução de referência (compatibilidade)
// ---------------------------------------------------------------------------

interface KeyResolution {
  stockKey: string | null;
  via: ResolutionVia;
  ambiguousTargets?: string[];
}

function resolveKey(
  chaveNorm: string | null,
  stockKeys: ReadonlySet<string>,
  compat: CompatibilityInput,
): KeyResolution {
  if (!chaveNorm) return { stockKey: null, via: "MISSING_KEY" };

  // 1. Alias manual tem prioridade absoluta (compatibilidade autorizada).
  const alias = compat.aliases.get(chaveNorm);
  if (alias) return { stockKey: alias, via: "ALIAS" };

  // 2. A própria chave existe no estoque.
  if (stockKeys.has(chaveNorm)) return { stockKey: chaveNorm, via: "DIRECT" };

  // 3. Catálogo: chave → chaves de estoque via referência física.
  const targets = Array.from(
    new Set((compat.catalog.get(chaveNorm) ?? []).filter((t) => t && t !== chaveNorm && stockKeys.has(t))),
  ).sort();
  if (targets.length === 1) return { stockKey: targets[0], via: "CATALOG" };
  if (targets.length > 1) return { stockKey: null, via: "AMBIGUOUS", ambiguousTargets: targets };

  // 4. Sem correspondência no estoque — chave resolvida para si mesma (sem saldo).
  return { stockKey: chaveNorm, via: "NONE" };
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

export function calculateMatch(input: CalculateMatchInput): CalculateMatchOutput {
  const { cases, availableStock, activeRule, compatibility } = input;

  const virtualStock = buildVirtualStock(availableStock);
  const stockKeys: ReadonlySet<string> = new Set(virtualStock.keys());

  // ── 1. Elegibilidade + score ─────────────────────────────────────────────
  interface Evaluated {
    input: MatchCaseInput;
    verifyReasons: VerifyReason[];
    eligible: boolean;
    margin: number | null;
    breakdown: ScoreBreakdown | null;
    resolutions: Map<number, KeyResolution>; // partRequestId → resolução
  }

  const evaluated: Evaluated[] = cases.map((c) => {
    const reasons: VerifyReason[] = [];

    if (!c.imei || String(c.imei).trim() === "") reasons.push(VERIFY_REASONS.IMEI_AUSENTE);
    if (!c.model || String(c.model).trim() === "") reasons.push(VERIFY_REASONS.MODELO_AUSENTE);
    if (c.cost === null || c.cost === undefined || Number.isNaN(c.cost))
      reasons.push(VERIFY_REASONS.CUSTO_AUSENTE);
    if (c.estimatedSale === null || c.estimatedSale === undefined || Number.isNaN(c.estimatedSale))
      reasons.push(VERIFY_REASONS.VENDA_ESTIMADA_AUSENTE);
    if (c.ageDays === null || c.ageDays === undefined || Number.isNaN(c.ageDays))
      reasons.push(VERIFY_REASONS.IDADE_AUSENTE);

    const depositoNorm = normalizeDeposito(c.depositoAtual);
    if (depositoNorm === null) reasons.push(VERIFY_REASONS.DEPOSITO_NAO_IDENTIFICADO);
    else if (!(DEPOSITOS_VALIDOS as readonly string[]).includes(depositoNorm))
      reasons.push(VERIFY_REASONS.DEPOSITO_FORA_DO_FLUXO);

    if (c.parts.length === 0) reasons.push(VERIFY_REASONS.PECA_NECESSARIA_AUSENTE);

    const resolutions = new Map<number, KeyResolution>();
    let hasUnresolved = false;
    let hasAmbiguous = false;
    for (const p of c.parts) {
      const r = resolveKey(p.chavePecaNorm, stockKeys, compatibility);
      resolutions.set(p.partRequestId, r);
      if (r.via === "MISSING_KEY") hasUnresolved = true;
      if (r.via === "AMBIGUOUS") hasAmbiguous = true;
    }
    if (hasUnresolved) reasons.push(VERIFY_REASONS.REFERENCIA_PECA_NAO_RESOLVIDA);
    if (hasAmbiguous) reasons.push(VERIFY_REASONS.MAIS_DE_UMA_REFERENCIA_POSSIVEL);

    const eligible = reasons.length === 0;

    // margem = venda estimada − custo (decimal exato)
    const margin =
      c.cost !== null && c.cost !== undefined && !Number.isNaN(c.cost) &&
      c.estimatedSale !== null && c.estimatedSale !== undefined && !Number.isNaN(c.estimatedSale)
        ? c.estimatedSale - c.cost
        : null;

    const breakdown =
      eligible && margin !== null && c.ageDays !== null && c.ageDays !== undefined
        ? computeRuleScore(activeRule, margin, c.ageDays)
        : null;

    return { input: c, verifyReasons: reasons, eligible, margin, breakdown, resolutions };
  });

  // ── 2. Ordenação dos elegíveis ───────────────────────────────────────────
  // Prioridade manual (recurso operacional existente) antecede a disputa;
  // dentro dela e do restante: maior score → maior margem → maior idade →
  // menor ID do caso (desempate técnico determinístico).
  const eligibleCases = evaluated.filter((e) => e.eligible && e.breakdown !== null);
  eligibleCases.sort((a, b) => {
    if (a.input.manualPriority !== b.input.manualPriority) return a.input.manualPriority ? -1 : 1;
    const sa = a.breakdown!.score;
    const sb = b.breakdown!.score;
    if (sb !== sa) return sb - sa;
    if (b.breakdown!.margin !== a.breakdown!.margin) return b.breakdown!.margin - a.breakdown!.margin;
    const ia = a.input.ageDays ?? 0;
    const ib = b.input.ageDays ?? 0;
    if (ib !== ia) return ib - ia;
    return a.input.caseId - b.input.caseId;
  });

  const rankByCase = new Map<number, number>();
  eligibleCases.forEach((e, i) => rankByCase.set(e.input.caseId, i + 1));

  // ── Demanda por chave (para relatório de disputa) ───────────────────────
  const demandByKey = new Map<string, number>();
  for (const e of eligibleCases) {
    for (const p of e.input.parts) {
      const r = e.resolutions.get(p.partRequestId)!;
      if (r.stockKey) demandByKey.set(r.stockKey, (demandByKey.get(r.stockKey) ?? 0) + 1);
    }
  }

  // ── 3. Primeira passagem — kits completos (alocação atômica) ────────────
  const fullKitAllocations = new Map<number, Map<number, { ref: string; refNorm: string }>>();

  for (const e of eligibleCases) {
    const keysNeeded = new Set<string>();
    let allResolvable = true;
    for (const p of e.input.parts) {
      const r = e.resolutions.get(p.partRequestId)!;
      if (!r.stockKey) {
        allResolvable = false;
        break;
      }
      keysNeeded.add(r.stockKey);
    }
    if (!allResolvable) continue;

    // Simula em cópia — nada é preso se qualquer peça faltar.
    const temp = cloneStockKeys(virtualStock, keysNeeded);
    const allocs = new Map<number, { ref: string; refNorm: string }>();
    let complete = true;
    for (const p of e.input.parts) {
      const r = e.resolutions.get(p.partRequestId)!;
      const got = allocateOne(temp, r.stockKey!);
      if (!got) {
        complete = false;
        break;
      }
      allocs.set(p.partRequestId, got);
    }
    if (!complete) continue;

    // Kit completo: efetiva a cópia mutada no estoque virtual.
    for (const [k, inner] of temp) virtualStock.set(k, inner);
    fullKitAllocations.set(e.input.caseId, allocs);
  }

  // ── 4. Segunda passagem — parciais somente com as sobras ────────────────
  const partialAllocations = new Map<number, Map<number, { ref: string; refNorm: string }>>();

  for (const e of eligibleCases) {
    if (fullKitAllocations.has(e.input.caseId)) continue;
    const allocs = new Map<number, { ref: string; refNorm: string }>();
    for (const p of e.input.parts) {
      const r = e.resolutions.get(p.partRequestId)!;
      if (!r.stockKey) continue;
      const got = allocateOne(virtualStock, r.stockKey);
      if (got) allocs.set(p.partRequestId, got);
    }
    if (allocs.size > 0) partialAllocations.set(e.input.caseId, allocs);
  }

  // ── 5. Montagem das decisões ─────────────────────────────────────────────
  const decisions: CaseDecision[] = evaluated.map((e) => {
    const c = e.input;

    const makePart = (p: MatchPartInput, resultStatus: PartResultStatus, alloc?: { ref: string; refNorm: string } | null): PartDecision => {
      const r = e.resolutions.get(p.partRequestId)!;
      const aliasUsed = r.stockKey !== null && p.chavePecaNorm !== null && r.stockKey !== p.chavePecaNorm;
      return {
        partRequestId: p.partRequestId,
        chavePeca: p.chavePeca,
        chavePecaNorm: p.chavePecaNorm,
        resolvedStockKey: r.stockKey,
        resolutionVia: r.via,
        resultStatus,
        allocatedReference: alloc?.ref ?? null,
        allocatedReferenceNorm: alloc?.refNorm ?? null,
        aliasStockChaveNorm: alloc && aliasUsed ? r.stockKey : null,
      };
    };

    let result: CaseResultStatus;
    let parts: PartDecision[];

    if (!e.eligible) {
      result = "VERIFICAR";
      parts = c.parts.map((p) => makePart(p, "VERIFICAR"));
    } else if (fullKitAllocations.has(c.caseId)) {
      result = "MATCH";
      const allocs = fullKitAllocations.get(c.caseId)!;
      parts = c.parts.map((p) => makePart(p, "MATCH", allocs.get(p.partRequestId)));
    } else {
      const allocs = partialAllocations.get(c.caseId) ?? new Map<number, { ref: string; refNorm: string }>();
      parts = c.parts.map((p) => {
        const alloc = allocs.get(p.partRequestId);
        if (alloc) return makePart(p, "MATCH_PARCIAL", alloc);
        return makePart(p, p.hasActiveOrder ? "AGUARDANDO_RECEBIMENTO" : "PEDIR_PECA");
      });
      const hasPartial = allocs.size > 0;
      const missing = parts.filter((p) => p.allocatedReference === null);
      if (hasPartial) {
        result = "MATCH_PARCIAL";
      } else if (missing.length > 0 && missing.every((p) => p.resultStatus === "AGUARDANDO_RECEBIMENTO")) {
        result = "AGUARDANDO_RECEBIMENTO";
      } else {
        result = "PEDIR_PECA";
      }
    }

    const virtuallyAllocatedParts = parts.filter((p) => p.allocatedReference !== null);
    const missingParts = parts.filter((p) => p.allocatedReference === null);

    const compatibilityResolutions = c.parts
      .map((p) => {
        const r = e.resolutions.get(p.partRequestId)!;
        if (!r.stockKey || !p.chavePecaNorm || r.stockKey === p.chavePecaNorm) return null;
        return {
          partRequestId: p.partRequestId,
          requestedChaveNorm: p.chavePecaNorm,
          stockChaveNorm: r.stockKey,
          via: r.via,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      caseId: c.caseId,
      eligible: e.eligible,
      verifyReasons: e.verifyReasons,
      margin: e.margin,
      marginPoints: e.breakdown?.marginPoints ?? null,
      agePoints: e.breakdown?.agePoints ?? null,
      score: e.breakdown?.score ?? null,
      rank: rankByCase.get(c.caseId) ?? null,
      result,
      requiredParts: parts,
      virtuallyAllocatedParts,
      missingParts,
      compatibilityResolutions,
      activeRuleId: activeRule.id,
      activeRuleVersion: activeRule.version,
    };
  });

  // ── 6. Estatísticas + disputa ────────────────────────────────────────────
  const stats = {
    casesEvaluated: decisions.length,
    eligible: decisions.filter((d) => d.eligible).length,
    verificar: decisions.filter((d) => d.result === "VERIFICAR").length,
    match: decisions.filter((d) => d.result === "MATCH").length,
    matchParcial: decisions.filter((d) => d.result === "MATCH_PARCIAL").length,
    pedirPeca: decisions.filter((d) => d.result === "PEDIR_PECA").length,
    aguardandoRecebimento: decisions.filter((d) => d.result === "AGUARDANDO_RECEBIMENTO").length,
  };

  const initialAvailability = new Map<string, number>();
  for (const g of availableStock) {
    if (!g.chavePecaNorm || g.availableQuantity <= 0) continue;
    initialAvailability.set(g.chavePecaNorm, (initialAvailability.get(g.chavePecaNorm) ?? 0) + g.availableQuantity);
  }
  const disputedKeys = Array.from(demandByKey.entries())
    .map(([stockChaveNorm, demanded]) => ({
      stockChaveNorm,
      demanded,
      available: initialAvailability.get(stockChaveNorm) ?? 0,
    }))
    .filter((d) => d.demanded > d.available)
    .sort((a, b) => b.demanded - b.available - (a.demanded - a.available) || a.stockChaveNorm.localeCompare(b.stockChaveNorm));

  return {
    activeRuleId: activeRule.id,
    activeRuleVersion: activeRule.version,
    cases: decisions,
    stats,
    disputedKeys,
  };
}
