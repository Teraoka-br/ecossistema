import { useEffect, useState } from "react";
import { Loading } from "../ui.js";

interface DashboardData {
  stock: {
    total: number;
    baseType: "OFFICIAL_SNAPSHOT" | "INITIAL_IMPORT";
    lastSnapshot: {
      id: number;
      total_units: number;
      created_at: string;
      created_by: string | null;
      responsible_name: string | null;
      count_type: string | null;
    } | null;
    topParts: { chave_peca: string; qty: number }[];
  };
  counting: {
    meta: {
      sessionId: number;
      responsibleName: string;
      countType: string;
      snapshotAt: string;
      totalCounted: number;
      totalLegacy: number;
      totalDelta: number;
    } | null;
    adjustments: {
      reference: string;
      chavePeca: string | null;
      countedQty: number;
      legacyQty: number;
      delta: number;
    }[];
  };
  matchStats: { status: string; c: number }[];
  repairStats: { workflow_status: string; c: number }[];
  recentMovements: {
    id: number;
    movement_type: string;
    chave_peca: string | null;
    referencia: string;
    quantity: number;
    source_type: string | null;
    created_at: string;
  }[];
  recentActivity: {
    id: number;
    username: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    createdAt: string;
  }[];
  purchaseStats: { status: string; c: number }[];
}

const STATUS_PT: Record<string, string> = {
  MATCH: "Match",
  MATCH_PARCIAL: "Match parcial",
  PEDIR_PECA: "Pedir peça",
  SEM_SALDO: "Sem saldo",
  VERIFICAR: "Verificar",
  INDICADA: "Indicada",
  RESERVADA: "Reservada",
  SEPARADA: "Separada",
  CONSUMIDA: "Consumida",
  AGUARDANDO_RECEBIMENTO: "Aguard. receb.",
  // repair workflow
  AGUARDANDO_PECA: "Aguard. peça",
  PECA_DISPONIVEL: "Peça disponível",
  DIRECIONADO_TECNICO: "Dir. técnico",
  EM_REPARO: "Em reparo",
  REPARO_EXECUTADO: "Reparo exec.",
  TRIAGEM_FINAL: "Triagem final",
  RETORNO_TECNICO: "Retorno técnico",
  APTO_REPARO: "Apto reparo",
  EM_SEPARACAO: "Em separação",
  // purchase
  DRAFT: "Rascunho",
  AWAITING: "Pendente",
  PARTIALLY_RECEIVED: "Rec. parcial",
  RECEIVED: "Recebido",
  CANCELLED: "Cancelado",
};

const STATUS_COLOR: Record<string, string> = {
  MATCH: "badge-ok",
  MATCH_PARCIAL: "badge-warn",
  PEDIR_PECA: "badge-info",
  SEM_SALDO: "badge-err",
  VERIFICAR: "badge-muted",
  SEPARADA: "badge-ok",
  INDICADA: "badge-warn",
  RESERVADA: "badge-info",
};

function fmt(n: number) { return n.toLocaleString("pt-BR"); }
function sign(n: number) { return n > 0 ? `+${fmt(n)}` : fmt(n); }

