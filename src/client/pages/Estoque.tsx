import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getEstoque, type EstoqueResponse } from "../api.js";
import { ErrorBanner, Loading, NoBatchBanner, fmtInt } from "../ui.js";
import { Boxes, Search, RefreshCw, TrendingUp, LayoutList, List } from "lucide-react";

export function Estoque() {
  const [search, setSearch] = useState("");
  const [data, setData] = useState<EstoqueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"groups" | "units">("groups");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await getEstoque(search));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isOfficial = data?.origin === "OFFICIAL" && data.official;
  const op = data?.operational;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Estoque de Peças</h1>
          <p className="page-subtitle">
            {isOfficial
              ? "Base oficial: última contagem física finalizada + movimentações posteriores."
              : "Origem: legado importado — nenhuma contagem finalizada ainda."}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Link to="/estoque/movimentacoes" className="btn btn-ghost btn-sm">
            Ver movimentações →
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading} title="Atualizar">
            <RefreshCw size={13} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {/* Origin badge + snapshot info */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <span className={`badge ${isOfficial ? "badge-ok" : "badge-neutral"}`} style={{ fontSize: "0.7rem" }}>
          {isOfficial ? "CONTAGEM OFICIAL" : "LEGADO IMPORTADO"}
        </span>
        {isOfficial && data?.official && (
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            snapshot #{data.official.snapshotId} · sessão #{data.official.sessionId} ·
            {data.official.createdAt} · {data.official.responsibleName}
          </span>
        )}
      </div>

      {/* KPI bar */}
      {op && (
        <div className="kpi-bar" style={{ marginBottom: "1.25rem" }}>
          <div className="kpi-card">
            <Boxes size={14} style={{ color: "var(--accent)" }} />
            <div>
              <div className="kpi-label">Estoque atual</div>
              <div className="kpi-value">{fmtInt(op.currentTotal)}</div>
              <div className="kpi-sub">unidades totais</div>
            </div>
          </div>
          <div className="kpi-card">
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>BASE</div>
            <div>
              <div className="kpi-label">{op.base.type === "OFFICIAL_SNAPSHOT" ? "Snapshot oficial" : "Importado"}</div>
              <div className="kpi-value">{fmtInt(op.baseTotal)}</div>
            </div>
          </div>
          <div className="kpi-card">
            <TrendingUp size={14} style={{ color: op.movementsTotal > 0 ? "var(--ok-text)" : "var(--text-muted)" }} />
            <div>
              <div className="kpi-label">Movimentações</div>
              <div className="kpi-value" style={{ color: op.movementsTotal > 0 ? "var(--ok-text)" : "var(--text-muted)" }}>
                {op.movementsTotal > 0 ? "+" : ""}{fmtInt(op.movementsTotal)}
              </div>
              <div className="kpi-sub">recebimentos pós-corte</div>
            </div>
          </div>
          <div className="kpi-card" style={{ flex: "0 0 auto" }}>
            <div>
              <div className="kpi-label">Refs no estoque</div>
              <div className="kpi-value">{op.groups.length}</div>
              <div className="kpi-sub">referências distintas</div>
            </div>
          </div>
        </div>
      )}

      {/* Search + view toggle */}
      <form className="search-bar" onSubmit={(e) => { e.preventDefault(); void load(); }} style={{ marginBottom: "1rem" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={13} style={{ position: "absolute", left: "0.65rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Referência, descrição, chave, fornecedor…"
            style={{ paddingLeft: "2rem", width: "100%" }}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-sm">Buscar</button>
        <div style={{ display: "flex", gap: "0.3rem", marginLeft: "auto" }}>
          <button type="button" className={`btn btn-sm ${view === "groups" ? "btn-secondary" : "btn-ghost"}`} onClick={() => setView("groups")} title="Por referência">
            <LayoutList size={13} /> Por referência
          </button>
          <button type="button" className={`btn btn-sm ${view === "units" ? "btn-secondary" : "btn-ghost"}`} onClick={() => setView("units")} title="Unidades legado">
            <List size={13} /> Unidades
          </button>
        </div>
      </form>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading what="estoque" />}
      {!loading && data && data.batchId === null && !isOfficial && <NoBatchBanner />}

      {/* Operational stock table */}
      {!loading && op && (
        <div className="card">
          <div style={{ marginBottom: "0.6rem", fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            Base ({op.base.type === "OFFICIAL_SNAPSHOT" ? "última contagem oficial" : "importação inicial"}) + movimentações posteriores = quantidade atual.
            Recebimentos confirmados já refletem aqui sem nova contagem.
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Referência</th>
                  <th>CHAVEPECA</th>
                  <th className="num">Base</th>
                  <th className="num">Entradas pós-corte</th>
                  <th className="num">Atual</th>
                  <th className="num" title="Reservado em separações ativas">Reservado</th>
                  <th className="num" title="Disponível = Atual − Reservado">Disponível</th>
                  <th>Mapeada</th>
                </tr>
              </thead>
              <tbody>
                {op.groups
                  .filter((g) => !search || g.referencia.toUpperCase().includes(search.toUpperCase()))
                  .map((g, i) => (
                    <tr key={i}>
                      <td className="mono">{g.referencia}</td>
                      <td className="small">
                        {g.mapeada ? g.chavePeca : <span className="badge badge-warn">SEM CHAVE</span>}
                      </td>
                      <td className="num">{fmtInt(g.baseQuantity)}</td>
                      <td className="num" style={{ color: g.movementQuantity > 0 ? "var(--ok-text)" : "var(--text-muted)" }}>
                        {g.movementQuantity > 0 ? "+" : ""}{fmtInt(g.movementQuantity)}
                      </td>
                      <td className="num"><strong>{fmtInt(g.currentQuantity)}</strong></td>
                      <td className="num" style={{ color: g.reservedQuantity > 0 ? "var(--warn-text)" : "var(--text-muted)" }}>
                        {g.reservedQuantity > 0 ? fmtInt(g.reservedQuantity) : "—"}
                      </td>
                      <td className="num">
                        <strong style={{ color: g.availableQuantity < g.currentQuantity ? "var(--accent)" : undefined }}>
                          {fmtInt(g.availableQuantity)}
                        </strong>
                      </td>
                      <td>
                        <span className={`badge ${g.mapeada ? "badge-ok" : "badge-err"}`}>
                          {g.mapeada ? "sim" : "não"}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Official snapshot section */}
      {!loading && data && isOfficial && data.official && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>
              Estoque oficial — {fmtInt(data.official.totalUnits)} unidades
            </h2>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Comparação com legado: {data.official.totalUnits - data.legacy.totalUnits > 0 ? "+" : ""}
              {fmtInt(data.official.totalUnits - data.legacy.totalUnits)} unidades
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Referência</th><th>CHAVEPECA</th><th className="num">Unidades</th><th>Mapeada</th>
                </tr>
              </thead>
              <tbody>
                {data.official.groups
                  .filter((g) => !search || g.referencia.toUpperCase().includes(search.toUpperCase()))
                  .map((g, i) => (
                    <tr key={i}>
                      <td className="mono">{g.referencia}</td>
                      <td className="small">
                        {g.mapeada ? g.chavePeca : <span className="badge badge-warn">SEM CHAVE</span>}
                      </td>
                      <td className="num"><strong>{fmtInt(g.unidades)}</strong></td>
                      <td><span className={`badge ${g.mapeada ? "badge-ok" : "badge-err"}`}>{g.mapeada ? "sim" : "não"}</span></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legacy groups */}
      {!loading && data && data.batchId !== null && view === "groups" && !isOfficial && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Referência</th><th>Descrição</th><th>CHAVEPECA</th>
                  <th>Fornecedor</th><th className="num">Unidades</th><th>Mapeada</th>
                </tr>
              </thead>
              <tbody>
                {data.legacy.groups.map((g, i) => (
                  <tr key={i}>
                    <td className="mono">{g.referencia ?? "—"}</td>
                    <td>{g.descricao ?? "—"}</td>
                    <td className="small">
                      {g.mapeada ? g.chavePeca : <span className="badge badge-warn">SEM CHAVE</span>}
                    </td>
                    <td>{g.fornecedor ?? "—"}</td>
                    <td className="num"><strong>{fmtInt(g.unidades)}</strong></td>
                    <td><span className={`badge ${g.mapeada ? "badge-ok" : "badge-err"}`}>{g.mapeada ? "sim" : "não"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legacy units */}
      {!loading && data && data.batchId !== null && view === "units" && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.6rem" }}>Unidades do legado importado</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Referência</th><th>Descrição</th>
                  <th>CHAVEPECA</th><th>Fornecedor</th><th>Status físico</th>
                </tr>
              </thead>
              <tbody>
                {data.legacy.items.map((it) => (
                  <tr key={it.id}>
                    <td className="num small">{it.id}</td>
                    <td className="mono">{it.referencia ?? "—"}</td>
                    <td>{it.descricao ?? "—"}</td>
                    <td className="small">{it.chavePeca ?? "—"}</td>
                    <td>{it.fornecedor ?? "—"}</td>
                    <td>{it.statusFisico ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
