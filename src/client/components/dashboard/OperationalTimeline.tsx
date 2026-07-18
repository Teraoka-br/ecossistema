import { useEffect, useState } from "react";
import type { CardMetric } from "./types.js";
import { CARD_LABELS } from "./types.js";

interface TimelinePoint {
  snapshot_date: string;
  value: number;
}

interface Props {
  metric: CardMetric;
  period: number; // dias
}

function fmt(n: number) { return n.toLocaleString("pt-BR"); }

function fmtDate(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

const METRIC_MAP: Record<CardMetric, string> = {
  match: "match_count",
  matchParcial: "match_partial_count",
  aptoReparo: "apto_reparo_count",
  verificar: "verificar_count",
  emAnalise: "em_analise_count",
  aguardandoPeca: "aguardando_peca_count",
  comTecnico: "com_tecnico_count",
  finalizados: "finalizados_count",
  total: "total_cases",
};

export function OperationalTimeline({ metric, period }: Props) {
  const [data, setData] = useState<TimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; point: TimelinePoint } | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const from = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);
    const apiMetric = METRIC_MAP[metric];
    fetch(`/api/dashboards/timeline?metric=${apiMetric}&from=${from}`)
      .then((r) => r.ok ? r.json() as Promise<{ data: TimelinePoint[] }> : Promise.reject(new Error(`Erro ${r.status}`)))
      .then((j) => { setData(j.data); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, [metric, period]);

  if (loading) return (
    <div className="card" style={{ margin: 0 }}>
      <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Historico operacional</h2>
      <p className="spinner">Carregando grafico…</p>
    </div>
  );

  if (error) return (
    <div className="card" style={{ margin: 0 }}>
      <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Historico operacional</h2>
      <div className="alert alert-err">{error}</div>
    </div>
  );

  if (data.length === 0) return (
    <div className="card" style={{ margin: 0 }}>
      <h2 style={{ margin: 0, marginBottom: "0.5rem" }}>Historico operacional</h2>
      <p className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
        Ainda nao ha historico suficiente para este periodo.<br />
        Os dados comecarao a aparecer com os snapshots diarios.
      </p>
    </div>
  );

  // Desenhar SVG simples
  const W = 600, H = 140, PAD = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const values = data.map((d) => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const px = (i: number) => PAD.left + (i / Math.max(data.length - 1, 1)) * innerW;
  const py = (v: number) => PAD.top + (1 - (v - minV) / range) * innerH;

  const points = data.map((d, i) => `${px(i)},${py(d.value)}`).join(" ");
  const fillPoints = `${px(0)},${PAD.top + innerH} ${points} ${px(data.length - 1)},${PAD.top + innerH}`;

  // Eixo Y: 3 labels
  const yLabels = [minV, Math.round(minV + range / 2), maxV];

  // Eixo X: amostrar até 6 datas
  const step = Math.max(1, Math.floor(data.length / 6));
  const xLabels = data.filter((_, i) => i % step === 0 || i === data.length - 1);

  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Historico operacional</h2>
        <span className="badge badge-muted" style={{ fontSize: "0.75rem" }}>{CARD_LABELS[metric]}</span>
      </div>
      <div style={{ position: "relative" }} onMouseLeave={() => setTooltip(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const scaleX = W / rect.width;
            const mx = (e.clientX - rect.left) * scaleX - PAD.left;
            const idx = Math.round((mx / innerW) * (data.length - 1));
            const clamped = Math.max(0, Math.min(data.length - 1, idx));
            const point = data[clamped];
            if (point) setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, point });
          }}
        >
          {/* Grid lines */}
          {yLabels.map((v, i) => (
            <g key={i}>
              <line
                x1={PAD.left} y1={py(v)} x2={W - PAD.right} y2={py(v)}
                stroke="var(--border)" strokeWidth={0.5} strokeDasharray="4,4"
              />
              <text x={PAD.left - 4} y={py(v) + 4} textAnchor="end" fill="var(--muted)" fontSize={9}>
                {fmt(v)}
              </text>
            </g>
          ))}

          {/* Area fill */}
          <polygon points={fillPoints} fill="rgba(139,92,246,0.12)" />

          {/* Line */}
          <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />

          {/* Dots */}
          {data.map((d, i) => (
            <circle key={i} cx={px(i)} cy={py(d.value)} r={2.5} fill="var(--accent)" />
          ))}

          {/* X axis labels */}
          {xLabels.map((d) => {
            const i = data.indexOf(d);
            return (
              <text key={d.snapshot_date} x={px(i)} y={H - 4} textAnchor="middle" fill="var(--muted)" fontSize={9}>
                {fmtDate(d.snapshot_date)}
              </text>
            );
          })}
        </svg>

        {tooltip && (
          <div
            style={{
              position: "absolute",
              left: tooltip.x + 12,
              top: Math.max(0, tooltip.y - 20),
              background: "var(--card-bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-sm)",
              padding: "0.35rem 0.65rem",
              fontSize: "0.8rem",
              pointerEvents: "none",
              zIndex: 10,
              whiteSpace: "nowrap",
            }}
          >
            <strong>{fmtDate(tooltip.point.snapshot_date)}</strong>: {fmt(tooltip.point.value)}
          </div>
        )}
      </div>
    </div>
  );
}
