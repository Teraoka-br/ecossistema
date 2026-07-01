import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getEstoque, type EstoqueResponse } from "../api.js";
import { ErrorBanner, Loading, NoBatchBanner, fmtInt } from "../ui.js";

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

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isOfficial = data?.origin === "OFFICIAL" && data.official;

  return (
    <div>
      <h1>Estoque de peças</h1>
      <p className="subtitle">
        {isOfficial
          ? "Visão oficial: consolidado da última contagem física finalizada."
          : "Somente leitura — origem ainda é o legado importado (nenhuma contagem finalizada)."}
      </p>

      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <span className={`badge ${isOfficial ? "ok" : "neutral"}`} style={{ fontSize: "0.78rem" }}>
            Origem: {isOfficial ? "CONTAGEM OFICIAL" : "LEGADO IMPORTADO"}
          </span>
          {isOfficial && data?.official && (
            <span className="muted small">
              snapshot #{data.official.snapshotId} · sessão #{data.official.sessionId} · {data.official.createdAt} ·
              responsável {data.official.responsibleName}
            </span>
          )}
        </div>
        <form
          className="row"
          style={{ marginTop: "0.6rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <div className="field">
            <label>Buscar (referência, descrição, chave, fornecedor)</label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ex.: PC-QA23947 ou BATERIA IPHONE 13"
            />
          </div>
          <button type="submit">Buscar</button>
          <div className="row right" style={{ gap: "0.4rem" }}>
            <button type="button" className={view === "groups" ? "" : "secondary"} onClick={() => setView("groups")}>
              Por referência
            </button>
            <button type="button" className={view === "units" ? "" : "secondary"} onClick={() => setView("units")}>
              Unidades (legado)
            </button>
          </div>
        </form>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading what="estoque" />}
      {!loading && data && data.batchId === null && !isOfficial && <NoBatchBanner />}

      {!loading && data && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Estoque operacional atual</h2>
            <Link to="/estoque/movimentacoes">Ver movimentações →</Link>
          </div>
          <p className="hint">
            Base ({data.operational.base.type === "OFFICIAL_SNAPSHOT" ? "última contagem oficial" : "importação inicial"})
            + movimentações posteriores (ex.: recebimentos) = quantidade atual. Nenhuma nova contagem é
            necessária para refletir um recebimento confirmado.
          </p>
          <div className="metrics">
            <div className="metric">
              <div className="label">Base ({data.operational.base.type === "OFFICIAL_SNAPSHOT" ? "snapshot" : "legado importado"})</div>
              <div className="value">{fmtInt(data.operational.baseTotal)}</div>
            </div>
            <div className="metric">
              <div className="label">Movimentações posteriores</div>
              <div className="value">
                {data.operational.movementsTotal > 0 ? "+" : ""}
                {fmtInt(data.operational.movementsTotal)}
              </div>
            </div>
            <div className="metric">
              <div className="label">Estoque atual</div>
              <div className="value"><strong>{fmtInt(data.operational.currentTotal)}</strong></div>
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: "0.6rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Referência</th><th>CHAVEPECA</th><th className="num">Base</th>
                  <th className="num">Entradas posteriores</th><th className="num">Atual</th>
                  <th className="num" title="Reservado em separações ativas">Reservado</th>
                  <th className="num" title="Disponível = Atual − Reservado">Disponível</th>
                  <th>Mapeada</th>
                </tr>
              </thead>
              <tbody>
                {data.operational.groups
                  .filter((g) => !search || g.referencia.toUpperCase().includes(search.toUpperCase()))
                  .map((g, i) => (
                    <tr key={i}>
                      <td className="mono">{g.referencia}</td>
                      <td className="small">{g.mapeada ? g.chavePeca : <span className="badge warn">SEM CHAVE</span>}</td>
                      <td className="num">{fmtInt(g.baseQuantity)}</td>
                      <td className="num">{g.movementQuantity > 0 ? "+" : ""}{fmtInt(g.movementQuantity)}</td>
                      <td className="num"><strong>{fmtInt(g.currentQuantity)}</strong></td>
                      <td className="num" style={{ color: g.reservedQuantity > 0 ? "#d97706" : "var(--muted)" }}>
                        {g.reservedQuantity > 0 ? fmtInt(g.reservedQuantity) : "—"}
                      </td>
                      <td className="num" style={{ color: g.availableQuantity < g.currentQuantity ? "#2563eb" : undefined }}>
                        <strong>{fmtInt(g.availableQuantity)}</strong>
                      </td>
                      <td>{g.mapeada ? <span className="badge ok">sim</span> : <span className="badge err">não</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && data && isOfficial && data.official && (
        <div className="card">
          <h2>Estoque oficial ({fmtInt(data.official.totalUnits)} unidades)</h2>
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
                      <td className="small">{g.mapeada ? g.chavePeca : <span className="badge warn">SEM CHAVE</span>}</td>
                      <td className="num"><strong>{fmtInt(g.unidades)}</strong></td>
                      <td>{g.mapeada ? <span className="badge ok">sim</span> : <span className="badge err">não</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ marginTop: "1rem" }}>Comparação com o legado (lote #{data.official.comparisonBatchId})</h3>
          <p className="hint">
            Legado: {fmtInt(data.legacy.totalUnits)} unidades · Oficial: {fmtInt(data.official.totalUnits)} unidades ·
            diferença: {data.official.totalUnits - data.legacy.totalUnits > 0 ? "+" : ""}
            {fmtInt(data.official.totalUnits - data.legacy.totalUnits)}
          </p>
        </div>
      )}

      {!loading && data && data.batchId !== null && view === "groups" && !isOfficial && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Referência</th>
                  <th>Descrição</th>
                  <th>CHAVEPECA</th>
                  <th>Fornecedor</th>
                  <th className="num">Unidades</th>
                  <th>Mapeada</th>
                </tr>
              </thead>
              <tbody>
                {data.legacy.groups.map((g, i) => (
                  <tr key={i}>
                    <td className="mono">{g.referencia ?? "—"}</td>
                    <td>{g.descricao ?? "—"}</td>
                    <td className="small">
                      {g.mapeada ? g.chavePeca : <span className="badge warn">SEM CHAVE</span>}
                    </td>
                    <td>{g.fornecedor ?? "—"}</td>
                    <td className="num"><strong>{fmtInt(g.unidades)}</strong></td>
                    <td>
                      {g.mapeada ? (
                        <span className="badge ok">sim</span>
                      ) : (
                        <span className="badge err">não</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && data && data.batchId !== null && view === "units" && (
        <div className="card">
          <h2>Unidades do legado importado</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Referência</th>
                  <th>Descrição</th>
                  <th>CHAVEPECA</th>
                  <th>Fornecedor</th>
                  <th>Status físico</th>
                </tr>
              </thead>
              <tbody>
                {data.legacy.items.map((it) => (
                  <tr key={it.id}>
                    <td className="num">{it.id}</td>
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
