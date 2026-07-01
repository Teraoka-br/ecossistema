import type { Db } from "../db/database.js";
import { config } from "../server/config.js";
import { normalizeKey } from "../domain/text.js";
import { resolveReference, type ReferenceResolution } from "../domain/reference-catalog.js";
import { getActiveBatch } from "../db/repository.js";
import * as repo from "../db/counting-repository.js";
import * as q from "../db/counting-queries.js";
import { countMovementsAfter, getCurrentOperationalStock, maxMovementId } from "../operational/stock-service.js";
import type {
  CountScanRow,
  CountSessionRow,
  ReferenceMappingRow,
  StockSnapshotRow,
} from "../db/counting-repository.js";
import type { FinalizeSummary, PendingReferenceGroup } from "../shared/types.js";

export class CountingError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
    this.name = "CountingError";
  }
}

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const v = (value ?? "").trim();
  if (v === "") throw new CountingError(400, `${field} é obrigatório.`);
  return v;
}

/** Garante que a sessão está OPEN antes de qualquer mutação de scans/mapeamentos. */
function requireOpenSession(session: CountSessionRow): void {
  if (session.status !== "OPEN") {
    throw new CountingError(
      409,
      `Sessão ${session.id} não está aberta (status atual: ${session.status}) — nenhuma alteração é permitida.`,
    );
  }
}

// ===========================================================================
// Sessões
// ===========================================================================

export interface CreateSessionInput {
  responsibleName: string;
  notes?: string | null;
}

/** Cria a sessão vinculada ao lote ativo. Lança 409 com a sessão existente se já houver uma OPEN. */
export function createSession(db: Db, input: CreateSessionInput): CountSessionRow {
  const responsibleName = requireNonEmpty(input.responsibleName, "responsible_name");

  const open = q.getOpenSession(db);
  if (open) {
    throw new CountingError(409, `Já existe uma sessão de contagem aberta (#${open.id}).`, { sessionId: open.id });
  }

  const batch = getActiveBatch(db);
  if (!batch) {
    throw new CountingError(422, "Nenhum lote de importação concluído disponível para servir de catálogo.");
  }

  // Congela a base operacional no início da sessão (Etapa 6): a comparação da
  // sessão usa esse instantâneo, não uma leitura "ao vivo" que mudaria conforme
  // recebimentos acontecem durante a contagem.
  const operational = getCurrentOperationalStock(db);

  try {
    return repo.createSession(db, {
      importBatchId: batch.id,
      responsibleName,
      notes: input.notes?.trim() || null,
      baselineType: operational.base.type,
      baselineSnapshotId: operational.base.snapshotId,
      baselineCutoffMovementId: maxMovementId(db),
      baselineTotalUnits: operational.currentTotal,
    });
  } catch (err) {
    // Corrida rara: o índice único parcial (status='OPEN') pegou uma 2ª tentativa concorrente.
    const stillOpen = q.getOpenSession(db);
    if (stillOpen) {
      throw new CountingError(409, `Já existe uma sessão de contagem aberta (#${stillOpen.id}).`, {
        sessionId: stillOpen.id,
      });
    }
    throw err;
  }
}

export function getActiveSession(db: Db): CountSessionRow | null {
  return q.getOpenSession(db);
}

export function getSessionOrThrow(db: Db, id: number): CountSessionRow {
  const s = q.getSessionById(db, id);
  if (!s) throw new CountingError(404, `Sessão de contagem ${id} não encontrada.`);
  return s;
}

export interface CancelSessionInput {
  cancelledBy: string;
  cancelReason: string;
}

export function cancelSession(db: Db, sessionId: number, input: CancelSessionInput): CountSessionRow {
  const session = getSessionOrThrow(db, sessionId);
  if (session.status !== "OPEN") {
    throw new CountingError(409, `Sessão ${sessionId} não está aberta (status atual: ${session.status}).`);
  }
  const cancelledBy = requireNonEmpty(input.cancelledBy, "responsável");
  const cancelReason = requireNonEmpty(input.cancelReason, "motivo do cancelamento");
  return repo.cancelSession(db, sessionId, { cancelledBy, cancelReason });
}

