import type { Db } from "../db/database.js";

export interface MatchRuleSet {
  id: number;
  version: number;
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

export function getActiveRuleSet(db: Db): MatchRuleSet {
  const row = db.prepare("SELECT * FROM match_rule_sets WHERE active = 1").get() as Record<string, unknown> | undefined;
  if (!row) throw new MatchRuleError("NO_ACTIVE_RULE", "Nenhuma regra de match ativa encontrada.");
  return toRuleSet(row);
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
      (version, margin_amount_per_point, age_days_per_point, age_max_points,
       allow_negative_margin_score, margin_weight, age_weight, active, reason, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,0,?,?)
  `).run(
    maxVersion + 1,
    input.marginAmountPerPoint ?? 150.0,
    input.ageDaysPerPoint ?? 30,
    input.ageMaxPoints ?? 15,
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
      margin_amount_per_point = COALESCE(?, margin_amount_per_point),
      age_days_per_point = COALESCE(?, age_days_per_point),
      age_max_points = COALESCE(?, age_max_points),
      allow_negative_margin_score = COALESCE(?, allow_negative_margin_score),
      margin_weight = COALESCE(?, margin_weight),
      age_weight = COALESCE(?, age_weight),
      reason = COALESCE(?, reason)
    WHERE id = ?
  `).run(
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

export function computeScore(rule: MatchRuleSet, ageDays: number | null, margin: number | null): {
  marginPoints: number; agePoints: number; score: number;
} {
  const agePoints = ageDays != null
    ? Math.min(Math.floor(ageDays / rule.ageDaysPerPoint), rule.ageMaxPoints)
    : 0;

  let marginPoints = 0;
  if (margin != null) {
    const raw = Math.floor(margin / rule.marginAmountPerPoint);
    marginPoints = !rule.allowNegativeMarginScore ? Math.max(0, raw) : raw;
  }

  const score = Math.round(marginPoints * rule.marginWeight + agePoints * rule.ageWeight);
  return { marginPoints, agePoints, score };
}
