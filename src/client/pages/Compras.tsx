import { useEffect, useMemo, useState } from "react";
import {
  cancelPurchaseOrder, confirmReceipt, createPurchaseOrder,
  getPurchaseOrders, getPurchaseRequests,
  type PurchaseOrder, type PurchaseRequest,
} from "../api.js";
import { ErrorBanner, Loading, fmtInt, fmtMoney } from "../ui.js";
import { ShoppingCart, Package, CheckCircle2, X, Loader2, RefreshCw } from "lucide-react";

type Tab = "APROVADOS" | "AGUARDANDO" | "RECEBIDOS" | "CANCELADOS";

export function Compras() {
  const [tab, setTab] = useState<Tab>("APROVADOS");
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => { void loadAll(); }, []);

  const awaiting  = orders.filter((o) => o.status === "AWAITING_RECEIPT" || o.status === "PARTIALLY_RECEIVED");
  const received  = orders.filter((o) => o.status === "RECEIVED");
  const cancelled = orders.filter((o) => o.status === "CANCELLED");

  const tabs: { key: Tab; label: string; count: number; icon: React.ReactNode }[] = [
    { key: "APROVADOS",  label: "Aprovados",  count: requests.length, icon: <CheckCircle2 size={13} /> },
    { key: "AGUARDANDO", label: "Aguardando", count: awaiting.length,  icon: <Package size={13} /> },
    { key: "RECEBIDOS",  label: "Recebidos",  count: received.length,  icon: <CheckCircle2 size={13} /> },
    { key: "CANCELADOS", label: "Cancelados", count: cancelled.length, icon: <X size={13} /> },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pedidos de Compra</h1>
          <p className="page-subtitle">Solicitações aprovadas → pedidos → recebimento → estoque</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} disabled={loading} title="Atualizar">
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Tabs */}
      <div className="tab-bar">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab-btn${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            {t.label}
            <span className="tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {loading && <Loading what="compras" />}

      {!loading && tab === "APROVADOS" && (
        <AprovadosTab requests={requests} onChanged={loadAll} />
      )}
      {!loading && tab === "AGUARDANDO" && (
        <AguardandoTab orders={awaiting} onChanged={loadAll} />
      )}
      {!loading && tab === "RECEBIDOS" && <RecebidosTab orders={received} />}
      {!loading && tab === "CANCELADOS" && <CanceladosTab orders={cancelled} />}
    </div>
  );
}

