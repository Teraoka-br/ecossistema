import type { CardCounts, CardMetric, FinancialByBucket, FinancialSlice } from "./types.js";
import { CARD_LABELS } from "./types.js";

export interface SparkRow {
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

const SPARK_COL: Partial<Record<CardMetric, keyof SparkRow>> = {
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

function Sparkline({ data, col, color }: { data: SparkRow[]; col: keyof SparkRow; color: string }) {
  if (data.length < 2) return null;
  const W = 80, H = 28;
  const vals = data.map(r => r[col] as number);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const px = (i: number) => (i / (vals.length - 1)) * W;
  const py = (v: number) => H - 2 - ((v - min) / range) * (H - 4);
  const pts = vals.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  const fill = `0,${H} ${pts} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: W, height: H, display: "block", overflow: "visible" }}>
      <polygon points={fill} fill={`color-mix(in srgb, ${color} 18%, transparent)`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

function fmtBRL(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function fmt(n: number) { return n.toLocaleString("pt-BR"); }

/**
 * Semântica do delta por card:
 * "good"    — crescer é positivo (match, comTecnico, finalizados, aptoReparo)
 * "bad"     — crescer é preocupante (verificar, aguardandoPeca, emAnalise, vendaEstado)
 * "neutral" — sem julgamento (matchParcial, total)
 */
const DELTA_MEANING: Partial<Record<CardMetric, "good" | "bad" | "neutral">> = {
  match:          "good",
  comTecnico:     "good",
  finalizados:    "good",
  aptoReparo:     "good",
  verificar:      "bad",
  aguardandoPeca: "bad",
  emAnalise:      "bad",
  vendaEstado:    "bad",
  matchParcial:   "neutral",
  total:          "neutral",
};

function DeltaBadge({ delta, metric }: { delta: number; metric: CardMetric }) {
  if (delta === 0) return null;
  const meaning = DELTA_MEANING[metric] ?? "neutral";
  let cls = "badge-muted";
  if (meaning === "good")  cls = delta > 0 ? "badge-ok"  : "badge-err";
  if (meaning === "bad")   cls = delta > 0 ? "badge-err" : "badge-ok";
  return (
    <span className={`badge ${cls}`} style={{ fontSize: "0.68rem", marginLeft: "0.3rem" }}>
      {delta > 0 ? "+" : ""}{fmt(delta)} vs ontem
    </span>
  );
}

function FinancialMini({ slice }: { slice: FinancialSlice | undefined }) {
  if (!slice || (slice.totalSale === null && slice.totalMargin === null)) return null;
  const marginColor = (slice.totalMargin ?? 0) >= 0 ? "var(--ok-text)" : "var(--err-text)";
  return (
    <div style={{ marginTop: "0.3rem" }}>
      {slice.totalSale !== null && (
        <div style={{ fontSize: "0.66rem", color: "var(--text-2)" }}>
          {fmtBRL(slice.totalSale)}
        </div>
      )}
      {slice.totalMargin !== null && (
        <div style={{ fontSize: "0.66rem", color: marginColor, fontWeight: 600 }}>
          {fmtBRL(slice.totalMargin)}
        </div>
      )}
    </div>
  );
}

// Mapeamento CardMetric → coluna financeira
const BUCKET_KEY: Partial<Record<CardMetric, keyof FinancialByBucket>> = {
  match:          "match",
  matchParcial:   "matchParcial",
  aptoReparo:     "aptoReparo",
  verificar:      "verificar",
  emAnalise:      "emAnalise",
  aguardandoPeca: "aguardandoPeca",
  comTecnico:     "comTecnico",
  vendaEstado:    "vendaEstado",
  finalizados:    "finalizados",
};

// Cores consistentes com FilaReparos
const CARD_ACCENT: Partial<Record<CardMetric, string>> = {
  match:          "var(--ok-text)",
  matchParcial:   "#a78bfa",
  aptoReparo:     "var(--ok-text)",
  verificar:      "var(--warn-text)",
  emAnalise:      "#60a5fa",
  aguardandoPeca: "var(--warn-text)",
  comTecnico:     "#34d399",
  vendaEstado:    "#f87171",
  finalizados:    "var(--text-2)",
  total:          "var(--accent)",
};

interface CardProps {
  metric: CardMetric;
  value: number;
  delta?: number;
  selected: boolean;
  onClick: () => void;
  financial?: FinancialByBucket;
  sparkData?: SparkRow[];
}

function OperationalCard({ metric, value, delta, selected, onClick, financial, sparkData }: CardProps) {
  const color = CARD_ACCENT[metric] ?? "var(--text-1)";
  const bucketKey = BUCKET_KEY[metric];
  const slice = bucketKey && financial ? financial[bucketKey] : undefined;
  const sparkCol = SPARK_COL[metric];

  return (
    <button
      className="card"
      style={{
        margin: 0,
        padding: "0.85rem 1rem",
        cursor: "pointer",
        textAlign: "left",
        border: selected ? `1px solid ${color}` : "1px solid var(--border)",
        background: selected ? `color-mix(in srgb, ${color} 10%, var(--surface))` : undefined,
        transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
        boxShadow: selected ? `0 0 0 1px ${color}22, 0 4px 20px rgba(0,0,0,0.5)` : undefined,
      }}
      onClick={onClick}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="muted" style={{ fontSize: "0.67rem", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {CARD_LABELS[metric]}
          </div>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <span style={{ fontSize: "1.65rem", fontWeight: 800, color, letterSpacing: "-0.03em", lineHeight: 1 }}>{fmt(value)}</span>
          </div>
          {delta !== undefined && (
            <div style={{ marginTop: "0.2rem" }}><DeltaBadge delta={delta} metric={metric} /></div>
          )}
          <FinancialMini slice={slice} />
        </div>
        {sparkData && sparkData.length >= 2 && sparkCol && (
          <div style={{ opacity: 0.8, flexShrink: 0, alignSelf: "center" }}>
            <Sparkline data={sparkData} col={sparkCol} color={color} />
          </div>
        )}
      </div>
    </button>
  );
}

interface OperationalCardsProps {
  current: CardCounts;
  comparison: Partial<CardCounts> | null;
  /** null = sem filtro ativo (equivale a "Todos") */
  selected: CardMetric | null;
  onSelect: (m: CardMetric | null) => void;
  financial?: FinancialByBucket;
  sparkData?: SparkRow[];
}

// Ordem dos cards: igual à FilaReparos
const METRICS: CardMetric[] = [
  "match", "comTecnico", "verificar", "emAnalise",
  "aguardandoPeca", "matchParcial", "vendaEstado", "finalizados", "total",
];

export function OperationalCards({ current, comparison, selected, onSelect, financial, sparkData }: OperationalCardsProps) {
  function handleClick(m: CardMetric) {
    if (m === "total") {
      onSelect(null); // "Todos" desmarca o filtro
    } else {
      onSelect(selected === m ? null : m); // toggle
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: "0.55rem" }}>
      {METRICS.map((m) => (
        <OperationalCard
          key={m}
          metric={m}
          value={current[m]}
          delta={comparison?.[m]}
          selected={m === "total" ? selected === null : selected === m}
          onClick={() => handleClick(m)}
          financial={financial}
          sparkData={sparkData}
        />
      ))}
    </div>
  );
}
