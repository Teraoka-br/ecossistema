/**
 * CRUD e ativação transacional das regras de match (match_rule_sets).
 *
 * O CÁLCULO do score NÃO vive aqui — a única implementação é
 * calculateMatch/computeRuleScore em calculate-match.ts (sem arredondamento).
 */

import type { Db } from "../db/database.js";
import type { ActiveRule } from "./calculate-match.js";

export interface MatchRuleSet {
  id: number;
  version: number;
  name: string | null;
  marginAmountPerPoint: number;
  ageDaysPerPoint: number;
  ageMaxPoints: number;
  allowNegativeMarginScore: boolean;
  marginWeight: number;
  ageWeight: number;
  active: boolean;
  reason: string | null;
  createdByUserId: number | null;
  createdAt: string;
  activatedByUserId: number | null;
  activatedAt: string | null;
}

export interface MatchRuleSetInput {
  name?: string | null;
  marginAmountPerPoint?: number;
  ageDaysPerPoint?: number;
  ageMaxPoints?: number;
  allowNegativeMarginScore?: boolean;
  marginWeight?: number;
  ageWeight?: number;
  reason?: string | null;
  createdByUserId?: number | null;
}

export class MatchRuleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MatchRuleError";
  }
}

function toRuleSet(r: Record<string, unknown>): MatchRuleSet {
  return {
    id: r.id as number,
    version: r.version as number,
    name: (r.name as string | null) ?? null,
    marginAmountPerPoint: r.margin_amount_per_point as number,
    ageDaysPerPoint: r.age_days_per_point as number,
    ageMaxPoints: r.age_max_points as number,
    allowNegativeMarginScore: (r.allow_negative_margin_score as number) === 1,
    marginWeight: r.margin_weight as number,
    ageWeight: r.age_weight as number,
    active: (r.active as number) === 1,
    reason: r.reason as string | null,
    createdByUserId: r.created_by_user_id as number | null,
    createdAt: r.created_at as string,
    activatedByUserId: r.activated_by_user_id as number | null,
    activatedAt: r.activated_at as string | null,
  };
}

/** Converte a regra persistida para o formato consumido por calculateMatch. */
export function toActiveRule(rs: MatchRuleSet): ActiveRule {
  return {
    id: rs.id,
    version: rs.version,
    name: rs.name,
    marginAmountPerPoint: rs.marginAmountPerPoint,
    ageDaysPerPoint: rs.ageDaysPerPoint,
    ageMaxPoints: rs.ageMaxPoints,
    allowNegativeMarginScore: rs.allowNegativeMarginScore,
    marginWeight: rs.marginWeight,
    ageWeight: rs.ageWeight,
  };
}

export function getActiveRuleSet(db: Db): MatchRuleSet {
  const rows = db.prepare("SELECT * FROM match_rule_sets WHERE active = 1 ORDER BY id").all() as Record<string, unknown>[];
  if (rows.length === 0) throw new MatchRuleError("NO_ACTIVE_RULE", "Nenhuma regra de match ativa encontrada.");
  if (rows.length > 1) {
    throw new MatchRuleError(
      "MULTIPLE_ACTIVE_RULES",
      `Existem ${rows.length} regras ativas simultaneamente — corrija a configuração.`,
    );
  }
  return toRuleSet(rows[0]);
}

export function getRuleSetById(db: Db, id: number): MatchRuleSet | null {
  const row = db.prepare("SELECT * FROM match_rule_sets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toRuleSet(row) : null;
}

export function listRuleSets(db: Db): MatchRuleSet[] {
  const rows = db.prepare("SELECT * FROM match_rule_sets ORDER BY version DESC").all() as Record<string, unknown>[];
  return rows.map(toRuleSet);
}

export function createDraftRuleSet(db: Db, input: MatchRuleSetInput): MatchRuleSet {
  const maxVersion = (db.prepare("SELECT MAX(version) as v FROM match_rule_sets").get() as { v: number | null }).v ?? 0;
  const res = db.prepare(`
    INSERT INTO match_rule_sets
      (version, name, margin_amount_per_point, age_days_per_point, age_max_points,
       allow_negative_margin_score, margin_weight, age_weight, active, reason, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,0,?,?)
  `).run(
    maxVersion + 1,
    input.name?.trim() || `Regra v${maxVersion + 1}`,
    input.marginAmountPerPoint ?? 150.0,
    input.ageDaysPerPoint ?? 30,
    input.ageMaxPoints ?? 12,
    input.allowNegativeMarginScore !== false ? 1 : 0,
    input.marginWeight ?? 1.0,
    input.ageWeight ?? 1.0,
    input.reason ?? null,
    input.createdByUserId ?? null,
  );
  return getRuleSetById(db, res.lastInsertRowid as number)!;
}

export function updateDraftRuleSet(db: Db, id: number, input: MatchRuleSetInput, _userId: number | null): MatchRuleSet {
  const rs = getRuleSetById(db, id);
  if (!rs) throw new MatchRuleError("NOT_FOUND", "Regra não encontrada.");
  if (rs.active) throw new MatchRuleError("ALREADY_ACTIVE", "Regra ativa não pode ser editada. Crie uma nova versão.");

  db.prepare(`
    UPDATE match_rule_sets SET
      name = COALESCE(?, name),
      margin_amount_per_point = COALESCE(?, margin_amount_per_point),
      age_days_per_point = COALESCE(?, age_days_per_point),
      age_max_points = COALESCE(?, age_max_points),
      allow_negative_margin_score = COALESCE(?, allow_negative_margin_score),
      margin_weight = COALESCE(?, margin_weight),
      age_weight = COALESCE(?, age_weight),
      reason = COALESCE(?, reason)
    WHERE id = ?
  `).run(
    input.name?.trim() ?? null,
    input.marginAmountPerPoint ?? null,
    input.ageDaysPerPoint ?? null,
    input.ageMaxPoints ?? null,
    input.allowNegativeMarginScore !== undefined ? (input.allowNegativeMarginScore ? 1 : 0) : null,
    input.marginWeight ?? null,
    input.ageWeight ?? null,
    input.reason ?? null,
    id,
  );
  return getRuleSetById(db, id)!;
}

/**
 * Ativa uma regra desativando a anterior NA MESMA transação.
 * O índice único parcial (active=1) garante no banco que nunca existam duas.
 */
export function activateRuleSet(
  db: Db,
  id: number,
  params: { reason: string; userId: number | null },
): MatchRuleSet {
  const rs = getRuleSetById(db, id);
  if (!rs) throw new MatchRuleError("NOT_FOUND", "Regra não encontrada.");
  if (rs.active) return rs;
  if (!params.reason || params.reason.trim().length < 5) {
    throw new MatchRuleError("REASON_TOO_SHORT", "Justificativa deve ter pelo menos 5 caracteres.");
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE match_rule_sets SET active = 0 WHERE active = 1").run();
    db.prepare(`
      UPDATE match_rule_sets SET active = 1, reason = ?, activated_by_user_id = ?, activated_at = datetime('now')
      WHERE id = ?
    `).run(params.reason.trim(), params.userId ?? null, id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return getRuleSetById(db, id)!;
}
