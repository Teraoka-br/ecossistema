import type { Db } from "../db/database.js";

export interface StaffMember {
  id: number;
  name: string;
  type: "TECHNICIAN";
  active: boolean;
  userId: number | null;
  createdAt: string;
  updatedAt: string;
}

export class StaffError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StaffError";
  }
}

export function listStaff(db: Db, opts: { activeOnly?: boolean } = {}): StaffMember[] {
  const where = opts.activeOnly ? "WHERE active = 1" : "";
  const rows = db
    .prepare(`SELECT id, name, type, active, user_id, created_at, updated_at FROM staff_members ${where} ORDER BY name`)
    .all() as unknown as StaffRow[];
  return rows.map(toStaffMember);
}

export function getStaffById(db: Db, id: number): StaffMember | null {
  const row = db
    .prepare("SELECT id, name, type, active, user_id, created_at, updated_at FROM staff_members WHERE id = ?")
    .get(id) as StaffRow | undefined;
  return row ? toStaffMember(row) : null;
}

export function getStaffByUserId(db: Db, userId: number): StaffMember | null {
  const row = db
    .prepare("SELECT id, name, type, active, user_id, created_at, updated_at FROM staff_members WHERE user_id = ?")
    .get(userId) as StaffRow | undefined;
  return row ? toStaffMember(row) : null;
}

export function createStaff(db: Db, params: { name: string; type?: "TECHNICIAN" }): StaffMember {
  if (!params.name?.trim()) throw new StaffError("INVALID_NAME", "Nome é obrigatório.");
  const res = db
    .prepare("INSERT INTO staff_members (name, type) VALUES (?, ?)")
    .run(params.name.trim(), params.type ?? "TECHNICIAN");
  return getStaffById(db, res.lastInsertRowid as number)!;
}

export function updateStaff(
  db: Db,
  id: number,
  params: { name?: string; active?: boolean },
): StaffMember {
  const member = getStaffById(db, id);
  if (!member) throw new StaffError("NOT_FOUND", "Técnico não encontrado.");
  if (params.name !== undefined) {
    if (!params.name.trim()) throw new StaffError("INVALID_NAME", "Nome é obrigatório.");
    db.prepare("UPDATE staff_members SET name = ?, updated_at = datetime('now') WHERE id = ?").run(
      params.name.trim(),
      id,
    );
  }
  if (params.active !== undefined) {
    db.prepare("UPDATE staff_members SET active = ?, updated_at = datetime('now') WHERE id = ?").run(
      params.active ? 1 : 0,
      id,
    );
  }
  return getStaffById(db, id)!;
}

export function linkUserToStaff(db: Db, staffId: number, userId: number | null): StaffMember {
  const member = getStaffById(db, staffId);
  if (!member) throw new StaffError("NOT_FOUND", "Técnico não encontrado.");
  if (userId !== null) {
    // Garante que o usuário não está vinculado a outro técnico
    const existing = db
      .prepare("SELECT id FROM staff_members WHERE user_id = ? AND id != ?")
      .get(userId, staffId) as { id: number } | undefined;
    if (existing) throw new StaffError("USER_ALREADY_LINKED", "Este usuário já está vinculado a outro técnico.");
  }
  db.prepare("UPDATE staff_members SET user_id = ?, updated_at = datetime('now') WHERE id = ?").run(
    userId,
    staffId,
  );
  return getStaffById(db, staffId)!;
}

interface StaffRow {
  id: number;
  name: string;
  type: string;
  active: number;
  user_id: number | null;
  created_at: string;
  updated_at: string;
}

function toStaffMember(r: StaffRow): StaffMember {
  return {
    id: r.id,
    name: r.name,
    type: r.type as "TECHNICIAN",
    active: r.active === 1,
    userId: r.user_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
