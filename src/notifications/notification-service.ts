import type { Db } from "../db/database.js";

export type NotifRole = "ADMIN" | "OPERATOR" | "TECHNICIAN";

export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  route: string | null;
  entityType: string | null;
  entityId: number | null;
  createdAt: string;
  isRead: boolean;
}

export interface NotificationsResponse {
  unread: number;
  items: Notification[];
}

interface CreateInput {
  targetRole?: NotifRole;
  targetUserId?: number;
  type: string;
  title: string;
  body?: string;
  route?: string;
  entityType?: string;
  entityId?: number;
}

export function createNotification(db: Db, input: CreateInput): void {
  db.prepare(`
    INSERT INTO notifications (target_role, target_user_id, type, title, body, route, entity_type, entity_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.targetRole ?? null,
    input.targetUserId ?? null,
    input.type,
    input.title,
    input.body ?? null,
    input.route ?? null,
    input.entityType ?? null,
    input.entityId ?? null,
  );
}

export function getNotificationsForUser(
  db: Db,
  userId: number,
  role: NotifRole,
  limit = 30,
): NotificationsResponse {
  type Row = {
    id: number; type: string; title: string; body: string | null;
    route: string | null; entity_type: string | null; entity_id: number | null;
    created_at: string; is_read: number;
  };

  const rows = db.prepare(`
    SELECT
      n.id, n.type, n.title, n.body, n.route, n.entity_type, n.entity_id, n.created_at,
      CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
    FROM notifications n
    LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?1
    WHERE (n.target_user_id = ?1 OR n.target_role = ?2 OR n.target_role IS NULL)
    ORDER BY n.created_at DESC
    LIMIT ?3
  `).all(userId, role, limit) as Row[];

  const items: Notification[] = rows.map(r => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    route: r.route,
    entityType: r.entity_type,
    entityId: r.entity_id,
    createdAt: r.created_at,
    isRead: r.is_read === 1,
  }));

  const unread = items.filter(i => !i.isRead).length;
  return { unread, items };
}

export function markAllRead(db: Db, userId: number, role: NotifRole): void {
  const ids = (db.prepare(`
    SELECT n.id FROM notifications n
    LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?1
    WHERE (n.target_user_id = ?1 OR n.target_role = ?2 OR n.target_role IS NULL)
      AND nr.user_id IS NULL
  `).all(userId, role) as { id: number }[]).map(r => r.id);

  if (ids.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)`,
  );
  for (const id of ids) stmt.run(id, userId);
}

export function markOneRead(db: Db, notifId: number, userId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)`,
  ).run(notifId, userId);
}

export function pruneOldNotifications(db: Db, keepDays = 30): void {
  db.prepare(
    `DELETE FROM notifications WHERE created_at < datetime('now', '-' || ? || ' days')`,
  ).run(keepDays);
}
