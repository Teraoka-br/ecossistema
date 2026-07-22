/**
 * Override manual de custo por chave de peça (auditável).
 *
 * Regras:
 *   - Justificativa obrigatória; usuário e data sempre registrados.
 *   - Override ativo tem precedência na resolução de custo
 *     (cost-resolution-service consulta getActiveOverride).
 *   - Novas cotações/importações NÃO apagam override — só a restauração
 *     explícita (também auditada) o desativa.
 *   - Cada mudança gera também um evento imutável em part_price_events.
 */

import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";
import { recordPriceEvent } from "./part-price-service.js";
import { resolveEffectivePartCost } from "./cost-resolution-service.js";

export interface PartCostOverride {
  id: number;
  chavePecaNorm: string;
  unitCost: number;
  previousResolvedCost: number | null;
  justification: string;
  validUntil: string | null;
  createdBy: string | null;
  createdAt: string;
  active: boolean;
}

export class PartCostOverrideError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PartCostOverrideError";
  }
}

function toOverride(r: Record<string, unknown>): PartCostOverride {
  return {
    id: r.id as number,
    chavePecaNorm: r.chave_peca_norm as string,
    unitCost: r.unit_cost as number,
    previousResolvedCost: r.previous_resolved_cost as number | null,
    justification: r.justification as string,
    validUntil: r.valid_until as string | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as string,
    active: (r.active as number) === 1,
  };
}

/** Override ativo e vigente (respeita valid_until) para a chave, ou null. */
export function getActiveOverride(db: Db, chavePecaNorm: string): PartCostOverride | null {
  const r = db
    .prepare(
      `SELECT * FROM part_cost_overrides
       WHERE chave_peca_norm = ? AND active = 1
         AND (valid_until IS NULL OR valid_until >= datetime('now'))`,
    )
    .get(chavePecaNorm) as Record<string, unknown> | undefined;
  return r ? toOverride(r) : null;
}

export function listActiveOverrides(db: Db): PartCostOverride[] {
  const rows = db
    .prepare("SELECT * FROM part_cost_overrides WHERE active = 1 ORDER BY chave_peca_norm")
    .all() as Record<string, unknown>[];
  return rows.map(toOverride);
}

/** Cria (ou substitui) o override ativo da chave. */
export function setPartCostOverride(
  db: Db,
  input: {
    chavePeca: string;
    unitCost: number;
    justification: string;
    validUntil?: string | null;
    userId: string | null;
  },
): PartCostOverride {
  if (!input.justification || input.justification.trim().length < 5) {
    throw new PartCostOverrideError("JUSTIFICATION_REQUIRED", "Justificativa deve ter pelo menos 5 caracteres.");
  }
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) {
    throw new PartCostOverrideError("INVALID_COST", "Custo deve ser um número não negativo.");
  }
  const norm = normalizeKey(input.chavePeca);
  if (!norm) throw new PartCostOverrideError("INVALID_KEY", "Chave de peça vazia.");

  // Custo resolvido antes do override (auditoria do valor anterior)
  const previous = resolveEffectivePartCost(db, { chavePecaNorm: norm, context: "CURRENT_REPAIR" });

  db.exec("BEGIN");
  try {
    // Substituição: desativa o override anterior (nunca apaga)
    db.prepare(
      `UPDATE part_cost_overrides
       SET active = 0, restored_by = ?, restored_at = datetime('now'),
           restore_reason = 'Substituído por novo override'
       WHERE chave_peca_norm = ? AND active = 1`,
    ).run(input.userId, norm);

    const r = db.prepare(
      `INSERT INTO part_cost_overrides
         (chave_peca_norm, unit_cost, previous_resolved_cost, justification, valid_until, created_by)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      norm, input.unitCost, previous.unitCost,
      input.justification.trim(), input.validUntil ?? null, input.userId,
    );

    recordPriceEvent(db, {
      chavePeca: input.chavePeca,
      sourceType: "MANUAL_OVERRIDE",
      unitPrice: input.unitCost,
      confidence: "MEDIUM",
      previousPrice: previous.unitCost,
      notes: input.justification.trim(),
      createdBy: input.userId,
      occurredAt: new Date().toISOString(),
    });

    db.exec("COMMIT");
    const row = db.prepare("SELECT * FROM part_cost_overrides WHERE id = ?")
      .get(r.lastInsertRowid as number) as Record<string, unknown>;
    return toOverride(row);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Restaura o valor calculado/importado desativando o override (auditado). */
export function restorePartCost(
  db: Db,
  input: { chavePeca: string; reason: string; userId: string | null },
): void {
  if (!input.reason || input.reason.trim().length < 5) {
    throw new PartCostOverrideError("JUSTIFICATION_REQUIRED", "Justificativa deve ter pelo menos 5 caracteres.");
  }
  const norm = normalizeKey(input.chavePeca);
  const current = getActiveOverride(db, norm);
  if (!current) {
    throw new PartCostOverrideError("NO_ACTIVE_OVERRIDE", "Nenhum override ativo para esta chave.");
  }

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE part_cost_overrides
       SET active = 0, restored_by = ?, restored_at = datetime('now'), restore_reason = ?
       WHERE id = ?`,
    ).run(input.userId, input.reason.trim(), current.id);

    recordPriceEvent(db, {
      chavePeca: input.chavePeca,
      sourceType: "COST_CORRECTION",
      unitPrice: current.unitCost,
      confidence: "LOW",
      previousPrice: current.unitCost,
      notes: `Restauração de valor calculado/importado: ${input.reason.trim()}`,
      createdBy: input.userId,
      occurredAt: new Date().toISOString(),
    });

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
