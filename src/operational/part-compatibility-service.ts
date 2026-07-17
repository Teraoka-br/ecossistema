/**
 * Grupos de compatibilidade simétrica de chaves de peça (migration 039).
 *
 * Um grupo define um conjunto de chaves intercompatíveis: pedido de qualquer
 * membro pode ser atendido pelo saldo de qualquer outro membro. Regras:
 *   - Uma chave pertence a no máximo um grupo ativo de cada vez.
 *   - Remover um membro não apaga o histórico (removed_at).
 *   - Requer permissão MANAGE_PART_COMPATIBILITY (ou ADMIN).
 *   - Criação/remoção dispara recálculo do motor.
 */

import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";
import { requestMatchRecompute } from "../match/engine-orchestrator.js";

export class PartCompatibilityError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PartCompatibilityError";
  }
}

export interface CompatibilityGroupRow {
  id: number;
  name: string | null;
  created_by_user_id: number | null;
  created_at: string;
  members: CompatibilityMemberRow[];
}

export interface CompatibilityMemberRow {
  id: number;
  group_id: number;
  chave_peca: string;
  chave_peca_norm: string;
  added_by_user_id: number | null;
  added_at: string;
  removed_at: string | null;
  removed_by_user_id: number | null;
}

function loadGroupMembers(db: Db, groupId: number, includeRemoved = false): CompatibilityMemberRow[] {
  const sql = includeRemoved
    ? "SELECT * FROM part_compatibility_group_members WHERE group_id = ? ORDER BY added_at"
    : "SELECT * FROM part_compatibility_group_members WHERE group_id = ? AND removed_at IS NULL ORDER BY added_at";
  return db.prepare(sql).all(groupId) as unknown as CompatibilityMemberRow[];
}

export function listCompatibilityGroups(db: Db): CompatibilityGroupRow[] {
  const groups = db.prepare(
    "SELECT * FROM part_compatibility_groups ORDER BY id",
  ).all() as { id: number; name: string | null; created_by_user_id: number | null; created_at: string }[];
  return groups.map((g) => ({ ...g, members: loadGroupMembers(db, g.id) }));
}

export function getCompatibilityGroup(db: Db, id: number): CompatibilityGroupRow | null {
  const g = db.prepare("SELECT * FROM part_compatibility_groups WHERE id = ?").get(id) as
    | { id: number; name: string | null; created_by_user_id: number | null; created_at: string }
    | undefined;
  if (!g) return null;
  return { ...g, members: loadGroupMembers(db, g.id, true) };
}

/** Retorna o grupo ativo (se houver) ao qual a chave pertence. */
export function getGroupForKey(db: Db, chaveNorm: string): CompatibilityGroupRow | null {
  const member = db.prepare(
    "SELECT group_id FROM part_compatibility_group_members WHERE chave_peca_norm = ? AND removed_at IS NULL",
  ).get(chaveNorm) as { group_id: number } | undefined;
  if (!member) return null;
  return getCompatibilityGroup(db, member.group_id);
}

export function createCompatibilityGroup(
  db: Db,
  params: { name?: string | null; userId?: number | null },
): CompatibilityGroupRow {
  const res = db.prepare(
    "INSERT INTO part_compatibility_groups (name, created_by_user_id) VALUES (?,?)",
  ).run(params.name?.trim() || null, params.userId ?? null);
  return getCompatibilityGroup(db, res.lastInsertRowid as number)!;
}

/**
 * Adiciona uma chave a um grupo. Rejeita se a chave já pertence a outro grupo ativo.
 * Um grupo deve ter ao menos 2 membros para ser efetivo no motor.
 */
export function addGroupMember(
  db: Db,
  groupId: number,
  params: { chavePeca: string; userId?: number | null },
): CompatibilityMemberRow {
  if (!getCompatibilityGroup(db, groupId)) {
    throw new PartCompatibilityError("NOT_FOUND", 404, "Grupo não encontrado.");
  }

  const norm = normalizeKey(params.chavePeca.trim());
  if (!norm) {
    throw new PartCompatibilityError("EMPTY_KEY", 400, "Chave de peça não pode ser vazia.");
  }

  // Verifica conflito: chave já em outro grupo ativo.
  const existing = db.prepare(
    "SELECT group_id FROM part_compatibility_group_members WHERE chave_peca_norm = ? AND removed_at IS NULL",
  ).get(norm) as { group_id: number } | undefined;

  if (existing) {
    if (existing.group_id === groupId) {
      throw new PartCompatibilityError("ALREADY_MEMBER", 409, "A chave já é membro ativo deste grupo.");
    }
    throw new PartCompatibilityError(
      "CONFLICT",
      409,
      `A chave já pertence ao grupo #${existing.group_id}. Remova-a de lá antes de adicioná-la a outro.`,
    );
  }

  // Verifica se há registro removido do mesmo grupo (reativa em vez de duplicar).
  const removed = db.prepare(
    "SELECT id FROM part_compatibility_group_members WHERE group_id = ? AND chave_peca_norm = ? AND removed_at IS NOT NULL ORDER BY added_at DESC LIMIT 1",
  ).get(groupId, norm) as { id: number } | undefined;

  if (removed) {
    db.prepare(
      "UPDATE part_compatibility_group_members SET removed_at = NULL, removed_by_user_id = NULL, added_by_user_id = ?, added_at = datetime('now') WHERE id = ?",
    ).run(params.userId ?? null, removed.id);
    requestMatchRecompute(db, `COMPAT_MEMBER_READDED group=${groupId} key=${norm}`, "compat_group", groupId);
    return db.prepare("SELECT * FROM part_compatibility_group_members WHERE id = ?").get(removed.id) as unknown as CompatibilityMemberRow;
  }

  const res = db.prepare(
    "INSERT INTO part_compatibility_group_members (group_id, chave_peca, chave_peca_norm, added_by_user_id) VALUES (?,?,?,?)",
  ).run(groupId, params.chavePeca.trim(), norm, params.userId ?? null);
  requestMatchRecompute(db, `COMPAT_MEMBER_ADDED group=${groupId} key=${norm}`, "compat_group", groupId);
  return db.prepare("SELECT * FROM part_compatibility_group_members WHERE id = ?").get(res.lastInsertRowid) as unknown as CompatibilityMemberRow;
}

/** Remove (soft-delete) um membro do grupo. */
export function removeGroupMember(
  db: Db,
  memberId: number,
  params: { userId?: number | null },
): { wasActive: boolean } {
  const member = db.prepare(
    "SELECT id, group_id, chave_peca_norm, removed_at FROM part_compatibility_group_members WHERE id = ?",
  ).get(memberId) as { id: number; group_id: number; chave_peca_norm: string; removed_at: string | null } | undefined;

  if (!member) throw new PartCompatibilityError("NOT_FOUND", 404, "Membro não encontrado.");

  const wasActive = member.removed_at === null;
  if (wasActive) {
    db.prepare(
      "UPDATE part_compatibility_group_members SET removed_at = datetime('now'), removed_by_user_id = ? WHERE id = ?",
    ).run(params.userId ?? null, memberId);
    requestMatchRecompute(
      db,
      `COMPAT_MEMBER_REMOVED group=${member.group_id} key=${member.chave_peca_norm}`,
      "compat_group",
      member.group_id,
    );
  }
  return { wasActive };
}
