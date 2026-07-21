import { useCallback, useEffect, useState } from "react";
import { Loading } from "../ui.js";
import type { HomeData, CardMetric } from "../components/dashboard/types.js";
import type { SparkRow } from "../components/dashboard/OperationalCards.js";
import { OperationalCards } from "../components/dashboard/OperationalCards.js";
import { OperationalTimeline } from "../components/dashboard/OperationalTimeline.js";
import { PanoramaBlock } from "../components/dashboard/PanoramaBlock.js";
import { TechnicianBlock } from "../components/dashboard/TechnicianBlock.js";
import { CountingBlock } from "../components/dashboard/CountingBlock.js";
import { AlertsBlock } from "../components/dashboard/AlertsBlock.js";
import { IssueReportsBlock } from "../components/dashboard/IssueReportsBlock.js";
import { FinancialBlock } from "../components/dashboard/FinancialBlock.js";

const PERIODS = [
  { label: "Hoje", value: 1 },
  { label: "7 dias", value: 7 },
  { label: "15 dias", value: 15 },
  { label: "30 dias", value: 30 },
];

function fmtDt(s: string) { return s.slice(0, 19).replace("T", " "); }

export function AdminDashboards() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<CardMetric | null>(null);
  const [period, setPeriod] = useState(7);
  const [sparkData, setSparkData] = useState<SparkRow[]>([]);

  const load = useCallback(() => {
    setError(null);
    setLoading(true);
    fetch("/api/dashboards/home")
      .then((r) => r.ok ? r.json() as Promise<HomeData> : r.json().then((j: { error?: string }) => Promise.reject(new Error(j.error ?? `Erro ${r.status}`))))
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    fetch(`/api/dashboards/timeline/multi?from=${from}`)
      .then(r => r.ok ? r.json() as Promise<{ data: SparkRow[] }> : Promise.reject())
      .then(j => setSparkData(j.data))
      .catch(() => {});
  }, []);

  if (error) return (
    <div>
      <div className="page-header"><h1>Central Operacional</h1></div>
      <div className="alert alert-err">{error}</div>
    </div>
  );
  if (loading && !data) return <Loading what="central operacional" />;
  if (!data) return null;

  return (
    <div>
      {/* ── Cabecalho ───────────────────────────────────────────── */}
      <div className="page-header" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <h1>Central Operacional</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          {/* Filtro de periodo */}
          <div className="btn-group" style={{ display: "flex", gap: "0.25rem" }}>
            {PERIODS.map((p) => (
              <button
                key={p.value}
                className={`btn btn-sm ${period === p.value ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? "Atualizando…" : "Atualizar"}
          </button>

          <button
            className="btn btn-ghost btn-sm"
            title="Grava o snapshot do dia para registrar o histórico"
            onClick={() => {
              fetch("/api/dashboards/snapshots/recalculate", { method: "POST" })
                .then(r => r.ok ? r.json() : Promise.reject())
                .then(() => load())
                .catch(() => {});
            }}
          >
            Recalcular snapshot
          </button>

          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {fmtDt(data.lastUpdatedAt)}
            {" "}&middot; {data._queryMs}ms
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

        {/* ── KPIs financeiros ───────────────────────────────────── */}
        <FinancialBlock financial={data.financial} />

        {/* ── Cards operacionais ─────────────────────────────────── */}
        {activeFilter && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Filtro ativo:</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveFilter(null)}>
              ✕ Limpar filtro
            </button>
          </div>
        )}
        <OperationalCards
          current={data.current}
          comparison={data.comparison}
          selected={activeFilter}
          onSelect={setActiveFilter}
          financial={data.financialByBucket}
          sparkData={sparkData}
        />

        {/* ── Grafico temporal ───────────────────────────────────── */}
        <OperationalTimeline activeFilter={activeFilter} period={period} />

        {/* ── Panorama + Tecnicos ────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <PanoramaBlock panorama={data.panorama} stock={data.stock} financial={data.financial} />
          <TechnicianBlock technicians={data.technicians} />
        </div>

        {/* ── Contagens + Alertas ────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <CountingBlock counting={data.counting} onRefresh={load} />
          <AlertsBlock alerts={data.alerts} />
        </div>

        {/* ── Central de Problemas ───────────────────────────────── */}
        <IssueReportsBlock issues={data.recentIssues} onRefresh={load} />

      </div>
    </div>
  );
}
