import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getStockMovements, type StockMovement } from "../api.js";
import { ErrorBanner, Loading, fmtInt } from "../ui.js";

const TYPES = [
  "PURCHASE_RECEIPT",
  "REPAIR_CONSUMPTION",
  "RETURN",
  "MANUAL_ADJUSTMENT",
  "DISCARD",
  "TRANSFER",
];

export function Movimentacoes() {
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [movements, setMovements] = useState<StockMovement[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setMovements(await getStockMovements({ type: type || undefined, search: search || undefined }));
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
      <h1>Movimentações de estoque</h1>
      <p className="subtitle">
        Livro-razão: cada entrada/saída confirmada no sistema. <Link to="/estoque">← voltar ao estoque</Link>
      </p>

      <div className="card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <div className="field">
            <label>Referência / CHAVEPECA</label>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="buscar…" />
          </div>
          <div className="field">
            <label>Tipo</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Todos</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <button type="submit">Filtrar</button>
        </form>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading what="movimentações" />}

      {!loading && movements && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Tipo</th><th>Referência</th><th>CHAVEPECA</th>
                  <th className="num">Quantidade</th><th>Responsável</th><th>Data</th><th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {movements.length === 0 && <tr><td colSpan={8} className="muted">Nenhuma movimentação encontrada.</td></tr>}
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="num">{m.id}</td>
                    <td><span className="badge neutral">{m.movement_type}</span></td>
                    <td className="mono">{m.referencia}</td>
                    <td className="small">{m.chave_peca ?? "—"}</td>
                    <td className="num">{m.quantity > 0 ? "+" : ""}{fmtInt(m.quantity)}</td>
                    <td>{m.created_by ?? "—"}</td>
                    <td className="small">{m.created_at}</td>
                    <td className="small muted">{m.notes ?? "—"}</td>
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
