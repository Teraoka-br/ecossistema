import type { Db } from "../db/database.js";

export interface CountingDaySummary {
  date: string;         // YYYY-MM-DD
  sessionCount: number;
  totalScanned: number;
  isWeekday: boolean;
  sessions: {
    id: number;
    responsibleName: string | null;
    countType: string | null;
    totalScanned: number;
    finalizedAt: string | null;
  }[];
}

export interface CountingBlockData {
  days: CountingDaySummary[];           // Ãºltimos 5 dias Ãºteis
  currentStreak: number;                // dias Ãºteis consecutivos com contagem
  streakStatus: "ok" | "warn" | "late";
  lastSession: {
    id: number;
    responsibleName: string | null;
    countType: string | null;
    finalizedAt: string | null;
    totalScanned: number;
  } | null;
}

function isWeekday(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z").getDay();
  return d >= 1 && d <= 5;
}

/** Gera as Ãºltimas N datas de dias Ãºteis (YYYY-MM-DD) no fuso SP, excluindo hoje. */
function lastNBusinessDays(n: number): string[] {
  const result: string[] = [];
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  let d = new Date(now);
  d.setDate(d.getDate() - 1);
  while (result.length < n) {
    if (isWeekday(d.toISOString().slice(0, 10))) {
      result.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() - 1);
  }
  return result;
}

export function getCountingBlockData(db: Db): CountingBlockData {
  const targetDays = lastNBusinessDays(5);

  type SessionRow = {
    id: number;
    responsible_name: string | null;
    count_type: string | null;
    created_at: string;
    finalized_at: string | null;
    total_scanned: number;
  };

  const minDate = targetDays[targetDays.length - 1];
  const sessions = db
    .prepare(
      `SELECT cs.id, cs.responsible_name, cs.count_type, cs.started_at as created_at,
              cs.finished_at as finalized_at,
              COUNT(sc.id) as total_scanned
       FROM count_sessions cs
       LEFT JOIN count_scans sc ON sc.session_id = cs.id AND sc.cancelled_at IS NULL
       WHERE cs.status = 'FINALIZED'
         AND DATE(cs.started_at) >= ?
       GROUP BY cs.id
       ORDER BY cs.id DESC`,
    )
    .all(minDate) as SessionRow[];

  // Agrupar por data
  const byDate = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const date = s.created_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(s);
  }

  const days: CountingDaySummary[] = targetDays.map((date) => {
    const daySessions = byDate.get(date) ?? [];
    return {
      date,
      sessionCount: daySessions.length,
      totalScanned: daySessions.reduce((s, x) => s + x.total_scanned, 0),
      isWeekday: true,
      sessions: daySessions.map((s) => ({
        id: s.id,
        responsibleName: s.responsible_name,
        countType: s.count_type,
        totalScanned: s.total_scanned,
        finalizedAt: s.finalized_at,
      })),
    };
  });

  // Streak: quantos dias Ãºteis consecutivos (de hoje para trÃ¡s) tiveram contagem
  let streak = 0;
  for (const day of days) {
    if (day.sessionCount > 0) streak++;
    else break;
  }

  const missingDays = days.filter((d) => d.sessionCount === 0).length;
  const streakStatus: "ok" | "warn" | "late" =
    missingDays === 0 ? "ok" : missingDays <= 1 ? "warn" : "late";

  // Ãšltima sessÃ£o finalizada
  const lastRow = db
    .prepare(
      `SELECT cs.id, cs.responsible_name, cs.count_type,
              cs.started_at as created_at, cs.finished_at as finalized_at,
              COUNT(sc.id) as total_scanned
       FROM count_sessions cs
       LEFT JOIN count_scans sc ON sc.session_id = cs.id AND sc.cancelled_at IS NULL
       WHERE cs.status = 'FINALIZED'
       GROUP BY cs.id
       ORDER BY cs.id DESC LIMIT 1`,
    )
    .get() as (SessionRow & { finalized_at: string | null }) | undefined;

  return {
    days,
    currentStreak: streak,
    streakStatus,
    lastSession: lastRow
      ? {
          id: lastRow.id,
          responsibleName: lastRow.responsible_name,
          countType: lastRow.count_type,
          finalizedAt: lastRow.finalized_at,
          totalScanned: lastRow.total_scanned,
        }
      : null,
  };
}
