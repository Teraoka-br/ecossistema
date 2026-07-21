import type { Db } from "../db/database.js";

export type IssueModule =
  | "DASHBOARD" | "FILA_REPAROS" | "ANALISE" | "ESTOQUE"
  | "REFERENCIAS" | "PEDIDOS" | "CONTAGEM" | "MATCH_RULES"
  | "USUARIOS" | "OUTRO";

export type IssueSeverityReport = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type IssueStatus =
  | "OPEN" | "IN_ANALYSIS"
  | "AWAITING_TEST"   // correção aplicada, aguardando validação em produção
  | "RESOLVED" | "DISMISSED";

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
  fix_commit: string | null;
  validated_by_user_id: number | null;
  validated_at: string | null;
  metadata_json: string | null;
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
  fix_commit?: string;
  validatedByUserId?: number;
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
  const isReopening = input.status === "OPEN" || input.status === "IN_ANALYSIS";
  const isResolving = input.status === "RESOLVED" || input.status === "AWAITING_TEST";
  const isValidating = input.status === "RESOLVED" && input.validatedByUserId;

  // resolved_at: seta ao resolver, limpa ao reabrir
  const resolvedAt = isReopening ? null : isResolving ? (existing.resolved_at ?? now) : existing.resolved_at;
  // validated_at: seta ao validar (RESOLVED com validador)
  const validatedAt = isValidating ? now : (isReopening ? null : existing.validated_at);

  db.prepare(
    `UPDATE issue_reports SET
       status              = COALESCE(?, status),
       resolution_notes    = COALESCE(?, resolution_notes),
       resolved_at         = ?,
       resolved_by_user_id = COALESCE(?, resolved_by_user_id),
       fix_commit          = COALESCE(?, fix_commit),
       validated_by_user_id= COALESCE(?, validated_by_user_id),
       validated_at        = ?,
       updated_at          = ?
     WHERE id=?`,
  ).run(
    input.status ?? null,
    input.resolution_notes ?? null,
    resolvedAt,
    input.resolvedByUserId ?? null,
    input.fix_commit ?? null,
    input.validatedByUserId ?? null,
    validatedAt,
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
  awaitingTestCount: number;
  recent: IssueReport[];
  awaitingTest: IssueReport[];
  resolved: IssueReport[];
} {
  const openCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM issue_reports WHERE status IN ('OPEN','IN_ANALYSIS','AWAITING_TEST')`,
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
  const awaitingTestCount = (
    db
      .prepare(`SELECT COUNT(*) as c FROM issue_reports WHERE status='AWAITING_TEST'`)
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
  const awaitingTest = db
    .prepare(
      `SELECT * FROM issue_reports WHERE status='AWAITING_TEST'
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all() as unknown as IssueReport[];
  const resolved = db
    .prepare(
      `SELECT * FROM issue_reports
       WHERE status IN ('RESOLVED','DISMISSED')
       ORDER BY resolved_at DESC LIMIT 20`,
    )
    .all() as unknown as IssueReport[];
  return { openCount, criticalCount, awaitingTestCount, recent, awaitingTest, resolved };
}
