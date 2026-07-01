import { useEffect, useMemo, useState } from "react";
import {
  cancelPurchaseOrder,
  confirmReceipt,
  createPurchaseOrder,
  getPurchaseOrders,
  getPurchaseRequests,
  previewReceipt,
  type PurchaseOrder,
  type PurchaseRequest,
  type ReceivePreviewLine,
} from "../api.js";
import { ErrorBanner, Loading, fmtInt, fmtMoney } from "../ui.js";

type Tab = "APROVADOS" | "AGUARDANDO" | "RECEBIDOS" | "CANCELADOS";

export function Compras() {
  const [tab, setTab] = useState<Tab>("APROVADOS");
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responsibleName, setResponsibleName] = useState("");

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [reqs, ords] = await Promise.all([getPurchaseRequests("APPROVED"), getPurchaseOrders()]);
      setRequests(reqs);
      setOrders(ords);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  const awaiting = orders.filter((o) => o.status === "AWAITING_RECEIPT" || o.status === "PARTIALLY_RECEIVED");
  const received = orders.filter((o) => o.status === "RECEIVED");
  const cancelled = orders.filter((o) => o.status === "CANCELLED");

  return (
    <div>
      <h1>Compras</h1>
      <p className="subtitle">Solicitações aprovadas → pedidos de compra → recebimento → entrada imediata no estoque.</p>

      {error && <ErrorBanner message={error} />}

      <div className="card">
        <div className="row">
          <div className="field">
            <label>Seu nome (responsável pelas ações nesta tela)</label>
            <input value={responsibleName} onChange={(e) => setResponsibleName(e.target.value)} placeholder="ex.: João" />
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: "0.4rem", marginBottom: "0.6rem" }}>
        {(["APROVADOS", "AGUARDANDO", "RECEBIDOS", "CANCELADOS"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "" : "secondary"} onClick={() => setTab(t)}>
            {t === "APROVADOS" && `APROVADOS (${requests.length})`}
            {t === "AGUARDANDO" && `AGUARDANDO RECEBIMENTO (${awaiting.length})`}
            {t === "RECEBIDOS" && `RECEBIDOS (${received.length})`}
            {t === "CANCELADOS" && `CANCELADOS (${cancelled.length})`}
          </button>
        ))}
      </div>

      {loading && <Loading what="compras" />}

      {!loading && tab === "APROVADOS" && (
        <AprovadosTab requests={requests} responsibleName={responsibleName} onChanged={loadAll} />
      )}
      {!loading && tab === "AGUARDANDO" && (
        <AguardandoTab orders={awaiting} responsibleName={responsibleName} onChanged={loadAll} />
      )}
      {!loading && tab === "RECEBIDOS" && <RecebidosTab orders={received} />}
      {!loading && tab === "CANCELADOS" && <CanceladosTab orders={cancelled} />}
    </div>
  );
}

