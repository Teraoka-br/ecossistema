import { useEffect, useState } from "react";
import { getCotacoes, type CotacoesResponse } from "../api.js";
import { ErrorBanner, Loading, NoBatchBanner, fmtInt, fmtMoney } from "../ui.js";

export function Cotacoes() {
  const [search, setSearch] = useState("");
  const [data, setData] = useState<CotacoesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await getCotacoes(search));
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

  return (
    <div>
      <h1>Cotações</h1>
      <p className="subtitle">Somente leitura — peças a pedir e cotações existentes (origem: ANALISE MI).</p>

      <div className="card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <div className="field">
            <label>Buscar (ID pedido, peça, status)</label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ex.: BATERIA IPHONE 13 ou APROVADO"
            />
          </div>
          <button type="submit">Buscar</button>
          {data?.batchId && (
            <span className="right muted small">
              {fmtInt(data.quotations.length)} cotações (lote #{data.batchId})
            </span>
          )}
        </form>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading what="cotações" />}
      {!loading && data && data.batchId === null && <NoBatchBanner />}

      {!loading && data && data.batchId !== null && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID pedido</th>
                  <th>Peça (CHAVEPEÇA)</th>
                  <th className="num">Qtde</th>
                  <th className="num">Valor un.</th>
                  <th className="num">Valor total</th>
                  <th>Data cotação</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.quotations.map((q) => (
                  <tr key={q.id}>
                    <td className="mono small">{q.idPedido ?? "—"}</td>
                    <td>{q.chavePeca ?? "—"}</td>
                    <td className="num">{fmtInt(q.quantidade)}</td>
                    <td className="num">{fmtMoney(q.valorUnitario)}</td>
                    <td className="num">{fmtMoney(q.valorTotal)}</td>
                    <td>{q.dataCotacao ?? "—"}</td>
                    <td>{q.status ?? "—"}</td>
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