// ===========================================================================
// Scans (beeps)
// ===========================================================================

function classifyForBatch(db: Db, importBatchId: number, referenceNorm: string): ReferenceResolution {
  const manual = q.getActiveMapping(db, referenceNorm);
  const catalog = q.catalogLookup(db, importBatchId, referenceNorm);
  return resolveReference(manual, catalog);
}

export interface RegisterScanInput {
  reference: string;
  source?: string | null;
}

export interface RegisterScanResult {
  scan: CountScanRow;
  totalForReference: number;
}

/** Cada chamada representa exatamente um beep — nunca consolida nem deduplica aqui. */
export function registerScan(db: Db, sessionId: number, input: RegisterScanInput): RegisterScanResult {
  const session = getSessionOrThrow(db, sessionId);
  requireOpenSession(session);
  const referenceRaw = requireNonEmpty(input.reference, "reference");
  const referenceNorm = normalizeKey(referenceRaw);

  const resolution = classifyForBatch(db, session.import_batch_id!, referenceNorm);

  const scan = repo.insertScan(db, {
    sessionId,
    reference: referenceRaw,
    referenceNorm,
    chavePeca: resolution.chavePeca,
    chavePecaNorm: resolution.chavePecaNorm,
    mappingStatus: resolution.mappingStatus,
    source: input.source?.trim() || null,
  });

  return {
    scan,
    totalForReference: q.activeScanCountForReference(db, sessionId, referenceNorm),
  };
}

export interface CancelScanInput {
  cancelledBy: string;
  cancelReason: string;
}

/** Cancelamento idempotente — nunca executa DELETE. Bloqueado fora de sessão OPEN. */
export function cancelScan(db: Db, scanId: number, input: CancelScanInput): CountScanRow {
  const scan = q.getScanById(db, scanId);
  if (!scan) throw new CountingError(404, `Scan ${scanId} não encontrado.`);
  const session = getSessionOrThrow(db, scan.session_id);
  requireOpenSession(session);

  const cancelledBy = requireNonEmpty(input.cancelledBy, "responsável");
  const cancelReason = requireNonEmpty(input.cancelReason, "motivo do cancelamento");
  const result = repo.cancelScan(db, scanId, { cancelledBy, cancelReason });
  if (!result) throw new CountingError(404, `Scan ${scanId} não encontrado.`);
  return result;
}

export function listScans(db: Db, sessionId: number, opts: { onlyActive?: boolean; limit?: number } = {}): CountScanRow[] {
  getSessionOrThrow(db, sessionId);
  return q.listScansBySession(db, sessionId, opts);
}

// ===========================================================================
// Pendências e resolução manual
// ===========================================================================

/** Pendências = grupos cujo status ainda NÃO é efetivamente RECOGNIZED (mapeamento ativo recalculado agora). */
export function getPending(db: Db, sessionId: number): PendingReferenceGroup[] {
  const session = getSessionOrThrow(db, sessionId);
  const raw = q.pendingGroups(db, sessionId);
  const out: PendingReferenceGroup[] = [];
  for (const r of raw) {
    const manual = q.getActiveMapping(db, r.reference_norm);
    if (manual) continue; // já resolvido por mapeamento manual — não é mais pendência
    let conflictKeys: string[] = [];
    if (r.mapping_status === "CONFLICT" && session.import_batch_id) {
      const catalog = q.catalogLookup(db, session.import_batch_id, r.reference_norm);
      conflictKeys = catalog.distinctKeys.map((k) => k.chavePeca);
    }
    out.push({
      referenceNorm: r.reference_norm,
      reference: r.reference,
      mappingStatus: r.mapping_status,
      activeCount: r.active_count,
      firstScannedAt: r.first_scanned_at,
      lastScannedAt: r.last_scanned_at,
      conflictKeys,
    });
  }
  return out;
}

