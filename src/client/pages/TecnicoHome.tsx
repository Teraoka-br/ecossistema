import { useEffect, useState, useCallback } from "react";
import { Wrench, CheckCircle, AlertCircle, Calendar } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface TecnicoStats {
  linked: boolean;
  staffName: string | null;
  current: number;
  completed: number;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function TecnicoHome() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [stats, setStats] = useState<TecnicoStats | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      const r = await fetch(`/api/fila-reparos/minha-fila/stats?${qs}`);
      if (r.ok) setStats(await r.json() as TecnicoStats);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  if (!loading && stats && !stats.linked) {
    return (
      <div style={{ padding: "2rem", maxWidth: 480 }}>
        <div className="alert alert-warn" style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            Sua conta ainda não está vinculada a um técnico. Peça ao administrador para fazer o vínculo em{" "}
            <strong>Administração → Pessoas → Técnicos</strong>.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {stats?.staffName ? `Olá, ${stats.staffName}` : "Início"}
          </h1>
          <p className="page-subtitle">Resumo do seu trabalho</p>
        </div>
      </div>

      {/* Cards de resumo */}
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
        <button
          className="kpi-card"
          onClick={() => navigate("/minha-fila")}
          style={{
            cursor: "pointer", textAlign: "left", font: "inherit",
            border: "1px solid var(--border)", background: "var(--surface)",
            minWidth: 180, flex: "1 1 180px",
            transition: "border-color 0.15s, box-shadow 0.15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--accent)")}
          onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
        >
          <div className="kpi-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <Wrench size={12} /> Com você agora
          </div>
          <div className="kpi-value" style={{ color: "var(--accent)" }}>
            {loading ? "…" : stats?.current ?? 0}
          </div>
          <div className="kpi-sub">aparelhos direcionados</div>
        </button>

        <div
          className="kpi-card"
          style={{
            border: "1px solid rgba(16,185,129,0.3)",
            minWidth: 180, flex: "1 1 180px",
          }}
        >
          <div className="kpi-label" style={{ color: "var(--ok-text)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <CheckCircle size={12} /> Realizados no período
          </div>
          <div className="kpi-value" style={{ color: "var(--ok-text)" }}>
            {loading ? "…" : stats?.completed ?? 0}
          </div>
          <div className="kpi-sub">reparos concluídos</div>
        </div>
      </div>

      {/* Filtro de período */}
      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
          <Calendar size={14} style={{ opacity: 0.6 }} />
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Período</span>
        </div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 140 }}>
            <label>De</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 140 }}>
            <label>Até</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: "0.4rem", paddingBottom: "0.15rem" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => { setFrom(monthStart()); setTo(today()); }}>
              Este mês
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
