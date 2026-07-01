import { useEffect, useState } from "react";
import type { DeviceGroup } from "../../shared/types.js";
import { getPedidos, type PedidosResponse } from "../api.js";
import { ErrorBanner, Loading, NoBatchBanner, StatusBadge, fmtInt, fmtMoney } from "../ui.js";

export function Pedidos() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<PedidosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await getPedidos(search, status));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Carrega ao montar e quando muda o status; busca textual é sob demanda.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div>
      <h1>Pedidos</h1>
      <p className="subtitle">Somente leitura — peças necessárias por aparelho (agrupado por IMEI).</p>

      <div className="card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <div className="field">
            <label>Buscar (IMEI, OS, ID pedido, peça)</label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ex.: 350060009148974 ou BATERIA IPHONE 13"
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos</option>
              {data?.statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <button type="submit">Buscar</button>
          {data?.batchId && (
            <span className="right muted small">
              {fmtInt(data.devices.length)} aparelhos · {fmtInt(data.totalParts)} peças (lote #{data.batchId})
            </span>
          )}
        </form>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading what="pedidos" />}
      {!loading && data && data.batchId === null && <NoBatchBanner />}
      {!loading && data && data.batchId !== null && data.devices.length === 0 && (
        <div className="banner info">Nenhum pedido encontrado para o filtro atual.</div>
      )}

      {!loading &&
        data &&
        data.devices.map((d) => <DeviceCard key={d.groupKey} device={d} />)}
    </div>
  );
}

function DeviceCard({ device }: { device: DeviceGroup }) {
  return (
    <div className="card">
      <div className="device-head">
        <span className="imei">IMEI {device.imei ?? "—"}</span>
        <span className="muted small">
          OS {device.osValues.length > 0 ? device.osValues.join(", ") : "—"}
        </span>
        <span className="badge neutral">peças: {device.parts.length}</span>
        <span className="badge neutral">score: {fmtInt(device.score)}</span>
        {device.osConflict && (
          <span className="badge warn" title="O mesmo IMEI aparece com OS diferentes — verifique.">
            OS divergente
          </span>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID pedido</th>
              <th>Peça (CONCAT)</th>
              <th>CHAVEPEÇA</th>
              <th>OS</th>
              <th>Status</th>
              <th>Status kit</th>
              <th className="num">Idade</th>
              <th className="num">Custo</th>
              <th className="num">Venda</th>
              <th className="num">Margem</th>
              <th className="num">Score</th>
              <th className="num">Ordem</th>
              <th className="num">Estoque</th>
            </tr>
          </thead>
          <tbody>
            {device.parts.map((p) => (
              <tr key={p.id}>
                <td className="mono small">{p.idPedido}</td>
                <td>{p.concatPeca ?? "—"}</td>
                <td className="small">{p.chavePeca ?? "—"}</td>
                <td className="small">{p.os ?? "—"}</td>
                <td><StatusBadge label={p.statusAtualLabel} /></td>
                <td className="small">{p.statusKit ?? "—"}</td>
                <td className="num">{fmtInt(p.idade)}</td>
                <td className="num">{fmtMoney(p.custo)}</td>
                <td className="num">{fmtMoney(p.venda)}</td>
                <td className="num">{fmtMoney(p.margem)}</td>
                <td className="num">{fmtInt(p.score)}</td>
                <td className="num">{fmtInt(p.ordemConsumo)}</td>
                <td className="num">{fmtInt(p.quantidadeEstoque)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
