import { useNavigate } from "react-router-dom";
import type { Panorama, StockSummary, FinancialData } from "./types.js";

function fmt(n: number) { return n.toLocaleString("pt-BR"); }
function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function fmtDt(s: string | null) { return s ? s.slice(0, 16).replace("T", " ") : "—"; }

interface Row {
  label: string;
  value: string;
  accent?: boolean;
  route?: string;
}

function PanoramaRow({ label, value, accent, route, navigate }: Row & { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "0.35rem 0", borderBottom: "1px solid var(--border-subtle)",
        cursor: route ? "pointer" : undefined,
      }}
      onClick={() => route && navigate(route)}
    >
      <span className="muted" style={{ fontSize: "0.82rem" }}>{label}</span>
      <span style={{ fontWeight: 600, color: accent ? "var(--ok-text)" : "var(--text)", fontSize: "0.9rem" }}>{value}</span>
    </div>
  );
}

interface Props {
  panorama: Panorama;
  stock: StockSummary;
  financial?: FinancialData;
}

export function PanoramaBlock({ panorama, stock, financial }: Props) {
  const navigate = useNavigate();

  return (
    <div className="card" style={{ margin: 0 }}>
      <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Panorama da operacao</h2>

      {/* Financeiro resumido */}
      {financial && (
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem",
          marginBottom: "0.85rem", padding: "0.6rem 0.75rem",
          background: "var(--surface-alt)", borderRadius: "var(--radius)",
        }}>
          {[
            { label: "Custo em circulação", value: fmtMoney(financial.active.totalCost), color: "var(--text)" },
            { label: "Venda est. ativa", value: fmtMoney(financial.active.totalSale), color: "var(--info-text)" },
            { label: "Margem est. ativa", value: fmtMoney(financial.active.totalMargin),
              color: (financial.active.totalMargin ?? 0) >= 0 ? "var(--ok-text)" : "var(--err-text)" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.2rem" }}>{label}</div>
              <div style={{ fontWeight: 700, fontSize: "0.9rem", color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1.5rem" }}>
        <div>
          <PanoramaRow label="Aparelhos ativos" value={fmt(panorama.activeCases)} navigate={navigate} route="/fila-reparos" />
          <PanoramaRow label="IMEIs unicos" value={fmt(panorama.uniqueImeis)} navigate={navigate} />
          <PanoramaRow label="Reparos possiveis agora" value={fmt(panorama.possibleRepairsNow)} accent={panorama.possibleRepairsNow > 0} route="/fila-reparos" navigate={navigate} />
          <PanoramaRow label="Pedidos pendentes" value={fmt(panorama.pendingPurchaseOrders)} route="/compras" navigate={navigate} />
        </div>
        <div>
          <PanoramaRow label="Unidades em estoque" value={fmt(panorama.stockUnits)} route="/estoque" navigate={navigate} />
          <PanoramaRow label="Referencias em estoque" value={fmt(panorama.stockReferences)} navigate={navigate} />
          <PanoramaRow label="Unidades disponiveis" value={fmt(panorama.availableUnits)} accent={panorama.availableUnits > 0} navigate={navigate} />
          <PanoramaRow label="Unidades reservadas" value={fmt(panorama.reservedUnits)} navigate={navigate} />
        </div>
      </div>
      <div style={{ marginTop: "0.75rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border-subtle)", fontSize: "0.78rem" }} className="muted">
        Base do estoque:{" "}
        <span className={`badge ${stock.baseType === "OFFICIAL_SNAPSHOT" ? "badge-ok" : "badge-warn"}`} style={{ fontSize: "0.72rem" }}>
          {stock.baseType === "OFFICIAL_SNAPSHOT" ? "Snapshot oficial" : "Importacao inicial"}
        </span>
        {stock.lastSnapshotAt && (
          <> &middot; {fmtDt(stock.lastSnapshotAt)} &middot; {stock.lastSnapshotBy ?? "—"}</>
        )}
        {panorama.lastOfficialCount && (
          <> &middot; Ultima contagem: {fmtDt(panorama.lastOfficialCount)}</>
        )}
      </div>
    </div>
  );
}
