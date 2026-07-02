import type { Db } from "../db/database.js";

export interface StaffMember {
  id: number;
  name: string;
  type: "TECHNICIAN";
  active: boolean;
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
    .prepare(`SELECT id, name, type, active, created_at, updated_at FROM staff_members ${where} ORDER BY name`)
    .all() as unknown as StaffRow[];
  return rows.map(toStaffMember);
}

export function getStaffById(db: Db, id: number): StaffMember | null {
  const row = db
    .prepare("SELECT id, name, type, active, created_at, updated_at FROM staff_members WHERE id = ?")
    .get(id) as StaffRow | undefined;
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

interface StaffRow {
  id: number;
  name: string;
  type: string;
  active: number;
  created_at: string;
  updated_at: string;
}

function toStaffMember(r: StaffRow): StaffMember {
  return {
    id: r.id,
    name: r.name,
    type: r.type as "TECHNICIAN",
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
