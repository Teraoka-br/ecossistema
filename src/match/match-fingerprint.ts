/**
 * Impressão digital (fingerprint) de uma execução de match.
 *
 * Duas execuções com o mesmo estado produzem o mesmo hash → reutilização
 * de resultado sem recalcular. Uma execução fica "stale" quando o hash
 * atual difere do hash armazenado.
 */

import crypto from "node:crypto";
import type { Db } from "../db/database.js";
import { ALGORITHM_VERSION } from "./match-engine.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";
import { getSystemState } from "../system/system-service.js";
import { maxActiveReservationId } from "../separation/separation-repository.js";

export interface FingerprintComponents {
  initialImportBatchId: number | null;
  maxOperationalEventId: number;
  stockBaseType: string;
  stockSnapshotId: number | null;
  stockCutoffMovementId: number;
  stockMaxMovementId: number;
  /** SHA-256 das quantidades efetivas do estoque — detecta reversões de movimentos antigos. */
  stockStateHash: string;
  /** Máximo id de reserva ativa (RESERVED/CONFIRMED) — detecta criação/cancelamento de separações. */
  maxActiveReservationId: number;
  ruleId: number;
  ruleAgeDaysPerPoint: number;
  ruleAgeMaxPoints: number;
  ruleMarginPerPoint: number;
  ruleMarginAllowsNegative: boolean;
  algorithmVersion: string;
}

/** Computa o hash SHA-256 das componentes. */
export function computeHash(c: FingerprintComponents): string {
  const data = JSON.stringify({
    v: c.algorithmVersion,
    batchId: c.initialImportBatchId,
    maxEventId: c.maxOperationalEventId,
    stockBaseType: c.stockBaseType,
    stockSnapshotId: c.stockSnapshotId,
    stockCutoffMovementId: c.stockCutoffMovementId,
    stockStateHash: c.stockStateHash,
    maxActiveReservationId: c.maxActiveReservationId,
    ruleId: c.ruleId,
    ruleAgeDaysPerPoint: c.ruleAgeDaysPerPoint,
    ruleAgeMaxPoints: c.ruleAgeMaxPoints,
    ruleMarginPerPoint: c.ruleMarginPerPoint,
    ruleMarginAllowsNegative: c.ruleMarginAllowsNegative,
  });
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Computa SHA-256 do estado efetivo do estoque operacional (físico, reservado, disponível).
 * Detecta reversões de movimentos antigos e variações de reservas.
 */
export function computeStockStateHash(groups: import("../operational/stock-service.js").OperationalStockGroup[]): string {
  const sorted = [...groups]
    .filter((g) => g.chavePecaNorm !== null)
    .sort((a, b) => {
      const r = (a.referenciaNorm ?? "").localeCompare(b.referenciaNorm ?? "");
      if (r !== 0) return r;
      return (a.chavePecaNorm ?? "").localeCompare(b.chavePecaNorm ?? "");
    });
  const data = sorted
    .map(
      (g) =>
        `${g.referenciaNorm ?? ""}|${g.chavePecaNorm ?? ""}|${g.currentQuantity}|${g.reservedQuantity}|${g.availableQuantity}`,
    )
    .join("\n");
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface ActiveDecisionRule {
  id: number;
  name: string;
  age_days_per_point: number;
  age_max_points: number;
  margin_per_point: number;
  margin_allows_negative: number;
}

/** Carrega a única regra ativa ou lança erro de configuração. Valida parâmetros numéricos. */
export function loadActiveRule(db: Db): ActiveDecisionRule {
  const rows = db
    .prepare("SELECT * FROM decision_rules WHERE active = 1 ORDER BY id")
    .all() as unknown as ActiveDecisionRule[];
  if (rows.length === 0) {
    throw new MatchConfigError("Nenhuma regra de decisão ativa encontrada em decision_rules.");
  }
  if (rows.length > 1) {
    throw new MatchConfigError(
      `Existem ${rows.length} regras ativas em decision_rules — deve haver exatamente uma.`,
    );
  }
  const rule = rows[0];
  if (rule.age_days_per_point <= 0) {
    throw new MatchConfigError(`Regra inválida: age_days_per_point deve ser > 0 (encontrado ${rule.age_days_per_point}).`);
  }
  if (rule.age_max_points < 0) {
    throw new MatchConfigError(`Regra inválida: age_max_points deve ser >= 0 (encontrado ${rule.age_max_points}).`);
  }
  if (rule.margin_per_point <= 0) {
    throw new MatchConfigError(`Regra inválida: margin_per_point deve ser > 0 (encontrado ${rule.margin_per_point}).`);
  }
  if (rule.margin_allows_negative !== 0 && rule.margin_allows_negative !== 1) {
    throw new MatchConfigError(`Regra inválida: margin_allows_negative deve ser 0 ou 1 (encontrado ${rule.margin_allows_negative}).`);
  }
  return rule;
}

/** Coleta todas as componentes necessárias para o fingerprint do estado atual. */
export function collectFingerprintComponents(db: Db, rule: ActiveDecisionRule): FingerprintComponents {
  const state = getSystemState(db);
  const stock = getCurrentOperationalStock(db);

  const maxEvent = db
    .prepare(
      "SELECT COALESCE(MAX(id), 0) AS m FROM operational_events WHERE entity_type = 'ORDER_PART'",
    )
    .get() as { m: number };

  const maxMovement = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM stock_movements")
    .get() as { m: number };

  let maxReservId = 0;
  try {
    maxReservId = maxActiveReservationId(db);
  } catch {
    // tabela ainda não existe (antes da migration 009)
  }

  return {
    initialImportBatchId: state.initial_import_batch_id,
    maxOperationalEventId: maxEvent.m,
    stockBaseType: stock.base.type,
    stockSnapshotId: stock.base.snapshotId,
    stockCutoffMovementId: stock.base.cutoffMovementId,
    stockMaxMovementId: maxMovement.m,
    stockStateHash: computeStockStateHash(stock.groups),
    maxActiveReservationId: maxReservId,
    ruleId: rule.id,
    ruleAgeDaysPerPoint: rule.age_days_per_point,
    ruleAgeMaxPoints: rule.age_max_points,
    ruleMarginPerPoint: rule.margin_per_point,
    ruleMarginAllowsNegative: rule.margin_allows_negative === 1,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/** Computa o fingerprint atual do banco (sem executar o motor). */
export function computeCurrentFingerprint(db: Db): {
  hash: string;
  components: FingerprintComponents;
  rule: ActiveDecisionRule;
} {
  const rule = loadActiveRule(db);
  const components = collectFingerprintComponents(db, rule);
  return { hash: computeHash(components), components, rule };
}

export class MatchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchConfigError";
  }
}

export class MatchError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "MatchError";
  }
}
