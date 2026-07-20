import type { CardCounts, CardMetric, FinancialByBucket, FinancialSlice } from "./types.js";
import { CARD_LABELS } from "./types.js";

function fmtBRL(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function fmt(n: number) {
  return n.toLocaleString("pt-BR");
}

function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const cls = delta > 0 ? "badge-ok" : "badge-err";
  const sign = delta > 0 ? "+" : "";
  return (
    <span className={`badge ${cls}`} style={{ fontSize: "0.7rem", marginLeft: "0.4rem" }}>
      {sign}{fmt(delta)}
    </span>
  );
}

function FinancialMini({ slice }: { slice: FinancialSlice | undefined }) {
  if (!slice || (slice.totalSale === null && slice.totalMargin === null)) return null;
  const marginColor = (slice.totalMargin ?? 0) >= 0 ? "var(--ok-text)" : "var(--err-text)";
  return (
    <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.1rem" }}>
      {slice.totalSale !== null && (
        <div style={{ fontSize: "0.68rem", color: "var(--text-2)" }}>
          Venda <span style={{ fontWeight: 600 }}>{fmtBRL(slice.totalSale)}</span>
        </div>
      )}
      {slice.totalMargin !== null && (
        <div style={{ fontSize: "0.68rem", color: marginColor, fontWeight: 600 }}>
          Margem {fmtBRL(slice.totalMargin)}
        </div>
      )}
    </div>
  );
}

const BUCKET_KEY: Partial<Record<CardMetric, keyof FinancialByBucket>> = {
  match:          "match",
  matchParcial:   "matchParcial",
  aptoReparo:     "aptoReparo",
  verificar:      "verificar",
  emAnalise:      "emAnalise",
  aguardandoPeca: "aguardandoPeca",
  comTecnico:     "comTecnico",
  finalizados:    "finalizados",
};

interface CardProps {
  metric: CardMetric;
  value: number;
  delta?: number;
  selected: boolean;
  onClick: () => void;
  financial?: FinancialByBucket;
}

function OperationalCard({ metric, value, delta, selected, onClick, financial }: CardProps) {
  const accent = getAccent(metric);
  const color = accent === "ok"
    ? "var(--ok-text)"
    : accent === "warn"
    ? "var(--warn-text)"
    : accent === "err"
    ? "var(--err-text)"
    : "var(--accent)";

  const bucketKey = BUCKET_KEY[metric];
  const slice = bucketKey && financial ? financial[bucketKey] : undefined;

  return (
    <button
      className={`card${selected ? " card-selected" : ""}`}
      style={{
        margin: 0,
        padding: "0.85rem 1rem",
        cursor: "pointer",
        textAlign: "left",
        border: selected ? "1px solid var(--accent)" : undefined,
        background: selected ? "rgba(139,92,246,0.08)" : undefined,
      }}
      onClick={onClick}
    >
      <div className="muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {CARD_LABELS[metric]}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.2rem" }}>
        <span style={{ fontSize: "1.6rem", fontWeight: 700, color }}>{fmt(value)}</span>
        {delta !== undefined && <DeltaBadge delta={delta} />}
      </div>
      <FinancialMini slice={slice} />
    </button>
  );
}

function getAccent(metric: CardMetric): "ok" | "warn" | "err" | "accent" | undefined {
  switch (metric) {
    case "match": return "ok";
    case "aptoReparo": return "ok";
    case "verificar": return "warn";
    case "aguardandoPeca": return "warn";
    case "total": return "accent";
    default: return undefined;
  }
}

interface OperationalCardsProps {
  current: CardCounts;
  comparison: Partial<CardCounts> | null;
  selected: CardMetric;
  onSelect: (m: CardMetric) => void;
  financial?: FinancialByBucket;
}

export function OperationalCards({ current, comparison, selected, onSelect, financial }: OperationalCardsProps) {
  const metrics: CardMetric[] = [
    "match", "aptoReparo", "verificar", "emAnalise",
    "aguardandoPeca", "matchParcial", "comTecnico", "finalizados", "total",
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.6rem" }}>
      {metrics.map((m) => (
        <OperationalCard
          key={m}
          metric={m}
          value={current[m]}
          delta={comparison?.[m]}
          selected={selected === m}
          onClick={() => onSelect(m)}
          financial={financial}
        />
      ))}
    </div>
  );
}
