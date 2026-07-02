import type { Db } from "../db/database.js";

export interface AuditParams {
  userId: number | null | undefined;
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

export function logAudit(db: Db, params: AuditParams): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      params.userId ?? null,
      params.action,
      params.entityType ?? null,
      params.entityId ?? null,
      params.meta ? JSON.stringify(params.meta) : null,
    );
  } catch {
    // Auditoria nunca deve quebrar fluxo principal
  }
}

export function getAuditLog(
  db: Db,
  opts: { entityType?: string; entityId?: string; limit?: number; offset?: number } = {},
): { entries: AuditEntry[]; total: number } {
  const conditions: string[] = [];
  const p: (string | number | null)[] = [];

  if (opts.entityType) { conditions.push("entity_type = ?"); p.push(opts.entityType); }
  if (opts.entityId)   { conditions.push("entity_id = ?");   p.push(opts.entityId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit  = opts.limit  ?? 50;
  const offset = opts.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...p) as { c: number }).c;

  const rows = db
    .prepare(
      `SELECT a.id, a.user_id, u.username, a.action, a.entity_type, a.entity_id, a.metadata_json, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...p, limit, offset) as unknown as AuditRow[];

  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username ?? null,
      action: r.action,
      entityType: r.entity_type ?? null,
      entityId: r.entity_id ?? null,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
      createdAt: r.created_at,
    })),
  };
}

interface AuditRow {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
