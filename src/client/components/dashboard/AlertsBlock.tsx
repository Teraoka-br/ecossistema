import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { OperationalAlert } from "./types.js";

interface Props {
  alerts: OperationalAlert[];
}

export function AlertsBlock({ alerts }: Props) {
  const navigate = useNavigate();

  const iconFor = (s: "INFO" | "WARN" | "CRITICAL") =>
    s === "CRITICAL" ? "🔴" : s === "WARN" ? "🟡" : "🔵";

  const classFor = (s: "INFO" | "WARN" | "CRITICAL") =>
    s === "CRITICAL" ? "alert-err" : s === "WARN" ? "alert-warn" : "alert-info";

  return (
    <div className="card" style={{ margin: 0 }}>
      <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Avisos e alertas</h2>
      {alerts.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Nenhum alerta operacional no momento.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {alerts.map((a) => (
            <div
              key={a.code}
              className={`alert ${classFor(a.severity)}`}
              style={{
                display: "flex", alignItems: "flex-start", gap: "0.5rem",
                padding: "0.6rem 0.75rem", margin: 0,
                cursor: a.route ? "pointer" : undefined,
                transition: "opacity 0.15s",
              }}
              onClick={() => a.route && navigate(a.route)}
              role={a.route ? "button" : undefined}
              tabIndex={a.route ? 0 : undefined}
              onKeyDown={e => { if (a.route && (e.key === "Enter" || e.key === " ")) navigate(a.route); }}
            >
              <span style={{ flexShrink: 0, marginTop: "0.05rem" }}>{iconFor(a.severity)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{a.title}</div>
                <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.15rem" }}>{a.description}</div>
                {a.count > 0 && (
                  <span className="badge badge-muted" style={{ fontSize: "0.7rem", marginTop: "0.25rem" }}>
                    {a.count.toLocaleString("pt-BR")} ocorrencia(s)
                  </span>
                )}
              </div>
              {a.route && (
                <ArrowRight size={14} style={{ flexShrink: 0, opacity: 0.5, marginTop: "0.15rem" }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
