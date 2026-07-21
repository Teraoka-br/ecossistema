import { useEffect, useState } from "react";
import type { CardMetric } from "./types.js";
import { CARD_LABELS } from "./types.js";

interface MultiRow {
  snapshot_date: string;
  match_count: number;
  match_partial_count: number;
  apto_reparo_count: number;
  verificar_count: number;
  em_analise_count: number;
  aguardando_peca_count: number;
  com_tecnico_count: number;
  venda_estado_count: number;
  finalizados_count: number;
  total_cases: number;
}

interface SinglePoint {
  snapshot_date: string;
  value: number;
}

type Props = {
  /** null = sem filtro → gráfico multi-linha */
  activeFilter: CardMetric | null;
  period: number; // dias
};

function fmt(n: number) { return n.toLocaleString("pt-BR"); }
function fmtDate(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

const METRIC_MAP: Record<CardMetric, keyof MultiRow> = {
  match:          "match_count",
  matchParcial:   "match_partial_count",
  aptoReparo:     "apto_reparo_count",
  verificar:      "verificar_count",
  emAnalise:      "em_analise_count",
  aguardandoPeca: "aguardando_peca_count",
  comTecnico:     "com_tecnico_count",
  vendaEstado:    "venda_estado_count",
  finalizados:    "finalizados_count",
  total:          "total_cases",
};

// Séries exibidas no modo multi-linha (exclui "total" para não dominar a escala)
const MULTI_SERIES: { metric: CardMetric; color: string }[] = [
  { metric: "match",          color: "var(--ok-text)" },
  { metric: "comTecnico",     color: "#34d399" },
  { metric: "verificar",      color: "var(--warn-text)" },
  { metric: "emAnalise",      color: "#60a5fa" },
  { metric: "aguardandoPeca", color: "#f59e0b" },
  { metric: "matchParcial",   color: "#a78bfa" },
  { metric: "vendaEstado",    color: "#f87171" },
  { metric: "finalizados",    color: "var(--text-2)" },
];

const SINGLE_COLOR: Partial<Record<CardMetric, string>> = {
  match:          "var(--ok-text)",
  matchParcial:   "#a78bfa",
  aptoReparo:     "var(--ok-text)",
  verificar:      "var(--warn-text)",
  emAnalise:      "#60a5fa",
  aguardandoPeca: "#f59e0b",
  comTecnico:     "#34d399",
  vendaEstado:    "#f87171",
  finalizados:    "var(--text-2)",
  total:          "var(--accent)",
};

// ─── SVG helpers ─────────────────────────────────────────────────────────────
const W = 620, H = 160;
const PAD = { top: 14, right: 14, bottom: 30, left: 46 };
const innerW = W - PAD.left - PAD.right;
const innerH = H - PAD.top - PAD.bottom;

function scaleX(i: number, n: number) { return PAD.left + (i / Math.max(n - 1, 1)) * innerW; }
function scaleY(v: number, min: number, range: number) { return PAD.top + (1 - (v - min) / (range || 1)) * innerH; }

// ─── Gráfico single ───────────────────────────────────────────────────────────
function SingleChart({ data, color, label }: { data: SinglePoint[]; color: string; label: string }) {
  const [tooltip, setTooltip] = useState<{ xi: number; yi: number; point: SinglePoint } | null>(null);

  const values = data.map(d => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV;

  const px = (i: number) => scaleX(i, data.length);
  const py = (v: number) => scaleY(v, minV, range);

  const points = data.map((d, i) => `${px(i)},${py(d.value)}`).join(" ");
  const fill   = `${px(0)},${PAD.top + innerH} ${points} ${px(data.length - 1)},${PAD.top + innerH}`;

  const yLabels = [minV, Math.round(minV + range / 2), maxV];
  const step = Math.max(1, Math.floor(data.length / 7));
  const xIdx = data.map((_, i) => i).filter(i => i % step === 0 || i === data.length - 1);

  return (
    <div>
      <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.4rem" }}>
        Evolucao: <strong style={{ color }}>{label}</strong>
      </div>
      <div style={{ position: "relative" }} onMouseLeave={() => setTooltip(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const mx = ((e.clientX - rect.left) / rect.width) * W - PAD.left;
            const idx = Math.max(0, Math.min(data.length - 1, Math.round((mx / innerW) * (data.length - 1))));
            const point = data[idx];
            if (point) setTooltip({ xi: Math.round((e.clientX - rect.left) / rect.width * 100), yi: Math.round((e.clientY - rect.top) / rect.height * 100), point });
          }}
        >
          {yLabels.map((v, i) => (
            <g key={i}>
              <line x1={PAD.left} y1={py(v)} x2={W - PAD.right} y2={py(v)} stroke="var(--border)" strokeWidth={0.5} strokeDasharray="3,3" />
              <text x={PAD.left - 4} y={py(v) + 4} textAnchor="end" fill="var(--muted)" fontSize={9}>{fmt(v)}</text>
            </g>
          ))}
          <polygon points={fill} fill={`color-mix(in srgb, ${color} 15%, transparent)`} />
          <polyline points={points} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
          {data.map((d, i) => (
            <circle key={i} cx={px(i)} cy={py(d.value)} r={2.5} fill={color} />
          ))}
          {xIdx.map(i => (
            <text key={i} x={px(i)} y={H - 6} textAnchor="middle" fill="var(--muted)" fontSize={9}>{fmtDate(data[i].snapshot_date)}</text>
          ))}
        </svg>
        {tooltip && (
          <div style={{
            position: "absolute", left: `${tooltip.xi}%`, top: `${tooltip.yi}%`, transform: "translate(8px,-100%)",
            background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
            padding: "0.3rem 0.6rem", fontSize: "0.78rem", pointerEvents: "none", zIndex: 10, whiteSpace: "nowrap",
          }}>
            <strong>{fmtDate(tooltip.point.snapshot_date)}</strong>: {fmt(tooltip.point.value)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Gráfico multi-linha ─────────────────────────────────────────────────────
function MultiChart({ data }: { data: MultiRow[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ xi: number; yi: number; idx: number } | null>(null);

  const allValues = MULTI_SERIES.flatMap(s => data.map(r => r[METRIC_MAP[s.metric]] as number));
  const minV = Math.min(0, ...allValues);
  const maxV = Math.max(...allValues, 1);
  const range = maxV - minV;

  const px = (i: number) => scaleX(i, data.length);
  const py = (v: number) => scaleY(v, minV, range);

  const yLabels = [minV, Math.round(minV + range / 2), maxV];
  const step = Math.max(1, Math.floor(data.length / 7));
  const xIdx = data.map((_, i) => i).filter(i => i % step === 0 || i === data.length - 1);

  return (
    <div>
      {/* Legenda */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1rem", marginBottom: "0.5rem" }}>
        {MULTI_SERIES.map(s => (
          <button
            key={s.metric}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
              display: "flex", alignItems: "center", gap: "0.3rem",
              opacity: hovered && hovered !== s.metric ? 0.35 : 1, transition: "opacity 0.15s" }}
            onMouseEnter={() => setHovered(s.metric)}
            onMouseLeave={() => setHovered(null)}
          >
            <span style={{ width: 12, height: 3, borderRadius: 2, background: s.color, display: "inline-block" }} />
            <span style={{ fontSize: "0.7rem", color: "var(--text-2)" }}>{CARD_LABELS[s.metric]}</span>
          </button>
        ))}
      </div>
      <div style={{ position: "relative" }} onMouseLeave={() => setTooltip(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const mx = ((e.clientX - rect.left) / rect.width) * W - PAD.left;
            const idx = Math.max(0, Math.min(data.length - 1, Math.round((mx / innerW) * (data.length - 1))));
            setTooltip({ xi: Math.round((e.clientX - rect.left) / rect.width * 100), yi: Math.round((e.clientY - rect.top) / rect.height * 100), idx });
          }}
        >
          {yLabels.map((v, i) => (
            <g key={i}>
              <line x1={PAD.left} y1={py(v)} x2={W - PAD.right} y2={py(v)} stroke="var(--border)" strokeWidth={0.5} strokeDasharray="3,3" />
              <text x={PAD.left - 4} y={py(v) + 4} textAnchor="end" fill="var(--muted)" fontSize={9}>{fmt(v)}</text>
            </g>
          ))}
          {MULTI_SERIES.map(s => {
            const key = METRIC_MAP[s.metric] as keyof MultiRow;
            const pts = data.map((r, i) => `${px(i)},${py(r[key] as number)}`).join(" ");
            const dim = hovered && hovered !== s.metric;
            return (
              <polyline key={s.metric} points={pts} fill="none"
                stroke={s.color} strokeWidth={dim ? 0.8 : 1.6}
                strokeLinejoin="round" opacity={dim ? 0.25 : 1}
                style={{ transition: "opacity 0.15s, stroke-width 0.15s" }}
              />
            );
          })}
          {xIdx.map(i => (
            <text key={i} x={px(i)} y={H - 6} textAnchor="middle" fill="var(--muted)" fontSize={9}>{fmtDate(data[i].snapshot_date)}</text>
          ))}
          {/* Linha vertical de hover */}
          {tooltip && (
            <line x1={px(tooltip.idx)} y1={PAD.top} x2={px(tooltip.idx)} y2={PAD.top + innerH}
              stroke="var(--text-2)" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.5} />
          )}
        </svg>
        {tooltip && data[tooltip.idx] && (
          <div style={{
            position: "absolute", left: `${Math.min(tooltip.xi, 70)}%`, top: `${tooltip.yi}%`, transform: "translate(8px,-100%)",
            background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
            padding: "0.4rem 0.7rem", fontSize: "0.75rem", pointerEvents: "none", zIndex: 10,
          }}>
            <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{fmtDate(data[tooltip.idx].snapshot_date)}</div>
            {MULTI_SERIES.map(s => {
              const v = data[tooltip.idx][METRIC_MAP[s.metric]] as number;
              return (
                <div key={s.metric} style={{ display: "flex", gap: "0.5rem", alignItems: "center", color: "var(--text-2)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
                  <span>{CARD_LABELS[s.metric]}</span>
                  <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--text-1)" }}>{fmt(v)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Componente principal ────────────────────────────────────────────────────
export function OperationalTimeline({ activeFilter, period }: Props) {
  const [multiData, setMultiData] = useState<MultiRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const from = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);

    fetch(`/api/dashboards/timeline/multi?from=${from}`)
      .then(r => r.ok ? r.json() as Promise<{ data: MultiRow[] }> : Promise.reject(new Error(`Erro ${r.status}`)))
      .then(j => { setMultiData(j.data); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, [period]);

  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.6rem" }}>
        <h2 style={{ margin: 0 }}>Historico operacional</h2>
        {activeFilter && (
          <span className="badge badge-muted" style={{ fontSize: "0.73rem" }}>
            {CARD_LABELS[activeFilter]}
          </span>
        )}
      </div>

      {loading && <p className="spinner">Carregando grafico…</p>}
      {error && <div className="alert alert-err">{error}</div>}

      {!loading && !error && multiData.length === 0 && (
        <p className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
          Ainda nao ha historico. Os dados aparecerao com os snapshots diarios.
        </p>
      )}

      {!loading && !error && multiData.length > 0 && (() => {
        if (activeFilter && activeFilter !== "total") {
          const col = METRIC_MAP[activeFilter];
          const color = SINGLE_COLOR[activeFilter] ?? "var(--accent)";
          const single: SinglePoint[] = multiData.map(r => ({ snapshot_date: r.snapshot_date, value: r[col] as number }));
          return <SingleChart data={single} color={color} label={CARD_LABELS[activeFilter]} />;
        }
        return <MultiChart data={multiData} />;
      })()}
    </div>
  );
}