export function AdminDashboards() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/api/dashboards/overview");
      if (!r.ok) throw new Error(`Erro ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => { void load(); }, []);

  if (error) return (
    <div>
      <div className="page-header"><h1>Dashboards</h1></div>
      <div className="alert alert-err">{error}</div>
    </div>
  );
  if (!data) return <Loading what="dashboards" />;

  const { stock, counting, matchStats, repairStats, recentMovements, recentActivity, purchaseStats } = data;

  const matchTotal = matchStats.reduce((s, m) => s + m.c, 0);
  const matchCount = matchStats.find(m => m.status === "MATCH")?.c ?? 0;
  const matchParcial = matchStats.find(m => m.status === "MATCH_PARCIAL")?.c ?? 0;
  const pedirPeca = matchStats.find(m => m.status === "PEDIR_PECA")?.c ?? 0;
  const semSaldo = matchStats.find(m => m.status === "SEM_SALDO")?.c ?? 0;

  const pending = purchaseStats.filter(p => ["AWAITING", "PARTIALLY_RECEIVED"].includes(p.status)).reduce((s, p) => s + p.c, 0);

  return (
    <div>
      <div className="page-header">
        <h1>Dashboards</h1>
        <button className="btn btn-ghost btn-sm" onClick={load}>Atualizar</button>
      </div>

      {/* ── Linha 1: KPIs principais ──────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <KpiCard label="Unidades em estoque" value={fmt(stock.total)} accent="ok" />
        <KpiCard label="Peças distintas" value={fmt(stock.topParts.length > 0 ? stock.topParts.length : 0)} note="(top 10 listadas)" />
        <KpiCard label="Match / Match parcial" value={`${fmt(matchCount)} / ${fmt(matchParcial)}`} accent="ok" />
        <KpiCard label="Pedir peça" value={fmt(pedirPeca)} accent="warn" />
        <KpiCard label="Sem saldo" value={fmt(semSaldo)} accent="err" />
        <KpiCard label="Pedidos pendentes" value={fmt(pending)} accent={pending > 0 ? "warn" : undefined} />
      </div>

      {/* ── Linha 2: Estoque + Última contagem ───────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
        {/* Estoque */}
        <div className="card" style={{ margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.75rem" }}>
            <h2 style={{ margin: 0 }}>Estoque atual</h2>
            <span className={`badge ${stock.baseType === "OFFICIAL_SNAPSHOT" ? "badge-ok" : "badge-warn"}`}>
              {stock.baseType === "OFFICIAL_SNAPSHOT" ? "Snapshot oficial" : "Importação inicial"}
            </span>
          </div>
          {stock.lastSnapshot && (
            <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.75rem" }}>
              Snapshot #{stock.lastSnapshot.id} · {stock.lastSnapshot.total_units.toLocaleString("pt-BR")} unidades ·{" "}
              {stock.lastSnapshot.responsible_name ?? stock.lastSnapshot.created_by ?? "—"} · {stock.lastSnapshot.created_at.slice(0, 16)}
            </p>
          )}
          {!stock.lastSnapshot && (
            <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.75rem" }}>
              Nenhuma contagem oficial realizada ainda. A base é a importação legada (PEDIDOS.xlsx).
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Chave da peça</th><th className="num">Qtde</th></tr></thead>
              <tbody>
                {stock.topParts.map(p => (
                  <tr key={p.chave_peca}>
                    <td style={{ fontWeight: 500 }}>{p.chave_peca}</td>
                    <td className="num">{fmt(p.qty)}</td>
                  </tr>
                ))}
                {stock.topParts.length === 0 && <tr><td colSpan={2} className="muted">Sem dados.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Última contagem */}
        <div className="card" style={{ margin: 0 }}>
          <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Última contagem — ajustes</h2>
          {!counting.meta && (
            <p className="muted">Nenhuma contagem oficial realizada ainda.</p>
          )}
          {counting.meta && (
            <>
              <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.5rem" }}>
                {counting.meta.snapshotAt.slice(0, 16)} · {counting.meta.responsibleName} ·{" "}
                <span style={{ color: counting.meta.totalDelta >= 0 ? "var(--ok-text)" : "var(--err-text)" }}>
                  {sign(counting.meta.totalDelta)} unidades
                </span>
                {" "}vs legado ({fmt(counting.meta.totalLegacy)} → {fmt(counting.meta.totalCounted)})
              </p>
              {counting.adjustments.length === 0 && (
                <p className="muted" style={{ fontSize: "0.85rem" }}>Nenhuma diferença em relação ao legado.</p>
              )}
              {counting.adjustments.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 280 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Referência</th>
                        <th className="num">Contado</th>
                        <th className="num">Legado</th>
                        <th className="num">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counting.adjustments.map((a, i) => (
                        <tr key={i}>
                          <td style={{ fontWeight: 500 }}>{a.reference}</td>
                          <td className="num">{fmt(a.countedQty)}</td>
                          <td className="num">{fmt(a.legacyQty)}</td>
                          <td className="num" style={{ color: a.delta > 0 ? "var(--ok-text)" : "var(--err-text)", fontWeight: 600 }}>
                            {sign(a.delta)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Linha 3: Match + Reparos ──────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
        <div className="card" style={{ margin: 0 }}>
          <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Peças — status</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Status</th><th className="num">Qtde</th><th className="num">%</th></tr></thead>
              <tbody>
                {matchStats.map(m => (
                  <tr key={m.status}>
                    <td><span className={`badge ${STATUS_COLOR[m.status] ?? "badge-muted"}`}>{STATUS_PT[m.status] ?? m.status}</span></td>
                    <td className="num">{fmt(m.c)}</td>
                    <td className="num muted" style={{ fontSize: "0.82rem" }}>{matchTotal > 0 ? ((m.c / matchTotal) * 100).toFixed(1) + "%" : "—"}</td>
                  </tr>
                ))}
                {matchStats.length === 0 && <tr><td colSpan={3} className="muted">Sem dados.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Reparos em aberto</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Status</th><th className="num">Qtde</th></tr></thead>
              <tbody>
                {repairStats.map(r => (
                  <tr key={r.workflow_status}>
                    <td className="muted">{STATUS_PT[r.workflow_status] ?? r.workflow_status}</td>
                    <td className="num">{fmt(r.c)}</td>
                  </tr>
                ))}
                {repairStats.length === 0 && <tr><td colSpan={2} className="muted">Sem reparos em aberto.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Linha 4: Movimentações recentes + Atividade ───────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        <div className="card" style={{ margin: 0 }}>
          <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Movimentações de estoque recentes</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tipo</th><th>Chave</th><th className="num">Qtde</th><th>Quando</th></tr></thead>
              <tbody>
                {recentMovements.map(m => (
                  <tr key={m.id}>
                    <td style={{ fontSize: "0.8rem" }}>{m.movement_type}</td>
                    <td style={{ fontSize: "0.82rem", fontWeight: 500 }}>{m.chave_peca ?? m.referencia}</td>
                    <td className="num" style={{ color: m.quantity > 0 ? "var(--ok-text)" : "var(--err-text)" }}>
                      {sign(m.quantity)}
                    </td>
                    <td className="muted" style={{ fontSize: "0.8rem" }}>{m.created_at.slice(5, 16)}</td>
                  </tr>
                ))}
                {recentMovements.length === 0 && <tr><td colSpan={4} className="muted">Nenhuma movimentação.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Atividade recente</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Usuário</th><th>Ação</th><th>Quando</th></tr></thead>
              <tbody>
                {recentActivity.map(a => (
                  <tr key={a.id}>
                    <td style={{ fontSize: "0.82rem", fontWeight: 500 }}>{a.username ?? "—"}</td>
                    <td style={{ fontSize: "0.8rem" }}>{a.action}</td>
                    <td className="muted" style={{ fontSize: "0.8rem" }}>{a.createdAt.slice(5, 16)}</td>
                  </tr>
                ))}
                {recentActivity.length === 0 && <tr><td colSpan={3} className="muted">Nenhuma atividade.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: "ok" | "warn" | "err" }) {
  const color = accent === "ok" ? "var(--ok-text)" : accent === "warn" ? "var(--warn-text)" : accent === "err" ? "var(--err-text)" : "var(--text)";
  return (
    <div className="card" style={{ margin: 0, padding: "1rem" }}>
      <div className="muted" style={{ fontSize: "0.75rem", marginBottom: "0.3rem" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, color }}>{value}</div>
      {note && <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>{note}</div>}
    </div>
  );
}
