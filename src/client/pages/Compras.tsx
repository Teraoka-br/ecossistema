import { useEffect, useMemo, useRef, useState } from "react";
import {
  confirmReceipt, cancelPurchaseOrder, getPurchaseOrders,
  type PurchaseOrder,
} from "../api.js";
import { ErrorBanner, Loading, fmtMoney } from "../ui.js";
import {
  ShoppingCart, Package, CheckCircle2, X, Loader2, RefreshCw,
  Download, Upload, FileText, Check, Ban, Search,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NecessidadeItem { chavePeca: string; qtdeNecessaria: number; }

interface CotacaoItem {
  id: number; cotacaoId: number; chavePeca: string;
  qtde: number; valorUnitario: number; aprovado: boolean;
}
interface Cotacao {
  id: number; supplier: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "CANCELLED";
  notes: string | null; createdAt: string; createdBy: string | null;
  approvedAt: string | null; purchaseOrderId: number | null;
  items: CotacaoItem[];
}

type Tab = "NECESSIDADES" | "COTACOES" | "AGUARDANDO" | "RECEBIDOS" | "CANCELADOS";

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Compras() {
  const [tab, setTab] = useState<Tab>("NECESSIDADES");
  const [necessidades, setNecessidades] = useState<NecessidadeItem[]>([]);
  const [cotacoes, setCotacoes] = useState<Cotacao[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true); setError(null);
    try {
      const [rN, rC, rO] = await Promise.all([
        fetch("/api/necessidades").then(r => r.json()),
        fetch("/api/cotacoes").then(r => r.json()),
        getPurchaseOrders(),
      ]);
      setNecessidades(rN.items ?? []);
      setCotacoes(rC.cotacoes ?? []);
      setOrders(rO);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadAll(); }, []);

  const cotacoesPendentes = cotacoes.filter(c => c.status === "PENDING_APPROVAL");
  const aguardando = orders.filter(o => o.status === "AWAITING_RECEIPT" || o.status === "PARTIALLY_RECEIVED");
  const recebidos  = orders.filter(o => o.status === "RECEIVED");
  const cancelados = orders.filter(o => o.status === "CANCELLED");

  const tabs: { key: Tab; label: string; count: number; icon: React.ReactNode }[] = [
    { key: "NECESSIDADES", label: "Necessidades",  count: necessidades.length, icon: <ShoppingCart size={13} /> },
    { key: "COTACOES",     label: "Cotações",      count: cotacoesPendentes.length, icon: <FileText size={13} /> },
    { key: "AGUARDANDO",   label: "Aguardando",    count: aguardando.length,  icon: <Package size={13} /> },
    { key: "RECEBIDOS",    label: "Recebidos",     count: recebidos.length,   icon: <CheckCircle2 size={13} /> },
    { key: "CANCELADOS",   label: "Cancelados",    count: cancelados.length,  icon: <X size={13} /> },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pedidos de Compra</h1>
          <p className="page-subtitle">Necessidades → cotação → aprovação → pedido → recebimento</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} disabled={loading} title="Atualizar">
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="tab-bar">
        {tabs.map(t => (
          <button key={t.key} className={`tab-btn${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.icon}{t.label}<span className="tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {loading && <Loading what="compras" />}

      {!loading && tab === "NECESSIDADES" && (
        <NecessidadesTab items={necessidades} onCotacaoCreated={() => { loadAll(); setTab("COTACOES"); }} />
      )}
      {!loading && tab === "COTACOES" && (
        <CotacoesTab cotacoes={cotacoes} onChanged={loadAll} />
      )}
      {!loading && tab === "AGUARDANDO" && (
        <AguardandoTab orders={aguardando} onChanged={loadAll} />
      )}
      {!loading && tab === "RECEBIDOS" && <RecebidosTab orders={recebidos} />}
      {!loading && tab === "CANCELADOS" && <CanceladosTab orders={cancelados} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Necessidades
// ---------------------------------------------------------------------------

function NecessidadesTab({ items, onCotacaoCreated }: {
  items: NecessidadeItem[];
  onCotacaoCreated: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"list" | "upload">("list");
  const [supplier, setSupplier] = useState("");
  const [uploadedItems, setUploadedItems] = useState<Array<{ chavePeca: string; qtde: number; valorUnitario: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = search.trim()
    ? items.filter(i => i.chavePeca.toLowerCase().includes(search.trim().toLowerCase()))
    : items;

  const allSelected = filtered.length > 0 && filtered.every(i => selected.has(i.chavePeca));

  function toggleAll() {
    if (allSelected) setSelected(p => { const n = new Set(p); filtered.forEach(i => n.delete(i.chavePeca)); return n; });
    else setSelected(p => { const n = new Set(p); filtered.forEach(i => n.add(i.chavePeca)); return n; });
  }
  function toggle(cp: string) {
    setSelected(p => { const n = new Set(p); n.has(cp) ? n.delete(cp) : n.add(cp); return n; });
  }

  function exportCotacao() {
    const pecas = selected.size > 0 ? Array.from(selected).join(",") : "";
    const url = "/api/necessidades/export.csv" + (pecas ? `?pecas=${encodeURIComponent(pecas)}` : "");
    window.open(url, "_blank");
  }

  function parseCSV(text: string): Array<{ chavePeca: string; qtde: number; valorUnitario: number }> {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    // Detectar header
    const start = lines[0].toUpperCase().includes("PECA") || lines[0].toUpperCase().includes("VALOR") ? 1 : 0;
    const result: Array<{ chavePeca: string; qtde: number; valorUnitario: number }> = [];
    for (const line of lines.slice(start)) {
      // CSV simples: PECA,QTDE,VALOR UN,VALOR TOTAL
      const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
      if (cols.length < 3) continue;
      const chavePeca = cols[0];
      const qtde = parseInt(cols[1]);
      const valorUnitario = parseFloat(cols[2].replace(",", "."));
      if (!chavePeca || isNaN(qtde) || isNaN(valorUnitario) || valorUnitario <= 0) continue;
      result.push({ chavePeca, qtde, valorUnitario });
    }
    return result;
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      setUploadedItems(parsed);
      setMode("upload");
    };
    reader.readAsText(file, "utf-8");
  }

  async function submitCotacao() {
    if (!supplier.trim()) { setError("Informe o fornecedor."); return; }
    if (uploadedItems.length === 0) { setError("Nenhum item com preço válido encontrado no arquivo."); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/cotacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier: supplier.trim(), items: uploadedItems }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error ?? "Erro ao registrar cotação."); }
      setMode("list"); setSupplier(""); setUploadedItems([]); setSelected(new Set());
      if (fileRef.current) fileRef.current.value = "";
      onCotacaoCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const selectedItems = items.filter(i => selected.has(i.chavePeca));
  const totalSelecionado = selectedItems.reduce((s, i) => s + i.qtdeNecessaria, 0);
  const totalUnidades = items.reduce((s, i) => s + i.qtdeNecessaria, 0);

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <CheckCircle2 size={36} style={{ opacity: 0.25 }} />
        <div style={{ fontWeight: 600 }}>Nenhuma peça necessária</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Não há aparelhos com status "Pedir Peça" aguardando compra.</div>
      </div>
    );
  }

  if (mode === "upload") {
    const total = uploadedItems.reduce((s, i) => s + i.qtde * i.valorUnitario, 0);
    return (
      <div>
        {error && <ErrorBanner message={error} />}
        <div style={{ marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode("list")}><X size={12} /> Voltar</button>
          <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
            {uploadedItems.length} ite{uploadedItems.length !== 1 ? "ns" : "m"} com preço · Total: <strong style={{ color: "var(--text)" }}>{fmtMoney(total)}</strong>
          </span>
        </div>

        <div className="card" style={{ marginBottom: "1rem", padding: "0.875rem 1rem" }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Fornecedor</label>
            <input
              value={supplier}
              onChange={e => setSupplier(e.target.value)}
              placeholder="Nome do fornecedor que respondeu a cotação"
              autoFocus
            />
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "0.5rem 1rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em" }}>PEÇA</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>QTDE</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>VALOR UN</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {uploadedItems.map((it, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.5rem 1rem", fontFamily: "monospace", fontSize: "0.8rem" }}>{it.chavePeca}</td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{it.qtde}</td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{fmtMoney(it.valorUnitario)}</td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>{fmtMoney(it.qtde * it.valorUnitario)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode("list")} disabled={busy}>Cancelar</button>
          <button className="btn btn-primary" onClick={submitCotacao} disabled={busy || !supplier.trim()}>
            {busy ? <><Loader2 size={13} className="spin" /> Registrando…</> : <><FileText size={13} /> Registrar cotação</>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      {/* Busca + ações */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180, maxWidth: 360 }}>
          <Search size={13} style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar chave de peça…"
            style={{ paddingLeft: "2rem", width: "100%" }}
          />
        </div>
        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
          {selected.size > 0
            ? <><strong>{selected.size}</strong> selecionada{selected.size !== 1 ? "s" : ""} · <strong>{totalSelecionado}</strong> un</>
            : search.trim()
              ? <><strong>{filtered.length}</strong> de <strong>{items.length}</strong> peças · <strong>{totalUnidades}</strong> un totais</>
              : <><strong>{items.length}</strong> peças · <strong>{totalUnidades}</strong> un</>
          }
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={exportCotacao}>
          <Download size={12} /> Exportar cotação{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
        <label className="btn btn-primary btn-sm" style={{ cursor: "pointer" }}>
          <Upload size={12} /> Importar cotação preenchida
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={onFileChange} />
        </label>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "0.5rem 1rem", width: 36 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em" }}>CHAVE DA PEÇA</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>QTDE NECESSÁRIA</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item, idx) => (
              <tr
                key={item.chavePeca}
                style={{ borderBottom: idx < filtered.length - 1 ? "1px solid var(--border)" : "none", cursor: "pointer",
                  background: selected.has(item.chavePeca) ? "rgba(99,102,241,0.05)" : undefined }}
                onClick={() => toggle(item.chavePeca)}
              >
                <td style={{ padding: "0.5rem 1rem" }}>
                  <input type="checkbox" checked={selected.has(item.chavePeca)} onChange={() => toggle(item.chavePeca)} onClick={e => e.stopPropagation()} />
                </td>
                <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.82rem" }}>{item.chavePeca}</td>
                <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{item.qtdeNecessaria}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Cotações pendentes de aprovação
// ---------------------------------------------------------------------------

function CotacoesTab({ cotacoes, onChanged }: { cotacoes: Cotacao[]; onChanged: () => void }) {
  const [approving, setApproving] = useState<Cotacao | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelar(id: number) {
    await fetch(`/api/cotacoes/${id}/cancelar`, { method: "POST" });
    onChanged();
  }

  if (cotacoes.length === 0) {
    return (
      <div className="empty-state">
        <FileText size={36} style={{ opacity: 0.25 }} />
        <div style={{ fontWeight: 600 }}>Nenhuma cotação</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Exporte uma cotação na aba Necessidades, preencha com o fornecedor e importe.</div>
      </div>
    );
  }

  if (approving) {
    return (
      <AprovacaoScreen
        cotacao={approving}
        busy={busy}
        error={error}
        onCancel={() => setApproving(null)}
        onAprovar={async (aprovados) => {
          setBusy(true); setError(null);
          try {
            const r = await fetch(`/api/cotacoes/${approving.id}/aprovar`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ aprovados }),
            });
            if (!r.ok) { const d = await r.json(); throw new Error(d.error ?? "Erro."); }
            const result = await r.json();
            // Download do pedido
            window.open(`/api/cotacoes/${approving.id}/pedido.csv`, "_blank");
            setApproving(null);
            onChanged();
            return result.orderNumber as string;
          } catch (e) { setError((e as Error).message); return null; }
          finally { setBusy(false); }
        }}
      />
    );
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {cotacoes.map(c => {
        const isPending = c.status === "PENDING_APPROVAL";
        const total = c.items.reduce((s, i) => s + i.qtde * i.valorUnitario, 0);
        return (
          <div key={c.id} className="card" style={{ marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem", marginBottom: "0.75rem" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{c.supplier}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  {c.items.length} ite{c.items.length !== 1 ? "ns" : "m"} · Total: {fmtMoney(total)} · {c.createdAt.slice(0, 16).replace("T", " ")}
                </div>
              </div>
              <span className={`badge ${isPending ? "badge-warn" : c.status === "APPROVED" ? "badge-ok" : "badge-err"}`}>
                {isPending ? "Aguardando aprovação" : c.status === "APPROVED" ? "Aprovado" : "Cancelado"}
              </span>
            </div>

            {/* Preview dos itens */}
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
              {c.items.slice(0, 3).map(i => (
                <span key={i.id} style={{ marginRight: "0.5rem" }}>
                  {i.chavePeca} ×{i.qtde} @ {fmtMoney(i.valorUnitario)}
                </span>
              ))}
              {c.items.length > 3 && <span>+{c.items.length - 3} mais…</span>}
            </div>

            {isPending && (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button className="btn btn-primary btn-sm" onClick={() => setApproving(c)}>
                  <Check size={12} /> Aprovar itens
                </button>
                <button className="btn btn-ghost btn-sm" style={{ color: "var(--err-text)" }} onClick={() => cancelar(c.id)}>
                  <Ban size={12} /> Cancelar cotação
                </button>
              </div>
            )}

            {c.status === "APPROVED" && (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <a className="btn btn-ghost btn-sm" href={`/api/cotacoes/${c.id}/pedido.csv`} download>
                  <Download size={12} /> Baixar pedido
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tela de aprovação de cotação
// ---------------------------------------------------------------------------

function AprovacaoScreen({ cotacao, busy, error, onCancel, onAprovar }: {
  cotacao: Cotacao;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAprovar: (aprovados: number[]) => Promise<string | null>;
}) {
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set(cotacao.items.map(i => i.id)));
  const [done, setDone] = useState<string | null>(null);

  const aprovados = cotacao.items.filter(i => selecionados.has(i.id));
  const total = aprovados.reduce((s, i) => s + i.qtde * i.valorUnitario, 0);

  function toggle(id: number) {
    setSelecionados(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleAprovar() {
    const orderNumber = await onAprovar(Array.from(selecionados));
    if (orderNumber) setDone(orderNumber);
  }

  if (done) {
    return (
      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--ok-text)", marginBottom: "0.75rem" }}>
          <CheckCircle2 size={20} />
          <strong>Pedido {done} gerado!</strong>
        </div>
        <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
          O pedido foi registrado e aparece na aba "Aguardando". O export CSV foi baixado automaticamente.
        </div>
        <button className="btn btn-primary btn-sm" onClick={onCancel}>Ver pedidos</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}><X size={12} /> Voltar</button>
        <div>
          <div style={{ fontWeight: 600 }}>Aprovar cotação — {cotacao.supplier}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Desmarque as peças que não quer pedir</div>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "0.5rem 1rem", width: 36 }}></th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>PEÇA</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>QTDE</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>VALOR UN</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {cotacao.items.map((item, idx) => {
              const checked = selecionados.has(item.id);
              return (
                <tr
                  key={item.id}
                  style={{ borderBottom: idx < cotacao.items.length - 1 ? "1px solid var(--border)" : "none",
                    opacity: checked ? 1 : 0.4, cursor: "pointer",
                    background: checked ? undefined : "rgba(239,68,68,0.03)" }}
                  onClick={() => toggle(item.id)}
                >
                  <td style={{ padding: "0.5rem 1rem" }}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} onClick={e => e.stopPropagation()} />
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.82rem" }}>{item.chavePeca}</td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{item.qtde}</td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{fmtMoney(item.valorUnitario)}</td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>{fmtMoney(item.qtde * item.valorUnitario)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid var(--border)" }}>
              <td colSpan={4} style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontWeight: 600, fontSize: "0.85rem" }}>
                Total aprovado ({aprovados.length} iten{aprovados.length !== 1 ? "s" : ""})
              </td>
              <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontWeight: 700, color: "var(--accent)" }}>
                {fmtMoney(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button
          className="btn btn-primary"
          onClick={handleAprovar}
          disabled={busy || selecionados.size === 0}
        >
          {busy
            ? <><Loader2 size={13} className="spin" /> Gerando pedido…</>
            : <><ShoppingCart size={13} /> Gerar pedido ({aprovados.length} iten{aprovados.length !== 1 ? "s" : ""})</>
          }
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Aguardando recebimento
// ---------------------------------------------------------------------------

function AguardandoTab({ orders, onChanged }: { orders: PurchaseOrder[]; onChanged: () => void }) {
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCancel(o: PurchaseOrder) {
    const reason = window.prompt(`Motivo para cancelar o pedido ${o.order_number}:`);
    if (!reason?.trim()) return;
    try { await cancelPurchaseOrder(o.id, reason.trim()); onChanged(); }
    catch (e) { setError((e as Error).message); }
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
              <th className="num">Progresso</th><th>Criado em</th><th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => {
              const totalOrdered  = o.items.reduce((s, i) => s + i.quantity_ordered, 0);
              const totalReceived = o.items.reduce((s, i) => s + i.quantity_received, 0);
              const pct = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;
              return (
                <tr key={o.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{o.order_number}</td>
                  <td>{o.supplier ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                  <td className="small">{o.items.map(i => `${i.referencia} (${i.quantity_received}/${i.quantity_ordered})`).join(", ")}</td>
                  <td className="num">
                    <span style={{ color: pct === 100 ? "var(--ok-text)" : pct > 0 ? "var(--warn-text)" : "var(--text-muted)" }}>
                      {totalReceived}/{totalOrdered}
                    </span>
                  </td>
                  <td className="small">{o.created_at}</td>
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

// ---------------------------------------------------------------------------
// Modal de recebimento (mantido do original)
// ---------------------------------------------------------------------------

function lineStatus(it: PurchaseOrder["items"][number], qty: number): { label: string; color: string } {
  const saldo = it.quantity_ordered - it.quantity_received;
  if (qty === 0) return { label: "sem recebimento", color: "var(--text-muted, #888)" };
  if (qty > saldo) return { label: "excedente", color: "var(--err-text, #f87171)" };
  if (qty === saldo) return { label: "completo", color: "var(--ok-text, #34d399)" };
  return { label: "parcial", color: "var(--warn-text, #fbbf24)" };
}

function ReceberModal({ order, onClose, onDone }: { order: PurchaseOrder; onClose: () => void; onDone: () => void }) {
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
    () => order.items.filter(it => quantities[it.id] > 0).map(it => ({ purchaseOrderItemId: it.id, quantity: quantities[it.id] })),
    [order.items, quantities],
  );
  const anyOver = order.items.some(it => (quantities[it.id] ?? 0) > remaining(it));

  async function doConfirm() {
    if (anyOver && (!allowOverReceipt || justification.trim().length < 10)) {
      setError("Excedente detectado: marque a opção e informe justificativa (mín. 10 caracteres)."); return;
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
    <div className="modal-overlay" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
      <div className="modal" onClick={e => e.stopPropagation()}
        style={{ width: "min(1100px, calc(100vw - 2rem))", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>Receber pedido {order.order_number}</h3>
            {order.supplier && <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{order.supplier}</div>}
          </div>
          {!confirmed && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { const n: Record<number, number> = {}; for (const it of order.items) n[it.id] = remaining(it); setQuantities(n); }} disabled={busy}>Receber saldo</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { const n: Record<number, number> = {}; for (const it of order.items) n[it.id] = 0; setQuantities(n); }} disabled={busy}>Zerar tudo</button>
            </div>
          )}
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: "1rem 1.25rem" }}>
          {error && <ErrorBanner message={error} />}
          {confirmed ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ background: "var(--ok-dim)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: "var(--r-md)", padding: "1rem", color: "var(--ok-text)" }}>
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
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", minWidth: 200 }}>Chave da peça</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 70 }}>Pedido</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 80 }}>Recebido</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 70 }}>Saldo</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 100 }}>Recebendo</th>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", width: 110 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map(it => {
                      const qty = quantities[it.id] ?? 0;
                      const saldo = remaining(it);
                      const st = lineStatus(it, qty);
                      return (
                        <tr key={it.id} style={{ borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.05))" }}>
                          <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.8rem" }}>{it.chave_peca ?? it.referencia}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{it.quantity_ordered}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{it.quantity_received}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", color: saldo === 0 ? "var(--ok-text)" : undefined }}>{saldo}</td>
                          <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>
                            <input type="number" min={0} style={{ width: "5.5rem", textAlign: "right" }}
                              value={qty} onChange={e => setQuantities(p => ({ ...p, [it.id]: Math.max(0, Number(e.target.value)) }))} />
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
                  ⚠ Recebimento acima do saldo detectado.
                  <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <input type="checkbox" checked={allowOverReceipt} onChange={e => setAllowOverReceipt(e.target.checked)} />
                      Permitir recebimento acima do pedido
                    </label>
                    <input value={justification} onChange={e => setJustification(e.target.value)}
                      placeholder="Justificativa obrigatória (mín. 10 caracteres)" style={{ fontSize: "0.82rem" }} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-actions" style={{ borderTop: "1px solid var(--border)", padding: "0.75rem 1.25rem", flexShrink: 0 }}>
          {confirmed ? (
            <button className="btn btn-secondary btn-sm" onClick={onDone}>Fechar e atualizar</button>
          ) : (
            <>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{items.length} item(ns) · {items.reduce((s, i) => s + i.quantity, 0)} unidade(s)</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancelar</button>
              <button className="btn btn-primary btn-sm" onClick={doConfirm}
                disabled={busy || items.length === 0 || (anyOver && (!allowOverReceipt || justification.trim().length < 10))}>
                {busy ? <><Loader2 size={12} className="spin" /> Confirmando…</> : "Confirmar recebimento"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs simples: Recebidos / Cancelados
// ---------------------------------------------------------------------------

function RecebidosTab({ orders }: { orders: PurchaseOrder[] }) {
  if (orders.length === 0) return <div className="empty-state"><div style={{ fontWeight: 600 }}>Nenhum pedido recebido ainda.</div></div>;
  return (
    <div className="card"><div className="table-wrap"><table>
      <thead><tr><th>Pedido</th><th>Fornecedor</th><th>Recebido em</th><th className="num">Total recebido</th></tr></thead>
      <tbody>
        {orders.map(o => (
          <tr key={o.id}>
            <td className="mono" style={{ fontWeight: 600 }}>{o.order_number}</td>
            <td>{o.supplier ?? "—"}</td>
            <td className="small">{o.received_at ?? "—"}</td>
            <td className="num"><strong>{o.items.reduce((s, i) => s + i.quantity_received, 0)}</strong></td>
          </tr>
        ))}
      </tbody>
    </table></div></div>
  );
}

function CanceladosTab({ orders }: { orders: PurchaseOrder[] }) {
  if (orders.length === 0) return <div className="empty-state"><div style={{ fontWeight: 600 }}>Nenhum pedido cancelado.</div></div>;
  return (
    <div className="card"><div className="table-wrap"><table>
      <thead><tr><th>Pedido</th><th>Fornecedor</th><th>Motivo</th><th>Data</th></tr></thead>
      <tbody>
        {orders.map(o => (
          <tr key={o.id}>
            <td className="mono">{o.order_number}</td>
            <td>{o.supplier ?? "—"}</td>
            <td className="small">{o.cancel_reason ?? "—"}</td>
            <td className="small">{o.cancelled_at ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table></div></div>
  );
}