function AprovadosTab({
  requests,
  responsibleName,
  onChanged,
}: {
  requests: PurchaseRequest[];
  responsibleName: string;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Record<number, number>>({}); // requestId -> quantity
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState("");

  function toggle(r: PurchaseRequest) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[r.id] !== undefined) delete next[r.id];
      else next[r.id] = r.quantidade ?? 1;
      return next;
    });
  }

  const selectedIds = Object.keys(selected).map(Number);
  const total = selectedIds.reduce((sum, id) => {
    const req = requests.find((r) => r.id === id);
    return sum + (req?.valor_unitario ?? 0) * (selected[id] ?? 0);
  }, 0);

  async function gerarPedido() {
    if (!responsibleName.trim()) {
      setError("Informe o responsável (campo no topo da tela) antes de gerar o pedido.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const items = selectedIds.map((id) => {
        const req = requests.find((r) => r.id === id)!;
        return { purchaseRequestId: id, referencia: req.referencia ?? req.chave_peca ?? `PED-${id}`, chavePeca: req.chave_peca, quantity: selected[id] };
      });
      await createPurchaseOrder(db_input(responsibleName, supplier, items));
      setSelected({});
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function db_input(createdBy: string, sup: string, items: { purchaseRequestId: number; referencia: string; chavePeca: string | null; quantity: number }[]) {
    return { createdBy, supplier: sup || null, items };
  }

  return (
    <div className="card">
      {error && <ErrorBanner message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th><th>ID_PEDIDO</th><th>CHAVEPECA</th><th>Referência sugerida</th>
              <th className="num">Qtde solicitada</th><th className="num">Qtde a pedir</th>
              <th className="num">Custo previsto</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 && <tr><td colSpan={8} className="muted">Nenhuma solicitação aprovada pendente.</td></tr>}
            {requests.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={selected[r.id] !== undefined} onChange={() => toggle(r)} /></td>
                <td className="mono">{r.id_pedido ?? "—"}</td>
                <td className="small">{r.chave_peca ?? "—"}</td>
                <td className="mono">{r.referencia ?? r.chave_peca ?? "—"}</td>
                <td className="num">{fmtInt(r.quantidade)}</td>
                <td className="num">
                  {selected[r.id] !== undefined ? (
                    <input
                      type="number"
                      min={1}
                      style={{ width: "5rem" }}
                      value={selected[r.id]}
                      onChange={(e) => setSelected((prev) => ({ ...prev, [r.id]: Number(e.target.value) }))}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num">{fmtMoney(r.valor_unitario)}</td>
                <td><span className="badge ok">{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedIds.length > 0 && (
        <div className="row" style={{ marginTop: "0.8rem", alignItems: "center" }}>
          <div className="field">
            <label>Fornecedor (opcional)</label>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="ex.: Fornecedor XPTO" />
          </div>
          <span className="muted small">Total previsto: {fmtMoney(total)}</span>
          <button onClick={gerarPedido} disabled={busy}>
            {busy ? "Gerando…" : "GERAR PEDIDO"}
          </button>
        </div>
      )}
    </div>
  );
}

function AguardandoTab({
  orders,
  responsibleName,
  onChanged,
}: {
  orders: PurchaseOrder[];
  responsibleName: string;
  onChanged: () => void;
}) {
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCancel(o: PurchaseOrder) {
    const reason = window.prompt(`Motivo para cancelar o pedido ${o.order_number}:`);
    if (!reason || reason.trim() === "") return;
    if (!responsibleName.trim()) {
      setError("Informe o responsável no topo da tela antes de cancelar.");
      return;
    }
    try {
      await cancelPurchaseOrder(o.id, responsibleName, reason.trim());
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card">
      {error && <ErrorBanner message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pedido</th><th>Fornecedor</th><th>Itens</th><th>Progresso</th><th>Criado em</th><th>Responsável</th><th></th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && <tr><td colSpan={7} className="muted">Nenhum pedido aguardando recebimento.</td></tr>}
            {orders.map((o) => {
              const totalOrdered = o.items.reduce((s, i) => s + i.quantity_ordered, 0);
              const totalReceived = o.items.reduce((s, i) => s + i.quantity_received, 0);
              return (
                <tr key={o.id}>
                  <td className="mono">{o.order_number}</td>
                  <td>{o.supplier ?? "—"}</td>
                  <td className="small">{o.items.map((i) => `${i.referencia} (${i.quantity_received}/${i.quantity_ordered})`).join(", ")}</td>
                  <td className="num">{totalReceived}/{totalOrdered}</td>
                  <td className="small">{o.created_at}</td>
                  <td>{o.created_by ?? "—"}</td>
                  <td className="row" style={{ gap: "0.3rem" }}>
                    <button onClick={() => setReceivingOrder(o)}>RECEBER</button>
                    <button className="secondary" onClick={() => onCancel(o)}>Cancelar</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {receivingOrder && (
        <ReceberModal
          order={receivingOrder}
          responsibleName={responsibleName}
          onClose={() => setReceivingOrder(null)}
          onDone={() => {
            setReceivingOrder(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ReceberModal({
  order,
  responsibleName,
  onClose,
  onDone,
}: {
  order: PurchaseOrder;
  responsibleName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {};
    for (const it of order.items) init[it.id] = Math.max(0, it.quantity_ordered - it.quantity_received);
    return init;
  });
  const [preview, setPreview] = useState<ReceivePreviewLine[] | null>(null);
  const [allowOverReceipt, setAllowOverReceipt] = useState(false);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ unitsReceived: number } | null>(null);

  const items = useMemo(
    () => order.items.filter((it) => quantities[it.id] > 0).map((it) => ({ purchaseOrderItemId: it.id, quantity: quantities[it.id] })),
    [order.items, quantities],
  );

  async function doPreview() {
    setError(null);
    setBusy(true);
    try {
      const p = await previewReceipt(order.id, items);
      setPreview(p.lines);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doConfirm() {
    if (!responsibleName.trim()) {
      setError("Informe o responsável no topo da tela antes de confirmar.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await confirmReceipt(order.id, {
        receivedBy: responsibleName,
        allowOverReceipt,
        justification: justification || null,
        items,
      });
      setConfirmed({ unitsReceived: result.unitsReceived });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const anyOver = preview?.some((l) => l.over) ?? false;

  return (
    <div className="modal-overlay">
      <div className="modal card">
        <h2>Receber pedido {order.order_number}</h2>
        {error && <ErrorBanner message={error} />}
        {confirmed ? (
          <div className="banner ok">
            Recebimento confirmado. Unidades adicionadas ao estoque: <strong>{confirmed.unitsReceived}</strong>. Estoque atualizado imediatamente.
            <div style={{ marginTop: "0.6rem" }}>
              <button onClick={onDone}>Fechar</button>
            </div>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Referência</th><th>CHAVEPECA</th><th className="num">Pedido</th>
                    <th className="num">Recebido antes</th><th className="num">Saldo</th><th className="num">Recebendo agora</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((it) => {
                    const remaining = it.quantity_ordered - it.quantity_received;
                    return (
                      <tr key={it.id}>
                        <td className="mono">{it.referencia}</td>
                        <td className="small">{it.chave_peca ?? "—"}</td>
                        <td className="num">{it.quantity_ordered}</td>
                        <td className="num">{it.quantity_received}</td>
                        <td className="num">{remaining}</td>
                        <td className="num">
                          <input
                            type="number"
                            min={0}
                            style={{ width: "5rem" }}
                            value={quantities[it.id] ?? 0}
                            onChange={(e) => setQuantities((prev) => ({ ...prev, [it.id]: Number(e.target.value) }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ marginTop: "0.6rem" }}>
              <button onClick={doPreview} disabled={busy} className="secondary">Pré-visualizar</button>
            </div>

            {preview && anyOver && (
              <div className="banner warn" style={{ marginTop: "0.6rem" }}>
                Recebimento acima do saldo pedido detectado. Confirme explicitamente:
                <div className="row" style={{ marginTop: "0.4rem" }}>
                  <label className="row" style={{ gap: "0.3rem" }}>
                    <input type="checkbox" checked={allowOverReceipt} onChange={(e) => setAllowOverReceipt(e.target.checked)} />
                    Permitir recebimento acima do pedido
                  </label>
                  <div className="field">
                    <label>Justificativa (mín. 10 caracteres)</label>
                    <input value={justification} onChange={(e) => setJustification(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            <div className="row" style={{ marginTop: "0.8rem" }}>
              <button onClick={doConfirm} disabled={busy || items.length === 0}>
                {busy ? "Confirmando…" : "Confirmar recebimento"}
              </button>
              <button className="secondary" onClick={onClose} disabled={busy}>Cancelar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RecebidosTab({ orders }: { orders: PurchaseOrder[] }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Pedido</th><th>Recebido em</th><th>Itens</th><th className="num">Total recebido</th></tr>
          </thead>
          <tbody>
            {orders.length === 0 && <tr><td colSpan={4} className="muted">Nenhum pedido recebido ainda.</td></tr>}
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.order_number}</td>
                <td className="small">{o.received_at ?? "—"}</td>
                <td className="small">{o.items.map((i) => `${i.referencia} (${i.quantity_received})`).join(", ")}</td>
                <td className="num">{o.items.reduce((s, i) => s + i.quantity_received, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CanceladosTab({ orders }: { orders: PurchaseOrder[] }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Pedido</th><th>Motivo</th><th>Responsável</th><th>Data</th></tr>
          </thead>
          <tbody>
            {orders.length === 0 && <tr><td colSpan={4} className="muted">Nenhum pedido cancelado.</td></tr>}
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.order_number}</td>
                <td className="small">{o.cancel_reason ?? "—"}</td>
                <td>{o.cancelled_by ?? "—"}</td>
                <td className="small">{o.cancelled_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