function AprovadosTab({
  requests, onChanged,
}: { requests: PurchaseRequest[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<Record<number, number>>({});
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
    setBusy(true);
    setError(null);
    try {
      const items = selectedIds.map((id) => {
        const req = requests.find((r) => r.id === id)!;
        return { purchaseRequestId: id, referencia: req.referencia ?? req.chave_peca ?? `PED-${id}`, chavePeca: req.chave_peca, quantity: selected[id] };
      });
      await createPurchaseOrder({ supplier: supplier || null, items });
      setSelected({});
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (requests.length === 0) {
    return (
      <div className="empty-state">
        <ShoppingCart size={36} style={{ opacity: 0.25 }} />
        <div>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Sem solicitações aprovadas</div>
          <div style={{ fontSize: "0.8rem" }}>Nenhuma solicitação aguardando pedido.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      {error && <ErrorBanner message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>ID Pedido</th>
              <th>Chave Peça</th>
              <th>Referência</th>
              <th className="num">Qtde solicitada</th>
              <th className="num">Qtde a pedir</th>
              <th className="num">Custo previsto</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => toggle(r)}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected[r.id] !== undefined}
                    onChange={() => toggle(r)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="mono">{r.id_pedido ?? "—"}</td>
                <td className="mono small">{r.chave_peca ?? "—"}</td>
                <td className="mono">{r.referencia ?? r.chave_peca ?? "—"}</td>
                <td className="num">{fmtInt(r.quantidade)}</td>
                <td className="num" onClick={(e) => e.stopPropagation()}>
                  {selected[r.id] !== undefined ? (
                    <input
                      type="number" min={1}
                      style={{ width: "5rem" }}
                      value={selected[r.id]}
                      onChange={(e) => setSelected((prev) => ({ ...prev, [r.id]: Number(e.target.value) }))}
                    />
                  ) : "—"}
                </td>
                <td className="num">{fmtMoney(r.valor_unitario)}</td>
                <td><span className="badge badge-ok">{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedIds.length > 0 && (
        <div style={{
          marginTop: "1rem", padding: "0.875rem 1rem",
          background: "var(--surface-alt)", border: "1px solid var(--border)",
          borderRadius: "var(--r-md)", display: "flex", gap: "0.75rem",
          alignItems: "flex-end", flexWrap: "wrap",
        }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", display: "block", marginBottom: "0.35rem" }}>
              Fornecedor (opcional)
            </label>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="ex.: Fornecedor XPTO" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Total previsto: <strong style={{ color: "var(--text)" }}>{fmtMoney(total)}</strong>
            </span>
            <button className="btn btn-primary" onClick={gerarPedido} disabled={busy}>
              {busy ? <><Loader2 size={13} className="spin" /> Gerando…</> : <><ShoppingCart size={13} /> Gerar pedido</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AguardandoTab({
  orders, onChanged,
}: { orders: PurchaseOrder[]; onChanged: () => void }) {
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCancel(o: PurchaseOrder) {
    const reason = window.prompt(`Motivo para cancelar o pedido ${o.order_number}:`);
    if (!reason || reason.trim() === "") return;
    try {
      await cancelPurchaseOrder(o.id, reason.trim());
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (orders.length === 0) {
    return (
      <div className="empty-state">
        <Package size={36} style={{ opacity: 0.25 }} />
        <div style={{ fontWeight: 600 }}>Nenhum pedido aguardando recebimento</div>
      </div>
    );
  }

  return (
    <div className="card">
      {error && <ErrorBanner message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pedido</th><th>Fornecedor</th><th>Itens</th>
              <th className="num">Progresso</th><th>Criado em</th><th>Responsável</th><th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const totalOrdered  = o.items.reduce((s, i) => s + i.quantity_ordered, 0);
              const totalReceived = o.items.reduce((s, i) => s + i.quantity_received, 0);
              const pct = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;
              return (
                <tr key={o.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{o.order_number}</td>
                  <td>{o.supplier ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                  <td className="small">{o.items.map((i) => `${i.referencia} (${i.quantity_received}/${i.quantity_ordered})`).join(", ")}</td>
                  <td className="num">
                    <span style={{ color: pct === 100 ? "var(--ok-text)" : pct > 0 ? "var(--warn-text)" : "var(--text-muted)" }}>
                      {totalReceived}/{totalOrdered}
                    </span>
                  </td>
                  <td className="small">{o.created_at}</td>
                  <td>{o.created_by ?? "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button className="btn btn-primary btn-sm" onClick={() => setReceivingOrder(o)}>
                        <Package size={12} /> Receber
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ color: "var(--err-text)" }} onClick={() => onCancel(o)}>
                        Cancelar
                      </button>
                    </div>
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
          onClose={() => setReceivingOrder(null)}
          onDone={() => { setReceivingOrder(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function lineStatus(it: PurchaseOrder["items"][number], qty: number): { label: string; color: string } {
  const saldo = it.quantity_ordered - it.quantity_received;
  if (qty === 0) return { label: "sem recebimento", color: "var(--text-muted, #888)" };
  if (qty > saldo) return { label: "excedente", color: "var(--err-text, #f87171)" };
  if (qty === saldo) return { label: "completo", color: "var(--ok-text, #34d399)" };
  return { label: "parcial", color: "var(--warn-text, #fbbf24)" };
}

function ReceberModal({
  order, onClose, onDone,
}: { order: PurchaseOrder; onClose: () => void; onDone: () => void }) {
  const remaining = (it: PurchaseOrder["items"][number]) => Math.max(0, it.quantity_ordered - it.quantity_received);

  const [quantities, setQuantities] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {};
    for (const it of order.items) init[it.id] = remaining(it);
    return init;
  });
  const [allowOverReceipt, setAllowOverReceipt] = useState(false);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ unitsReceived: number; matchStats?: { fullKitsFound: number; partialKitsFound: number; casesChanged: number } } | null>(null);

  const items = useMemo(
    () => order.items.filter((it) => quantities[it.id] > 0).map((it) => ({ purchaseOrderItemId: it.id, quantity: quantities[it.id] })),
    [order.items, quantities],
  );

  const anyOver = order.items.some((it) => (quantities[it.id] ?? 0) > remaining(it));

  function receberSaldo() {
    const next: Record<number, number> = {};
    for (const it of order.items) next[it.id] = remaining(it);
    setQuantities(next);
  }
  function zerarTudo() {
    const next: Record<number, number> = {};
    for (const it of order.items) next[it.id] = 0;
    setQuantities(next);
  }

  async function doConfirm() {
    if (anyOver && (!allowOverReceipt || justification.trim().length < 10)) {
      setError("Excedente detectado: marque a opção e informe justificativa (mín. 10 caracteres).");
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await confirmReceipt(order.id, { allowOverReceipt, justification: justification || null, items });
      setConfirmed({
        unitsReceived: result.unitsReceived,
        matchStats: (result as Record<string, unknown>).matchStats as { fullKitsFound: number; partialKitsFound: number; casesChanged: number } | undefined,
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.55)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: "1rem",
      }}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1100px, calc(100vw - 2rem))", maxHeight: "92vh",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Header fixo */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>Receber pedido {order.order_number}</h3>
            {order.supplier && <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{order.supplier}</div>}
          </div>
          {!confirmed && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn btn-ghost btn-sm" onClick={receberSaldo} disabled={busy}>Receber saldo</button>
              <button className="btn btn-ghost btn-sm" onClick={zerarTudo} disabled={busy}>Zerar tudo</button>
            </div>
          )}
        </div>

        {/* Corpo rolável */}
        <div style={{ overflowY: "auto", flex: 1, padding: "1rem 1.25rem" }}>
          {error && <ErrorBanner message={error} />}
          {confirmed ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{
                background: "var(--ok-dim)", border: "1px solid rgba(16,185,129,0.3)",
                borderRadius: "var(--r-md)", padding: "1rem", color: "var(--ok-text)",
              }}>
                <CheckCircle2 size={16} style={{ display: "inline", marginRight: 6 }} />
                Recebimento confirmado. <strong>{confirmed.unitsReceived}</strong> unidade{confirmed.unitsReceived !== 1 ? "s" : ""} adicionada{confirmed.unitsReceived !== 1 ? "s" : ""} ao estoque.
              </div>
              {confirmed.matchStats && (
                <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", padding: "0.5rem 0.75rem", background: "var(--surface-subtle, rgba(99,102,241,0.06))", borderRadius: "var(--r-md)" }}>
                  Motor executado — MATCH: <strong>{confirmed.matchStats.fullKitsFound}</strong> · Parcial: <strong>{confirmed.matchStats.partialKitsFound}</strong> · Casos atualizados: <strong>{confirmed.matchStats.casesChanged}</strong>
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ position: "sticky", top: 0, background: "var(--surface, #1e1e2e)", zIndex: 1 }}>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", minWidth: 120 }}>Referência</th>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", minWidth: 200, maxWidth: 320 }}>Chave da peça</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 70 }}>Pedido</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 80 }}>Recebido</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 70 }}>Saldo</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 100 }}>Recebendo</th>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 110 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((it) => {
                      const qty = quantities[it.id] ?? 0;
                      const saldo = remaining(it);
                      const st = lineStatus(it, qty);
                      return (
                        <tr key={it.id} style={{ borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.05))" }}>
                          <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.8rem", whiteSpace: "nowrap" }}>{it.referencia}</td>
                          <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.8rem", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.chave_peca ?? undefined}>{it.chave_peca ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{it.quantity_ordered}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{it.quantity_received}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", color: saldo === 0 ? "var(--ok-text)" : undefined }}>{saldo}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>
                            <input
                              type="number" min={0}
                              style={{ width: "5.5rem", textAlign: "right" }}
                              value={qty}
                              onChange={(e) => setQuantities((prev) => ({ ...prev, [it.id]: Math.max(0, Number(e.target.value)) }))}
                            />
                          </td>
                          <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.75rem", color: st.color, fontWeight: qty > 0 ? 500 : undefined }}>{st.label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {anyOver && (
                <div style={{ marginTop: "0.75rem", background: "var(--warn-dim)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: "var(--r-md)", padding: "0.75rem 1rem", fontSize: "0.82rem", color: "var(--warn-text)" }}>
                  ⚠ Recebimento acima do saldo detectado em um ou mais itens.
                  <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <input type="checkbox" checked={allowOverReceipt} onChange={(e) => setAllowOverReceipt(e.target.checked)} />
                      Permitir recebimento acima do pedido
                    </label>
                    <input
                      className="input"
                      value={justification}
                      onChange={(e) => setJustification(e.target.value)}
                      placeholder="Justificativa obrigatória (mín. 10 caracteres)"
                      style={{ fontSize: "0.82rem" }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer fixo */}
        <div className="modal-actions" style={{ borderTop: "1px solid var(--border)", padding: "0.75rem 1.25rem", flexShrink: 0 }}>
          {confirmed ? (
            <button className="btn btn-secondary btn-sm" onClick={onDone}>Fechar e atualizar</button>
          ) : (
            <>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{items.length} item(ns) · {items.reduce((s, i) => s + i.quantity, 0)} unidade(s)</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancelar</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={doConfirm}
                disabled={busy || items.length === 0 || (anyOver && (!allowOverReceipt || justification.trim().length < 10))}
              >
                {busy ? <><Loader2 size={12} className="spin" /> Confirmando…</> : "Confirmar recebimento"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RecebidosTab({ orders }: { orders: PurchaseOrder[] }) {
  if (orders.length === 0) return <div className="empty-state"><div style={{ fontWeight: 600 }}>Nenhum pedido recebido ainda.</div></div>;
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Pedido</th><th>Recebido em</th><th>Itens</th><th className="num">Total recebido</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="mono" style={{ fontWeight: 600 }}>{o.order_number}</td>
                <td className="small">{o.received_at ?? "—"}</td>
                <td className="small">{o.items.map((i) => `${i.referencia} (${i.quantity_received})`).join(", ")}</td>
                <td className="num"><strong>{o.items.reduce((s, i) => s + i.quantity_received, 0)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CanceladosTab({ orders }: { orders: PurchaseOrder[] }) {
  if (orders.length === 0) return <div className="empty-state"><div style={{ fontWeight: 600 }}>Nenhum pedido cancelado.</div></div>;
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Pedido</th><th>Motivo</th><th>Responsável</th><th>Data</th></tr>
          </thead>
          <tbody>
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
