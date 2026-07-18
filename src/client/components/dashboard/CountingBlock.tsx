import type { CountingBlockData } from "./types.js";

function fmt(n: number) { return n.toLocaleString("pt-BR"); }

function fmtDate(s: string) {
  return new Date(s + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
}

interface Props {
  counting: CountingBlockData;
}

export function CountingBlock({ counting }: Props) {
  const statusLabel = {
    ok: "Em dia",
    warn: "Atencao",
    late: "Atrasada",
  }[counting.streakStatus];
  const statusClass = {
    ok: "badge-ok",
    warn: "badge-warn",
    late: "badge-err",
  }[counting.streakStatus];

  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>Contagens</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span className={`badge ${statusClass}`} style={{ fontSize: "0.75rem" }}>{statusLabel}</span>
          {counting.currentStreak > 0 && (
            <span className="muted" style={{ fontSize: "0.78rem" }}>
              {counting.currentStreak} dia{counting.currentStreak > 1 ? "s" : ""} seguidos
            </span>
          )}
        </div>
      </div>

      {/* Mini-calendario dos ultimos 5 dias uteis */}
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.75rem" }}>
        {counting.days.map((day) => {
          const hasCount = day.sessionCount > 0;
          return (
            <div
              key={day.date}
              title={hasCount ? `${fmtDate(day.date)} — ${fmt(day.totalScanned)} bipagens` : fmtDate(day.date)}
              style={{
                flex: 1,
                borderRadius: "var(--r-sm)",
                background: hasCount ? "var(--ok-bg, rgba(34,197,94,0.15))" : "var(--card-bg)",
                border: `1px solid ${hasCount ? "var(--ok-border, rgba(34,197,94,0.3))" : "var(--border)"}`,
                padding: "0.4rem 0.3rem",
                textAlign: "center",
                fontSize: "0.7rem",
              }}
            >
              <div className="muted">{fmtDate(day.date).slice(0, 3)}</div>
              <div style={{ fontWeight: 700, color: hasCount ? "var(--ok-text)" : "var(--muted)" }}>
                {hasCount ? fmt(day.totalScanned) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      {counting.lastSession ? (
        <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
          Ultima contagem:{" "}
          <strong style={{ color: "var(--text)" }}>
            {counting.lastSession.responsibleName ?? "—"}
          </strong>
          {" "}&middot; {counting.lastSession.countType ?? "OFICIAL"}
          {" "}&middot; {fmt(counting.lastSession.totalScanned)} bipagens
          {counting.lastSession.finalizedAt && (
            <> &middot; {counting.lastSession.finalizedAt.slice(0, 16).replace("T", " ")}</>
          )}
        </p>
      ) : (
        <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
          Nenhuma contagem finalizada encontrada.
        </p>
      )}
    </div>
  );
}
