import { useState } from "react";
import { FileText, X, Check } from "lucide-react";
import type { CountingBlockData } from "./types.js";

function fmt(n: number) { return n.toLocaleString("pt-BR"); }

function fmtDate(s: string) {
  return new Date(s + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
}

interface Props {
  counting: CountingBlockData;
  onRefresh?: () => void;
}

export function CountingBlock({ counting, onRefresh }: Props) {
  const [justifyDay, setJustifyDay] = useState<string | null>(null);
  const [justifyText, setJustifyText] = useState("");
  const [saving, setSaving] = useState(false);

  const statusLabel = { ok: "Em dia", warn: "Atencao", late: "Atrasada" }[counting.streakStatus];
  const statusClass = { ok: "badge-ok", warn: "badge-warn", late: "badge-err" }[counting.streakStatus];

  async function saveJustification(date: string) {
    setSaving(true);
    try {
      await fetch("/api/dashboards/counting/justify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, justification: justifyText }),
      });
      setJustifyDay(null);
      setJustifyText("");
      onRefresh?.();
    } finally { setSaving(false); }
  }

  function openJustify(date: string, existing: string | null) {
    setJustifyDay(date);
    setJustifyText(existing ?? "");
  }

  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>Contagens (Seg–Sex)</h2>
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
          const hasJust = !!day.justification;
          return (
            <div
              key={day.date}
              title={
                hasCount
                  ? `${fmtDate(day.date)} — ${fmt(day.totalScanned)} bipagens`
                  : hasJust
                  ? `${fmtDate(day.date)} — ${day.justification}`
                  : fmtDate(day.date)
              }
              style={{
                flex: 1,
                borderRadius: "var(--r-sm)",
                background: hasCount
                  ? "var(--ok-bg, rgba(34,197,94,0.15))"
                  : hasJust
                  ? "rgba(251,191,36,0.1)"
                  : "var(--card-bg)",
                border: `1px solid ${hasCount ? "var(--ok-border, rgba(34,197,94,0.3))" : hasJust ? "rgba(251,191,36,0.4)" : "var(--border)"}`,
                padding: "0.4rem 0.3rem",
                textAlign: "center",
                fontSize: "0.7rem",
                position: "relative",
              }}
            >
              <div className="muted">{fmtDate(day.date).slice(0, 3)}</div>
              <div style={{ fontWeight: 700, color: hasCount ? "var(--ok-text)" : hasJust ? "var(--warn-text)" : "var(--muted)" }}>
                {hasCount ? fmt(day.totalScanned) : hasJust ? "Justif." : "—"}
              </div>
              {!hasCount && (
                <button
                  style={{
                    position: "absolute", top: 2, right: 2,
                    background: "none", border: "none", cursor: "pointer",
                    padding: "0.1rem", opacity: 0.5, display: "flex",
                  }}
                  title="Justificar falta"
                  onClick={e => { e.stopPropagation(); openJustify(day.date, day.justification); }}
                >
                  <FileText size={9} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Formulário de justificativa inline */}
      {justifyDay && (
        <div style={{
          marginBottom: "0.75rem", padding: "0.6rem 0.75rem",
          background: "var(--surface-alt)", borderRadius: "var(--r-sm)",
          border: "1px solid var(--border)",
        }}>
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.4rem" }}>
            Justificativa para {fmtDate(justifyDay)}:
          </div>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              value={justifyText}
              onChange={e => setJustifyText(e.target.value)}
              placeholder="Ex: João de folga, feriado municipal..."
              style={{ flex: 1, fontSize: "0.82rem" }}
              onKeyDown={e => { if (e.key === "Enter") saveJustification(justifyDay); if (e.key === "Escape") setJustifyDay(null); }}
              autoFocus
            />
            <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => saveJustification(justifyDay)}>
              <Check size={12} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setJustifyDay(null)}>
              <X size={12} />
            </button>
          </div>
          {justifyText && (
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.3rem" }}>
              Deixe em branco para remover a justificativa existente.
            </div>
          )}
        </div>
      )}

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