export interface ResolveReferenceInput {
  referenceNorm: string;
  chavePeca: string;
  responsibleName: string;
  notes?: string | null;
}

/**
 * Resolve manualmente uma referência pendente. A CHAVEPECA precisa existir no
 * catálogo do lote vinculado à sessão — o autocomplete do frontend só sugere
 * chaves válidas, e o backend valida de novo aqui (nunca aceita texto livre).
 */
export function resolveReferenceManually(db: Db, sessionId: number, input: ResolveReferenceInput): ReferenceMappingRow {
  const session = getSessionOrThrow(db, sessionId);
  requireOpenSession(session);
  const referenceNorm = requireNonEmpty(input.referenceNorm, "referenceNorm");
  const chavePeca = requireNonEmpty(input.chavePeca, "chavePeca");
  const responsibleName = requireNonEmpty(input.responsibleName, "responsável");
  const chavePecaNorm = normalizeKey(chavePeca);

  if (!session.import_batch_id) {
    throw new CountingError(422, "Sessão sem lote de importação vinculado — não há catálogo para validar a chave.");
  }
  if (!q.catalogHasKey(db, session.import_batch_id, chavePecaNorm)) {
    throw new CountingError(
      400,
      `CHAVEPECA "${chavePeca}" não existe no catálogo do lote #${session.import_batch_id}. ` +
        `Selecione uma chave válida sugerida pelo autocomplete.`,
    );
  }

  // Usa o valor original mais recente bipado para essa referência (preserva o que foi digitado).
  const recent = db
    .prepare(
      "SELECT reference FROM count_scans WHERE session_id = ? AND reference_norm = ? ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId, referenceNorm) as { reference: string } | undefined;

  return repo.upsertReferenceMapping(db, {
    reference: recent?.reference ?? referenceNorm,
    referenceNorm,
    chavePeca,
    chavePecaNorm,
    createdBy: responsibleName,
    notes: input.notes?.trim() || null,
  });
}

export interface CancelPendingInput {
  referenceNorm: string;
  cancelledBy: string;
  cancelReason: string;
}

export function cancelPendingScans(db: Db, sessionId: number, input: CancelPendingInput): number {
  const session = getSessionOrThrow(db, sessionId);
  requireOpenSession(session);
  const referenceNorm = requireNonEmpty(input.referenceNorm, "referenceNorm");
  const cancelledBy = requireNonEmpty(input.cancelledBy, "responsável");
  const cancelReason = requireNonEmpty(input.cancelReason, "motivo do cancelamento");
  return repo.cancelScansByReference(db, { sessionId, referenceNorm, cancelledBy, cancelReason });
}

// ===========================================================================
// Resumo de finalização
// ===========================================================================

interface EffectiveTotals {
  activeScans: number;
  cancelledScans: number;
  totalScans: number;
  recognizedUnits: number;
  unknownUnits: number;
  missingKeyUnits: number;
  conflictUnits: number;
  distinctReferences: number;
  /** referenceNorm -> { reference, chavePeca, chavePecaNorm, quantity } (status efetivo RECOGNIZED) */
  recognizedByReference: Map<string, { reference: string; chavePeca: string | null; chavePecaNorm: string | null; quantity: number }>;
  absoluteBlockers: string[];
}

/**
 * Recalcula a chave/situação efetiva de cada REFERÊNCIA (não de cada scan
 * individualmente — a classificação só depende de `reference_norm`, é a
 * mesma para todos os beeps ativos daquela referência neste instante) e soma
 * TODOS os beeps ativos daquela referência num único grupo. Isso é o que
 * corrige a perda de unidades: antes, scans gravados antes e depois de uma
 * resolução manual ficavam em grupos separados (pela chave histórica
 * gravada em cada scan) e um sobrescrevia o outro no mapa de resultados.
 */
function computeEffectiveTotals(db: Db, session: CountSessionRow): EffectiveTotals {
  const allScans = q.listScansBySession(db, session.id, { limit: 1_000_000 });
  const activeCount = allScans.filter((s) => s.cancelled_at === null).length;
  const byReference = q.activeScanCountsByReference(db, session.id);

  let recognizedUnits = 0;
  let unknownUnits = 0;
  let missingKeyUnits = 0;
  let conflictUnits = 0;
  const recognizedByReference = new Map<
    string,
    { reference: string; chavePeca: string | null; chavePecaNorm: string | null; quantity: number }
  >();
  const absoluteBlockers: string[] = [];

  for (const row of byReference) {
    const manual = q.getActiveMapping(db, row.reference_norm);
    const catalog = session.import_batch_id
      ? q.catalogLookup(db, session.import_batch_id, row.reference_norm)
      : { foundInCatalog: false, distinctKeys: [] };
    const effective = resolveReference(manual, catalog);

    if (effective.mappingStatus === "RECOGNIZED") {
      recognizedUnits += row.active_count;
      recognizedByReference.set(row.reference_norm, {
        reference: row.reference,
        chavePeca: effective.chavePeca,
        chavePecaNorm: effective.chavePecaNorm,
        quantity: row.active_count,
      });
    } else if (effective.mappingStatus === "UNKNOWN_REFERENCE") {
      unknownUnits += row.active_count;
    } else if (effective.mappingStatus === "MISSING_KEY") {
      missingKeyUnits += row.active_count;
    } else {
      conflictUnits += row.active_count;
    }
  }

  if (activeCount === 0) absoluteBlockers.push("EMPTY_SESSION: nenhum beep ativo na sessão.");
  if (unknownUnits > 0) absoluteBlockers.push(`UNKNOWN_REFERENCE_PENDING: ${unknownUnits} unidade(s) com referência desconhecida.`);
  if (missingKeyUnits > 0) absoluteBlockers.push(`MISSING_KEY_PENDING: ${missingKeyUnits} unidade(s) sem CHAVEPECA no catálogo.`);
  if (conflictUnits > 0) absoluteBlockers.push(`CONFLICT_PENDING: ${conflictUnits} unidade(s) com referência em conflito.`);
  if (session.status !== "OPEN") absoluteBlockers.push(`SESSION_NOT_OPEN: sessão não está aberta (status ${session.status}).`);
  if (!session.import_batch_id) absoluteBlockers.push("NO_IMPORT_BATCH: sessão sem lote de importação vinculado.");

  return {
    activeScans: activeCount,
    cancelledScans: allScans.length - activeCount,
    totalScans: allScans.length,
    recognizedUnits,
    unknownUnits,
    missingKeyUnits,
    conflictUnits,
    distinctReferences: byReference.length,
    recognizedByReference,
    absoluteBlockers,
  };
}

function buildDifferences(
  totals: EffectiveTotals,
  legacyByRef: Map<string, number>,
): FinalizeSummary["differencesByReference"] {
  const refKeys = new Set<string>([...totals.recognizedByReference.keys(), ...legacyByRef.keys()]);
  return [...refKeys]
    .map((refNorm) => {
      const rec = totals.recognizedByReference.get(refNorm);
      const counted = rec?.quantity ?? 0;
      const legacy = legacyByRef.get(refNorm) ?? 0;
      return {
        referenceNorm: refNorm,
        reference: rec?.reference ?? refNorm,
        chavePeca: rec?.chavePeca ?? null,
        countedQuantity: counted,
        legacyQuantity: legacy,
        difference: counted - legacy,
      };
    })
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

/**
 * Monta o `FinalizeSummary` a partir de totais já calculados (sem reler nada
 * do banco) — usado tanto pela checagem de capacidade (`buildFinalizeSummary`,
 * que sempre reflete o estado ATUAL da sessão) quanto pela resposta da
 * finalização recém-concluída (que precisa refletir o estado de ANTES do
 * commit, quando a sessão ainda estava OPEN e os bloqueadores eram vazios —
 * ver `finalizeSession`).
 */
function summaryFromTotals(
  totals: EffectiveTotals,
  legacyTotal: number,
  legacyByRef: Map<string, number>,
  extraBlockers: string[] = [],
  extraWarnings: string[] = [],
): FinalizeSummary {
  const percentVsLegacy = legacyTotal > 0 ? totals.activeScans / legacyTotal : null;
  const belowThreshold =
    totals.activeScans > 0 && percentVsLegacy !== null && percentVsLegacy < config.countMinCompletenessRatio;

  const warnings = [...extraWarnings];
  const blockers = [...totals.absoluteBlockers, ...extraBlockers];
  if (belowThreshold) {
    warnings.push("COUNT_BELOW_BASELINE_THRESHOLD");
    if (extraBlockers.length === 0) {
      blockers.push(
        `COUNT_BELOW_BASELINE_THRESHOLD: contagem ativa (${totals.activeScans}) está abaixo de ` +
          `${Math.round(config.countMinCompletenessRatio * 100)}% do estoque legado (${legacyTotal}).`,
      );
    }
  }

  return {
    totalScans: totals.totalScans,
    activeScans: totals.activeScans,
    cancelledScans: totals.cancelledScans,
    recognizedUnits: totals.recognizedUnits,
    unknownUnits: totals.unknownUnits,
    missingKeyUnits: totals.missingKeyUnits,
    conflictUnits: totals.conflictUnits,
    distinctReferences: totals.distinctReferences,
    legacyTotalUnits: legacyTotal,
    totalDifference: totals.activeScans - legacyTotal,
    percentVsLegacy,
    differencesByReference: buildDifferences(totals, legacyByRef),
    canFinalize: blockers.length === 0,
    blockers,
    warnings,
  };
}

/** Resumo "pode finalizar agora?" — sempre reflete o estado ATUAL da sessão (uso: GET /summary, revisão antes de finalizar). */
export function buildFinalizeSummary(db: Db, sessionId: number): FinalizeSummary {
  const session = getSessionOrThrow(db, sessionId);
  const totals = computeEffectiveTotals(db, session);
  const legacyTotal = session.import_batch_id ? q.legacyTotalUnits(db, session.import_batch_id) : 0;
  const legacyByRef = session.import_batch_id ? q.legacyUnitsByReference(db, session.import_batch_id) : new Map<string, number>();

  const movementsDuringCount = countMovementsAfter(db, session.baseline_cutoff_movement_id);
  const extraBlockers: string[] = [];
  const extraWarnings: string[] = [];
  if (movementsDuringCount > 0) {
    extraWarnings.push("STOCK_MOVEMENTS_DURING_COUNT");
    extraBlockers.push(
      `STOCK_MOVEMENTS_DURING_COUNT: ${movementsDuringCount} movimentação(ões) de estoque ocorreram durante esta contagem.`,
    );
  }
  return summaryFromTotals(totals, legacyTotal, legacyByRef, extraBlockers, extraWarnings);
}

// ===========================================================================
// Estado consolidado (recuperação após F5 / reabertura)
// ===========================================================================

export interface SessionState {
  session: CountSessionRow;
  summary: FinalizeSummary;
  recentScans: CountScanRow[];
  totalsByReference: { referenceNorm: string; reference: string; total: number }[];
  pending: PendingReferenceGroup[];
}

/**
 * Estado completo de uma sessão, recalculado do banco — a única fonte de
 * verdade para a tela `/bipagem`. O frontend nunca reconstrói totais a
 * partir de estado React local; recarrega este estado depois de toda
 * mutação (novo scan, cancelamento, resolução).
 */
export function getSessionState(db: Db, sessionId: number, recentLimit = 30): SessionState {
  const session = getSessionOrThrow(db, sessionId);
  const summary = buildFinalizeSummary(db, sessionId);
  const recentScans = q.listScansBySession(db, sessionId, { limit: recentLimit });
  const totalsByReference = q
    .activeScanCountsByReference(db, sessionId)
    .map((r) => ({ referenceNorm: r.reference_norm, reference: r.reference, total: r.active_count }))
    .sort((a, b) => b.total - a.total);
  const pending = getPending(db, sessionId);
  return { session, summary, recentScans, totalsByReference, pending };
}

// ===========================================================================
// Finalização transacional
// ===========================================================================

export interface FinalizeInput {
  finalizedBy: string;
  forceIncomplete?: boolean;
  forceReason?: string;
}

export interface FinalizeResult {
  snapshot: StockSnapshotRow;
  summary: FinalizeSummary;
  alreadyFinalized: boolean;
}

export function finalizeSession(db: Db, sessionId: number, input: FinalizeInput): FinalizeResult {
  const finalizedBy = requireNonEmpty(input.finalizedBy, "responsável");
  const session = getSessionOrThrow(db, sessionId);

  // Idempotência: sessão já finalizada -> devolve o snapshot existente, sem recriar
  // e sem fingir recalcular "pode finalizar" sobre uma sessão que já não está OPEN.
  if (session.status === "FINALIZED") {
    const existing = q.getSnapshotBySession(db, sessionId);
    if (existing) {
      const totals = computeTotalsFromSnapshot(db, existing);
      const legacyTotal = existing.import_batch_id ? q.legacyTotalUnits(db, existing.import_batch_id) : 0;
      const legacyByRef = existing.import_batch_id ? q.legacyUnitsByReference(db, existing.import_batch_id) : new Map<string, number>();
      const summary = summaryFromTotals(totals, legacyTotal, legacyByRef, ["ALREADY_FINALIZED: esta sessão já foi finalizada."]);
      return { snapshot: existing, summary, alreadyFinalized: true };
    }
  }

  let snapshot!: StockSnapshotRow;
  let preCommitSummary!: FinalizeSummary;

  db.exec("BEGIN");
  try {
    // Tudo recalculado DENTRO da transação — não confia em nenhuma validação feita antes do BEGIN.
    const fresh = q.getSessionById(db, sessionId);
    if (!fresh) throw new CountingError(404, `Sessão de contagem ${sessionId} não encontrada.`);
    if (fresh.status !== "OPEN") {
      throw new CountingError(409, `Sessão ${sessionId} não está aberta (status atual: ${fresh.status}).`);
    }

    const totals = computeEffectiveTotals(db, fresh);
    if (totals.absoluteBlockers.length > 0) {
      throw new CountingError(422, `Finalização bloqueada: ${totals.absoluteBlockers.join(" | ")}`, {
        blockers: totals.absoluteBlockers,
      });
    }

    const legacyTotal = fresh.import_batch_id ? q.legacyTotalUnits(db, fresh.import_batch_id) : 0;
    const legacyByRef = fresh.import_batch_id ? q.legacyUnitsByReference(db, fresh.import_batch_id) : new Map<string, number>();
    const percentVsLegacy = legacyTotal > 0 ? totals.activeScans / legacyTotal : null;
    const belowThreshold = percentVsLegacy !== null && percentVsLegacy < config.countMinCompletenessRatio;

    // Movimentações de estoque (ex.: recebimentos) ocorridas depois do início
    // desta sessão (baseline congelada na criação) bloqueiam a finalização
    // normal — a contagem física pode já estar desatualizada em relação a
    // peças que entraram no meio do processo.
    const movementsDuringCount = countMovementsAfter(db, fresh.baseline_cutoff_movement_id);
    const forceReasonTrimmed = (input.forceReason ?? "").trim();
    const hasValidForce = !!input.forceIncomplete && forceReasonTrimmed.length >= 10;

    if (movementsDuringCount > 0 && !hasValidForce) {
      throw new CountingError(
        422,
        `${movementsDuringCount} movimentação(ões) de estoque ocorreram durante esta contagem (após o início da ` +
          `sessão). Envie forceIncomplete=true, responsável e uma justificativa com pelo menos 10 caracteres para ` +
          `finalizar mesmo assim — o novo snapshot absorverá essas movimentações.`,
        { code: "STOCK_MOVEMENTS_DURING_COUNT", movementsDuringCount },
      );
    }

    if (belowThreshold && !hasValidForce) {
      throw new CountingError(
        422,
        `Contagem ativa (${totals.activeScans}) está abaixo de ${Math.round(config.countMinCompletenessRatio * 100)}% ` +
          `do estoque legado (${legacyTotal}). Envie forceIncomplete=true, responsável e uma justificativa com pelo ` +
          `menos 10 caracteres para finalizar mesmo assim.`,
        { code: "COUNT_BELOW_BASELINE_THRESHOLD", percentVsLegacy, legacyTotal, activeScans: totals.activeScans },
      );
    }

    const consolidated = [...totals.recognizedByReference.entries()].map(([referenceNorm, v]) => ({
      reference: v.reference,
      referenceNorm,
      chavePeca: v.chavePeca,
      chavePecaNorm: v.chavePecaNorm,
      countedQuantity: v.quantity,
    }));

    // O novo snapshot absorve todas as movimentações ocorridas até agora
    // (inclusive as detectadas durante a contagem) — passam a fazer parte da
    // base física a partir desta finalização.
    const baselineMovementIdMax = maxMovementId(db);

    snapshot = repo.createSnapshot(db, {
      countSessionId: sessionId,
      importBatchId: fresh.import_batch_id,
      totalUnits: totals.activeScans,
      createdBy: finalizedBy,
      notes: null,
      baselineMovementIdMax,
    });
    repo.insertSnapshotItems(db, snapshot.id, consolidated);

    // Integridade: soma dos itens = total do snapshot = beeps ativos reconhecidos.
    const sumItems = consolidated.reduce((sum, it) => sum + it.countedQuantity, 0);
    if (sumItems !== snapshot.total_units || sumItems !== totals.recognizedUnits) {
      throw new Error(
        `Integridade violada na consolidação: soma dos itens (${sumItems}) != total do snapshot ` +
          `(${snapshot.total_units}) ou != unidades reconhecidas (${totals.recognizedUnits}).`,
      );
    }

    repo.finalizeSessionStatus(db, sessionId, finalizedBy);

    // Resumo da resposta: estado de ANTES do commit (sessão OPEN, sem bloqueadores —
    // foi exatamente isso que permitiu finalizar). Nunca recomputado pós-commit.
    const extraWarnings: string[] = [];
    if (belowThreshold) extraWarnings.push("COUNT_BELOW_BASELINE_THRESHOLD");
    if (movementsDuringCount > 0) extraWarnings.push("STOCK_MOVEMENTS_DURING_COUNT");
    preCommitSummary = summaryFromTotals(totals, legacyTotal, legacyByRef, [], extraWarnings);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err instanceof CountingError ? err : new CountingError(500, `Falha na finalização (rollback aplicado): ${(err as Error).message}`);
  }

  return { snapshot, summary: preCommitSummary, alreadyFinalized: false };
}

/** Reconstrói totais "equivalentes" a partir de um snapshot já persistido (caminho idempotente). */
function computeTotalsFromSnapshot(db: Db, snapshot: StockSnapshotRow): EffectiveTotals {
  const items = q.listSnapshotItems(db, snapshot.id);
  const recognizedByReference = new Map(
    items.map((it) => [
      it.reference_norm,
      { reference: it.reference, chavePeca: it.chave_peca, chavePecaNorm: it.chave_peca_norm, quantity: it.counted_quantity },
    ]),
  );
  const allScans = q.listScansBySession(db, snapshot.count_session_id, { limit: 1_000_000 });
  const recognizedUnits = items.reduce((sum, it) => sum + it.counted_quantity, 0);
  return {
    activeScans: snapshot.total_units,
    cancelledScans: allScans.filter((s) => s.cancelled_at !== null).length,
    totalScans: allScans.length,
    recognizedUnits,
    unknownUnits: 0,
    missingKeyUnits: 0,
    conflictUnits: 0,
    distinctReferences: items.length,
    recognizedByReference,
    absoluteBlockers: [],
  };
}
