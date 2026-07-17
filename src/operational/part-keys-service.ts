import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";
import { requestMatchRecompute } from "../match/engine-orchestrator.js";

export interface PartKeyRow {
  id: number;
  chave_peca: string;
  chave_peca_norm: string;
  descricao: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartKeyEditRow {
  id: number;
  chave_peca_norm: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  edited_by: string | null;
  edited_at: string;
  notes: string | null;
}

export function listPartKeys(db: Db, search?: string): PartKeyRow[] {
  const like = search?.trim();
  return db.prepare(
    `SELECT * FROM custom_part_keys
     ${like ? "WHERE chave_peca LIKE ? OR descricao LIKE ?" : ""}
     ORDER BY chave_peca`,
  ).all(...(like ? [`%${like}%`, `%${like}%`] : [])) as unknown as PartKeyRow[];
}

export function getPartKey(db: Db, id: number): PartKeyRow | null {
  return (db.prepare("SELECT * FROM custom_part_keys WHERE id = ?").get(id) as PartKeyRow | undefined) ?? null;
}

export function getPartKeyByNorm(db: Db, norm: string): PartKeyRow | null {
  return (db.prepare("SELECT * FROM custom_part_keys WHERE chave_peca_norm = ?").get(norm) as PartKeyRow | undefined) ?? null;
}

export function createPartKey(db: Db, params: { chavePeca: string; descricao?: string; createdBy?: string }): PartKeyRow {
  const chave = params.chavePeca.trim().toUpperCase();
  const norm = normalizeKey(chave);
  if (!chave) throw new Error("CHAVEPECA não pode ser vazia.");
  const res = db.prepare(
    `INSERT INTO custom_part_keys (chave_peca, chave_peca_norm, descricao, created_by)
     VALUES (?, ?, ?, ?)`,
  ).run(chave, norm, params.descricao?.trim() || null, params.createdBy?.trim() || null);
  return getPartKey(db, res.lastInsertRowid as number)!;
}

export function updatePartKey(
  db: Db,
  id: number,
  params: { chavePeca?: string; descricao?: string | null; editedBy?: string; notes?: string },
): PartKeyRow {
  const existing = getPartKey(db, id);
  if (!existing) throw new Error("Chave não encontrada.");

  let chaveChanged = false;

  if (params.chavePeca !== undefined) {
    const chave = params.chavePeca.trim().toUpperCase();
    const norm = normalizeKey(chave);
    if (chave !== existing.chave_peca) {
      db.prepare("UPDATE custom_part_keys SET chave_peca = ?, chave_peca_norm = ?, updated_at = datetime('now') WHERE id = ?")
        .run(chave, norm, id);
      db.prepare(
        `INSERT INTO part_key_edits (chave_peca_norm, field_changed, old_value, new_value, edited_by, notes)
         VALUES (?, 'chave_peca', ?, ?, ?, ?)`,
      ).run(existing.chave_peca_norm, existing.chave_peca, chave, params.editedBy ?? null, params.notes ?? null);
      chaveChanged = true;
    }
  }

  if ("descricao" in params) {
    const newDesc = params.descricao?.trim() || null;
    if (newDesc !== existing.descricao) {
      db.prepare("UPDATE custom_part_keys SET descricao = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newDesc, id);
      db.prepare(
        `INSERT INTO part_key_edits (chave_peca_norm, field_changed, old_value, new_value, edited_by, notes)
         VALUES (?, 'descricao', ?, ?, ?, ?)`,
      ).run(existing.chave_peca_norm, existing.descricao, newDesc, params.editedBy ?? null, params.notes ?? null);
    }
  }

  if (chaveChanged) {
    requestMatchRecompute(db, `Referência editada: ${existing.chave_peca} → ${params.chavePeca}`, "part_key", id);
  }

  return getPartKey(db, id)!;
}

/**
 * Edita uma chave importada (source_inventory_items) criando ou atualizando uma entrada em
 * custom_part_keys. Isso "promove" a chave importada para manual, sobrescrevendo com os novos valores.
 */
export function editImportedKey(
  db: Db,
  originalNorm: string,
  params: { chavePeca?: string; descricao?: string | null; editedBy?: string; notes?: string },
  importBatchId: number | null,
): PartKeyRow {
  // Buscar dados atuais da chave importada
  const imported = importBatchId
    ? (db.prepare(
        `SELECT chave_peca, chave_peca_norm, MIN(referencia) AS referencia
         FROM source_inventory_items
         WHERE import_batch_id = ? AND chave_peca_norm = ?
         GROUP BY chave_peca_norm`,
      ).get(importBatchId, originalNorm) as { chave_peca: string; chave_peca_norm: string; referencia: string } | undefined)
    : undefined;

  const currentChave = imported?.chave_peca ?? originalNorm.toUpperCase();
  const currentDesc = imported?.referencia ?? null;

  // Verificar se já existe como custom
  const existing = getPartKeyByNorm(db, originalNorm);

  if (existing) {
    // Já existe como custom — atualizar normalmente
    return updatePartKey(db, existing.id, params);
  }

  // Criar nova entrada custom e registrar edição inicial
  const newChave = params.chavePeca?.trim().toUpperCase() ?? currentChave;
  const newNorm = normalizeKey(newChave);
  const newDesc = "descricao" in params ? (params.descricao?.trim() || null) : currentDesc;

  // If target norm already exists (e.g. imported key already promoted, or conflicting custom),
  // update that entry instead of failing with UNIQUE constraint
  const existingByNewNorm = getPartKeyByNorm(db, newNorm);
  if (existingByNewNorm) {
    return updatePartKey(db, existingByNewNorm.id, params);
  }

  const res = db.prepare(
    `INSERT INTO custom_part_keys (chave_peca, chave_peca_norm, descricao, created_by, promoted_from_import, original_chave_peca, original_descricao)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(newChave, newNorm, newDesc, params.editedBy?.trim() || null, currentChave, currentDesc);
  const newId = res.lastInsertRowid as number;

  if (params.chavePeca !== undefined && newChave !== currentChave) {
    db.prepare(
      `INSERT INTO part_key_edits (chave_peca_norm, field_changed, old_value, new_value, edited_by, notes)
       VALUES (?, 'chave_peca', ?, ?, ?, ?)`,
    ).run(originalNorm, currentChave, newChave, params.editedBy ?? null, params.notes ?? null);
    requestMatchRecompute(db, `Referência importada editada: ${currentChave} → ${newChave}`, "part_key", newId);
  }
  if ("descricao" in params && newDesc !== currentDesc) {
    db.prepare(
      `INSERT INTO part_key_edits (chave_peca_norm, field_changed, old_value, new_value, edited_by, notes)
       VALUES (?, 'descricao', ?, ?, ?, ?)`,
    ).run(originalNorm, currentDesc, newDesc, params.editedBy ?? null, params.notes ?? null);
  }

  return getPartKey(db, newId)!;
}

export function deletePartKey(db: Db, id: number): void {
  const existing = getPartKey(db, id);
  if (!existing) throw new Error("Chave não encontrada.");
  db.prepare("DELETE FROM custom_part_keys WHERE id = ?").run(id);
}

export function getPartKeyHistory(db: Db, chavePecaNorm: string): PartKeyEditRow[] {
  return db.prepare(
    `SELECT * FROM part_key_edits WHERE chave_peca_norm = ? ORDER BY edited_at DESC`,
  ).all(chavePecaNorm) as unknown as PartKeyEditRow[];
}

// ---------------------------------------------------------------------------
// Compatibilidade manual de chaves (part_key_aliases)
// ---------------------------------------------------------------------------

export class PartKeyAliasError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message);
    this.name = "PartKeyAliasError";
  }
}

export interface PartKeyAliasRow {
  id: number;
  requested_chave_peca: string;
  requested_chave_peca_norm: string;
  stock_chave_peca: string;
  stock_chave_peca_norm: string;
  reason: string | null;
  active: number;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export function listPartKeyAliases(db: Db, search?: string): PartKeyAliasRow[] {
  const q = search?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    return db.prepare(
      `SELECT * FROM part_key_aliases
       WHERE requested_chave_peca LIKE ? ESCAPE '\\' OR stock_chave_peca LIKE ? ESCAPE '\\'
       ORDER BY active DESC, created_at DESC`,
    ).all(like, like) as unknown as PartKeyAliasRow[];
  }
  return db.prepare(
    "SELECT * FROM part_key_aliases ORDER BY active DESC, created_at DESC",
  ).all() as unknown as PartKeyAliasRow[];
}

/**
 * Cria um vínculo de compatibilidade (chave solicitada → chave de estoque) e
 * solicita recálculo do motor. Impede vínculo duplicado, auto-vínculo e ciclo
 * direto (grupos conflitantes).
 */
export function createPartKeyAlias(
  db: Db,
  params: { requestedChavePeca: string; stockChavePeca: string; reason?: string | null; userId?: number | null },
): PartKeyAliasRow {
  const reqNorm = normalizeKey(params.requestedChavePeca);
  const stNorm = normalizeKey(params.stockChavePeca);
  if (!reqNorm || !stNorm) {
    throw new PartKeyAliasError("EMPTY_KEY", 400, "Chaves não podem ser vazias.");
  }
  if (reqNorm === stNorm) {
    throw new PartKeyAliasError("SELF_LINK", 400, "A chave solicitada e a chave de estoque são iguais — vínculo desnecessário.");
  }
  const existing = db.prepare(
    "SELECT id, stock_chave_peca FROM part_key_aliases WHERE requested_chave_peca_norm = ? AND active = 1",
  ).get(reqNorm) as { id: number; stock_chave_peca: string } | undefined;
  if (existing) {
    throw new PartKeyAliasError(
      "DUPLICATE",
      409,
      `Já existe um vínculo ativo para essa chave solicitada (→ ${existing.stock_chave_peca}). Remova-o antes de criar outro.`,
    );
  }
  const inverse = db.prepare(
    "SELECT id FROM part_key_aliases WHERE requested_chave_peca_norm = ? AND stock_chave_peca_norm = ? AND active = 1",
  ).get(stNorm, reqNorm) as { id: number } | undefined;
  if (inverse) {
    throw new PartKeyAliasError(
      "INVERSE_EXISTS",
      409,
      "Já existe o vínculo inverso ativo — a compatibilidade é simétrica no consumo de estoque; use apenas um sentido (solicitada → estoque).",
    );
  }
  const res = db.prepare(`
    INSERT INTO part_key_aliases
      (requested_chave_peca, requested_chave_peca_norm, stock_chave_peca, stock_chave_peca_norm, reason, active, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(
    params.requestedChavePeca.trim(), reqNorm,
    params.stockChavePeca.trim(), stNorm,
    params.reason ?? null,
    params.userId ?? null,
  );
  const id = res.lastInsertRowid as number;
  requestMatchRecompute(db, `ALIAS_CREATED ${reqNorm} → ${stNorm}`, "part_key_alias", id);
  return db.prepare("SELECT * FROM part_key_aliases WHERE id = ?").get(id) as unknown as PartKeyAliasRow;
}

/** Desativa (nunca apaga) um vínculo e solicita recálculo se ele estava ativo. */
export function deactivatePartKeyAlias(db: Db, id: number): { wasActive: boolean } {
  const row = db.prepare(
    "SELECT id, requested_chave_peca_norm, active FROM part_key_aliases WHERE id = ?",
  ).get(id) as { id: number; requested_chave_peca_norm: string; active: number } | undefined;
  if (!row) throw new PartKeyAliasError("NOT_FOUND", 404, "Vínculo não encontrado.");
  db.prepare("UPDATE part_key_aliases SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
  if (row.active === 1) {
    requestMatchRecompute(db, `ALIAS_DEACTIVATED ${row.requested_chave_peca_norm}`, "part_key_alias", id);
  }
  return { wasActive: row.active === 1 };
}

export interface AllPartKeyRow {
  id: number | null;           // null = importada sem override
  chave_peca: string;
  chave_peca_norm: string;
  descricao: string | null;
  source: "IMPORTADA" | "MANUAL";
  created_by: string | null;
  created_at: string | null;
  /** true quando importada e editada manualmente (override ativo) */
  isOverride: boolean;
  originalChavePeca: string | null;
  originalDescricao: string | null;
}

interface CustomKeyRow extends PartKeyRow {
  promoted_from_import: number;
  original_chave_peca: string | null;
  original_descricao: string | null;
}

/** Todas as chaves: importadas do legado + criadas manualmente. */
export function listAllPartKeys(db: Db, importBatchId: number | null, search?: string): AllPartKeyRow[] {
  const like = search?.trim();

  const customRows = db.prepare(
    `SELECT id, chave_peca, chave_peca_norm, descricao, created_by, created_at,
            promoted_from_import, original_chave_peca, original_descricao
     FROM custom_part_keys
     ${like ? "WHERE chave_peca LIKE ? OR descricao LIKE ? OR original_chave_peca LIKE ?" : ""}
     ORDER BY chave_peca`,
  ).all(...(like ? [`%${like}%`, `%${like}%`, `%${like}%`] : [])) as unknown as CustomKeyRow[];

  const customNorms = new Set(customRows.map(r => r.chave_peca_norm));

  let legacyRows: { chave_peca: string; chave_peca_norm: string; referencia: string }[] = [];
  if (importBatchId) {
    legacyRows = db.prepare(
      `SELECT chave_peca, chave_peca_norm, MIN(referencia) AS referencia
       FROM source_inventory_items
       WHERE import_batch_id = ? AND chave_peca_norm IS NOT NULL AND chave_peca_norm != ''
         ${like ? "AND (chave_peca LIKE ? OR referencia LIKE ?)" : ""}
       GROUP BY chave_peca_norm
       ORDER BY chave_peca`,
    ).all(importBatchId, ...(like ? [`%${like}%`, `%${like}%`] : [])) as unknown as { chave_peca: string; chave_peca_norm: string; referencia: string }[];
  }

  const result: AllPartKeyRow[] = [];

  for (const r of customRows) {
    const isOverride = r.promoted_from_import === 1;
    result.push({
      id: r.id,
      chave_peca: r.chave_peca,
      chave_peca_norm: r.chave_peca_norm,
      descricao: r.descricao,
      // overrides mantêm source IMPORTADA para o frontend saber que pode restaurar
      source: isOverride ? "IMPORTADA" : "MANUAL",
      created_by: r.created_by,
      created_at: r.created_at,
      isOverride,
      originalChavePeca: r.original_chave_peca ?? null,
      originalDescricao: r.original_descricao ?? null,
    });
  }

  for (const r of legacyRows) {
    if (!customNorms.has(r.chave_peca_norm)) {
      result.push({
        id: null,
        chave_peca: r.chave_peca,
        chave_peca_norm: r.chave_peca_norm,
        descricao: r.referencia || null,
        source: "IMPORTADA",
        created_by: null,
        created_at: null,
        isOverride: false,
        originalChavePeca: null,
        originalDescricao: null,
      });
    }
  }

  result.sort((a, b) => a.chave_peca.localeCompare(b.chave_peca));
  return result;
}

/**
 * Remove o override de uma chave importada editada, restaurando o valor original.
 * Só funciona para chaves com promoted_from_import = 1.
 */
export function restoreImportedKey(
  db: Db,
  norm: string,
  params: { editedBy?: string; notes?: string },
): void {
  const existing = db.prepare(
    "SELECT id, chave_peca, descricao, original_chave_peca, original_descricao, promoted_from_import FROM custom_part_keys WHERE chave_peca_norm = ?",
  ).get(norm) as (PartKeyRow & { promoted_from_import: number; original_chave_peca: string | null; original_descricao: string | null }) | undefined;

  if (!existing) throw new Error("Chave não encontrada ou não é um override.");
  if (existing.promoted_from_import !== 1) throw new Error("Apenas overrides de chaves importadas podem ser restaurados.");

  db.prepare(
    `INSERT INTO part_key_edits (chave_peca_norm, field_changed, old_value, new_value, edited_by, notes)
     VALUES (?, 'chave_peca', ?, ?, ?, ?)`,
  ).run(norm, existing.chave_peca, existing.original_chave_peca, params.editedBy ?? null, params.notes ?? "Restaurado para valor importado");

  if (existing.descricao !== existing.original_descricao) {
    db.prepare(
      `INSERT INTO part_key_edits (chave_peca_norm, field_changed, old_value, new_value, edited_by, notes)
       VALUES (?, 'descricao', ?, ?, ?, ?)`,
    ).run(norm, existing.descricao, existing.original_descricao, params.editedBy ?? null, params.notes ?? "Restaurado para valor importado");
  }

  db.prepare("DELETE FROM custom_part_keys WHERE id = ?").run(existing.id);
  requestMatchRecompute(db, `Referência restaurada: ${existing.chave_peca} → ${existing.original_chave_peca ?? norm}`, "part_key", existing.id);
}
