import type { Db } from "../db/database.js";

export type IssueModule =
  | "DASHBOARD" | "FILA_REPAROS" | "ANALISE" | "ESTOQUE"
  | "REFERENCIAS" | "PEDIDOS" | "CONTAGEM" | "MATCH_RULES"
  | "USUARIOS" | "OUTRO";

export type IssueSeverityReport = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type IssueStatus = "OPEN" | "IN_ANALYSIS" | "RESOLVED" | "DISMISSED";

export interface IssueReport {
  id: number;
  title: string;
  description: string | null;
  module: IssueModule;
  severity: IssueSeverityReport;
  status: IssueStatus;
  created_by_user_id: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_user_id: number | null;
  resolution_notes: string | null;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  module: IssueModule;
  severity: IssueSeverityReport;
  userId: number | null;
  userName: string | null;
  metadataJson?: string | null;
}

export interface UpdateIssueInput {
  status?: IssueStatus;
  resolution_notes?: string;
  resolvedByUserId?: number;
}

export function listIssues(
  db: Db,
  opts: { userId?: number; isAdmin?: boolean; limit?: number } = {},
): IssueReport[] {
  const limit = opts.limit ?? 50;
  if (opts.isAdmin) {
    return db
      .prepare(
        `SELECT * FROM issue_reports ORDER BY
           CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
           created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as IssueReport[];
  }
  return db
    .prepare(
      `SELECT * FROM issue_reports WHERE created_by_user_id=?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(opts.userId ?? null, limit) as unknown as IssueReport[];
}

export function createIssue(db: Db, input: CreateIssueInput): IssueReport {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO issue_reports
         (title, description, module, severity, status,
          created_by_user_id, created_by_name, created_at, updated_at, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.title.trim(),
      input.description?.trim() ?? null,
      input.module,
      input.severity,
      "OPEN",
      input.userId,
      input.userName,
      now,
      now,
      input.metadataJson ?? null,
    );
  return db
    .prepare(`SELECT * FROM issue_reports WHERE id=?`)
    .get(result.lastInsertRowid) as unknown as IssueReport;
}

export function updateIssue(
  db: Db,
  id: number,
  input: UpdateIssueInput,
): IssueReport | null {
  const existing = db
    .prepare(`SELECT * FROM issue_reports WHERE id=?`)
    .get(id) as IssueReport | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  const resolvedAt =
    input.status === "RESOLVED" ? now : existing.resolved_at;

  db.prepare(
    `UPDATE issue_reports SET
       status             = COALESCE(?, status),
       resolution_notes   = COALESCE(?, resolution_notes),
       resolved_at        = ?,
       resolved_by_user_id= COALESCE(?, resolved_by_user_id),
       updated_at         = ?
     WHERE id=?`,
  ).run(
    input.status ?? null,
    input.resolution_notes ?? null,
    resolvedAt,
    input.resolvedByUserId ?? null,
    now,
    id,
  );

  return db
    .prepare(`SELECT * FROM issue_reports WHERE id=?`)
    .get(id) as unknown as IssueReport;
}

export function getIssueSummary(db: Db): {
  openCount: number;
  criticalCount: number;
  recent: IssueReport[];
  resolved: IssueReport[];
} {
  const openCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM issue_reports WHERE status IN ('OPEN','IN_ANALYSIS')`,
      )
      .get() as { c: number }
  ).c;
  const criticalCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM issue_reports
         WHERE status IN ('OPEN','IN_ANALYSIS') AND severity='CRITICAL'`,
      )
      .get() as { c: number }
  ).c;
  const recent = db
    .prepare(
      `SELECT * FROM issue_reports
       WHERE status IN ('OPEN','IN_ANALYSIS')
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                created_at DESC LIMIT 20`,
    )
    .all() as unknown as IssueReport[];
  const resolved = db
    .prepare(
      `SELECT * FROM issue_reports
       WHERE status IN ('RESOLVED','DISMISSED')
       ORDER BY resolved_at DESC LIMIT 20`,
    )
    .all() as unknown as IssueReport[];
  return { openCount, criticalCount, recent, resolved };
}
