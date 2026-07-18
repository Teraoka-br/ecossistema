import type { Panorama, StockSummary } from "./types.js";

function fmt(n: number) { return n.toLocaleString("pt-BR"); }
function fmtDt(s: string | null) { return s ? s.slice(0, 16).replace("T", " ") : "—"; }

interface Row { label: string; value: string; accent?: boolean }

function PanoramaRow({ label, value, accent }: Row) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.35rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <span className="muted" style={{ fontSize: "0.82rem" }}>{label}</span>
      <span style={{ fontWeight: 600, color: accent ? "var(--ok-text)" : "var(--text)", fontSize: "0.9rem" }}>{value}</span>
    </div>
  );
}

interface Props {
  panorama: Panorama;
  stock: StockSummary;
}

export function PanoramaBlock({ panorama, stock }: Props) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Panorama da operacao</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1.5rem" }}>
        <div>
          <PanoramaRow label="Aparelhos ativos" value={fmt(panorama.activeCases)} />
          <PanoramaRow label="IMEIs unicos" value={fmt(panorama.uniqueImeis)} />
          <PanoramaRow label="Reparos possiveis agora" value={fmt(panorama.possibleRepairsNow)} accent={panorama.possibleRepairsNow > 0} />
          <PanoramaRow label="Pedidos pendentes" value={fmt(panorama.pendingPurchaseOrders)} />
        </div>
        <div>
          <PanoramaRow label="Unidades em estoque" value={fmt(panorama.stockUnits)} />
          <PanoramaRow label="Referencias em estoque" value={fmt(panorama.stockReferences)} />
          <PanoramaRow label="Unidades disponiveis" value={fmt(panorama.availableUnits)} accent={panorama.availableUnits > 0} />
          <PanoramaRow label="Unidades reservadas" value={fmt(panorama.reservedUnits)} />
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
      </div>
    </div>
  );
}
