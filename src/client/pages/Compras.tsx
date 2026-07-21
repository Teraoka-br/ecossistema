import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  confirmReceipt, cancelPurchaseOrder, getPurchaseOrders,
  type PurchaseOrder,
} from "../api.js";
import { ErrorBanner, Loading, fmtMoney, AlertBar, useAlert } from "../ui.js";
import {
  ShoppingCart, Package, CheckCircle2, X, Loader2, RefreshCw,
  Download, Upload, FileText, Check, Ban, Search, Zap, ArrowRight, Info,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NecessidadeItem {
  chavePeca: string;
  qtdeNecessaria: number;
  casesBlocked: number;
  fullMatchCount: number;
  marginReleased: number | null;
  saleReleased: number | null;
}

interface LeverageResult {
  combinedUnblocked: number;
  costReleased: number | null;
  saleReleased: number | null;
  marginReleased: number | null;
}

interface LineProjection {
  id: number;
  chavePeca: string;
  chavePecaNorm: string;
  selectedQtde: number;
  valorUnitario: number;
  currentAvailable: number;
  marginalFullMatches: number;
  marginalPartialMatches: number;
}

interface ProjectedCase {
  caseId: number;
  imei: string | null;
  model: string | null;
  estimatedSale: number | null;
  margin: number | null;
  isIncremental: boolean;
}

interface CotacaoProjectionResult {
  baselineFullMatches: number;
  projectedFullMatches: number;
  incrementalFullMatches: number;
  baselinePartialMatches: number;
  projectedPartialMatches: number;
  partialToFullConversions: number;
  projectedCaseIds: number[];
  incrementalCaseIds: number[];
  projectedCases: ProjectedCase[];
  orderCost: number;
  projectedRevenue: number | null;
  incrementalRevenue: number | null;
  projectedMargin: number | null;
  incrementalMargin: number | null;
  marginToCostRatio: number | null;
  costPerIncrementalMatch: number | null;
  selectedItemCount: number;
  selectedUnitCount: number;
  lineProjections: LineProjection[];
}

interface CaseNeedingPart {
  caseId: number;
  imei: string;
  brand: string | null;
  model: string | null;
  margin: number | null;
  estimatedSale: number | null;
  otherPartsNeeded: string[];
  predictedStatus: "MATCH" | "MATCH_PARCIAL";
}

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
  const alert = useAlert(6000);

  async function loadAll() {
    setLoading(true); setError(null);
    try {
      const safeFetch = async (url: string) => {
        const r = await fetch(url);
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Erro ${r.status} em ${url}`);
        }
        return r.json();
      };
      const [rN, rC, rO] = await Promise.all([
        safeFetch("/api/necessidades"),
        safeFetch("/api/cotacoes"),
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
      <AlertBar ok={alert.ok} err={alert.err} onDismiss={alert.clear} />

      <div className="tab-bar">
        {tabs.map(t => (
          <button key={t.key} className={`tab-btn${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.icon}{t.label}<span className="tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {loading && <Loading what="compras" />}

      {!loading && tab === "NECESSIDADES" && (
        <NecessidadesTab
          items={necessidades}
          onCotacaoCreated={(info) => {
            loadAll();
            setTab("COTACOES");
            alert.success(`Cotação registrada: ${info.supplier} — ${info.itemCount} ite${info.itemCount !== 1 ? "ns" : "m"} aguardando aprovação.`);
          }}
        />
      )}
      {!loading && tab === "COTACOES" && (
        <CotacoesTab cotacoes={cotacoes} necessidades={necessidades} onChanged={loadAll} />
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
  onCotacaoCreated: (info: { supplier: string; itemCount: number }) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"list" | "upload">("list");
  const [supplier, setSupplier] = useState("");
  const [uploadedItems, setUploadedItems] = useState<Array<{ chavePeca: string; qtde: number; valorUnitario: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [leverage, setLeverage] = useState<LeverageResult | null>(null);
  const [leverageLoading, setLeverageLoading] = useState(false);
  const [detailPart, setDetailPart] = useState<string | null>(null);
  const [detailCases, setDetailCases] = useState<CaseNeedingPart[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function openDetail(chavePeca: string, e: React.MouseEvent) {
    e.stopPropagation();
    setDetailPart(chavePeca);
    setDetailCases(null);
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/necessidades/detail/${encodeURIComponent(chavePeca)}`);
      if (r.ok) setDetailCases(await r.json() as CaseNeedingPart[]);
    } finally { setDetailLoading(false); }
  }

  const fetchLeverage = useCallback(async (parts: string[]) => {
    if (parts.length === 0) { setLeverage(null); return; }
    setLeverageLoading(true);
    try {
      const r = await fetch(`/api/necessidades/leverage?pecas=${encodeURIComponent(parts.join(","))}`);
      if (r.ok) setLeverage(await r.json() as LeverageResult);
    } finally { setLeverageLoading(false); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchLeverage(Array.from(selected)), 300);
    return () => clearTimeout(t);
  }, [selected, fetchLeverage]);

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
    const url = "/api/necessidades/export.xlsx" + (pecas ? `?pecas=${encodeURIComponent(pecas)}` : "");
    window.open(url, "_blank");
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/cotacoes/parse", { method: "POST", body: form });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error ?? "Erro ao ler o arquivo."); }
      const d = await r.json() as { items: Array<{ chavePeca: string; qtde: number; valorUnitario: number }> };
      if (d.items.length === 0) {
        throw new Error("Nenhum item com preço válido encontrado no arquivo. Confira se as colunas PECA, QTDE e VALOR UN foram preenchidas.");
      }
      setUploadedItems(d.items);
      setMode("upload");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
      const info = { supplier: supplier.trim(), itemCount: uploadedItems.length };
      setMode("list"); setSupplier(""); setUploadedItems([]); setSelected(new Set());
      if (fileRef.current) fileRef.current.value = "";
      onCotacaoCreated(info);
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

      {/* Painel de impacto — aparece quando há seleção */}
      {selected.size > 0 && (
        <div style={{
          background: "linear-gradient(135deg, rgba(124,58,237,0.12) 0%, rgba(99,102,241,0.06) 100%)",
          border: "1px solid rgba(124,58,237,0.3)",
          borderRadius: "var(--r-lg)",
          padding: "1rem 1.25rem",
          marginBottom: "0.875rem",
          display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--accent)" }}>
            <Zap size={16} />
            <span style={{ fontWeight: 700, fontSize: "0.82rem" }}>
              {selected.size} peça{selected.size !== 1 ? "s" : ""} selecionada{selected.size !== 1 ? "s"  : ""}
            </span>
          </div>

          <ArrowRight size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />

          {leverageLoading ? (
            <Loader2 size={14} className="spin" style={{ color: "var(--muted)" }} />
          ) : leverage ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.3rem" }}>
                <span style={{ fontSize: "1.5rem", fontWeight: 800, color: leverage.combinedUnblocked > 0 ? "var(--ok-text)" : "var(--muted)", letterSpacing: "-0.03em" }}>
                  {leverage.combinedUnblocked}
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                  aparelh{leverage.combinedUnblocked !== 1 ? "os" : "o"} liberado{leverage.combinedUnblocked !== 1 ? "s" : ""}
                </span>
              </div>

              {leverage.combinedUnblocked > 0 && (
                <>
                  <div style={{ width: 1, height: 32, background: "var(--border)", flexShrink: 0 }} />
                  <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: "0.62rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.15rem" }}>Venda est.</div>
                      <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--info-text)", fontVariantNumeric: "tabular-nums" }}>
                        {leverage.saleReleased != null ? fmtMoney(leverage.saleReleased) : "—"}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.62rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.15rem" }}>Margem liberada</div>
                      <div style={{ fontWeight: 700, fontSize: "0.9rem", color: leverage.marginReleased != null && leverage.marginReleased >= 0 ? "var(--ok-text)" : "var(--err-text)", fontVariantNumeric: "tabular-nums" }}>
                        {leverage.marginReleased != null ? fmtMoney(leverage.marginReleased) : "—"}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {leverage.combinedUnblocked === 0 && (
                <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                  Nenhum aparelho tem <em>todas</em> as peças cobertas por esta seleção
                </span>
              )}
            </>
          ) : null}

          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={() => setSelected(new Set())}>
            <X size={12} /> Limpar
          </button>
        </div>
      )}

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
          <Download size={12} /> Exportar{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
        <label className="btn btn-primary btn-sm" style={{ cursor: "pointer" }}>
          <Upload size={12} /> Importar cotação
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={onFileChange} />
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
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>UNID.</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }} title="Aparelhos que viram MATCH completo comprando só esta peça">APARELHOS</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>VENDA EST.</th>
              <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>MARGEM</th>
              <th style={{ padding: "0.5rem 0.75rem", width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((item, idx) => (
              <tr
                key={item.chavePeca}
                style={{
                  borderBottom: idx < filtered.length - 1 ? "1px solid var(--border)" : "none",
                  cursor: "pointer",
                  background: selected.has(item.chavePeca) ? "rgba(99,102,241,0.06)" : undefined,
                  transition: "background var(--transition)",
                }}
                onClick={() => toggle(item.chavePeca)}
              >
                <td style={{ padding: "0.5rem 1rem" }}>
                  <input type="checkbox" checked={selected.has(item.chavePeca)} onChange={() => toggle(item.chavePeca)} onClick={e => e.stopPropagation()} />
                </td>
                <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.82rem" }}>{item.chavePeca}</td>
                <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{item.qtdeNecessaria}</td>
                <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>
                  <span
                    title={item.casesBlocked > item.fullMatchCount
                      ? `${item.fullMatchCount} fecham sozinho(s) · ${item.casesBlocked} bloqueado(s) no total (outros aguardam mais peças)`
                      : `${item.fullMatchCount} fecham sozinho(s)`}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "0.3rem",
                      fontWeight: 600, color: "var(--accent)", fontVariantNumeric: "tabular-nums",
                    }}>
                    <Zap size={11} style={{ opacity: 0.7 }} />
                    {item.fullMatchCount}
                    {item.casesBlocked > item.fullMatchCount && (
                      <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: "0.72rem" }}>
                        /{item.casesBlocked}
                      </span>
                    )}
                  </span>
                </td>
                <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.8rem", color: "var(--info-text)", fontVariantNumeric: "tabular-nums" }}>
                  {item.saleReleased != null ? fmtMoney(item.saleReleased) : "—"}
                </td>
                <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums",
                  color: item.marginReleased != null && item.marginReleased >= 0 ? "var(--ok-text)" : item.marginReleased != null ? "var(--err-text)" : "var(--muted)" }}>
                  {item.marginReleased != null ? fmtMoney(item.marginReleased) : "—"}
                </td>
                <td style={{ padding: "0.5rem 0.5rem", textAlign: "right" }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0.2rem 0.4rem", opacity: 0.6 }}
                    title="Ver aparelhos bloqueados"
                    onClick={e => openDetail(item.chavePeca, e)}
                  >
                    <Info size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal detalhe de aparelhos bloqueados */}
      {detailPart && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: "1rem",
          }}
          onClick={() => setDetailPart(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 640, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <Zap size={15} style={{ color: "var(--accent)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>Aparelhos bloqueados</div>
                <div style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--text-2)", marginTop: "0.1rem" }}>{detailPart}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setDetailPart(null)}><X size={14} /></button>
            </div>
            <div style={{ overflowY: "auto", flex: 1, padding: "0.75rem 0" }}>
              {detailLoading && (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
                </div>
              )}
              {!detailLoading && detailCases !== null && detailCases.length === 0 && (
                <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  Nenhum aparelho bloqueado nesta peça.
                </div>
              )}
              {!detailLoading && detailCases !== null && detailCases.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                  <thead>
                    <tr style={{ background: "var(--surface-alt)" }}>
                      <th style={{ padding: "0.4rem 1.25rem", textAlign: "left", fontWeight: 600, fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>IMEI</th>
                      <th style={{ padding: "0.4rem 0.75rem", textAlign: "left", fontWeight: 600, fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>APARELHO</th>
                      <th style={{ padding: "0.4rem 0.75rem", textAlign: "right", fontWeight: 600, fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>MARGEM</th>
                      <th style={{ padding: "0.4rem 0.75rem", textAlign: "left", fontWeight: 600, fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>OUTRAS PEÇAS</th>
                      <th style={{ padding: "0.4rem 0.75rem", textAlign: "left", fontWeight: 600, fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>STATUS PREVISTO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailCases.map((c, i) => (
                      <tr key={c.caseId} style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}>
                        <td style={{ padding: "0.5rem 1.25rem", fontFamily: "monospace", fontSize: "0.75rem", color: "var(--text-2)" }}>{c.imei}</td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>{[c.brand, c.model].filter(Boolean).join(" ") || "—"}</td>
                        <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontVariantNumeric: "tabular-nums",
                          color: c.margin != null && c.margin >= 0 ? "var(--ok-text)" : c.margin != null ? "var(--err-text)" : "var(--muted)" }}>
                          {c.margin != null ? fmtMoney(c.margin) : "—"}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          {c.otherPartsNeeded.length === 0
                            ? <span style={{ color: "var(--ok-text)", fontSize: "0.75rem" }}>Nenhuma</span>
                            : <span style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "var(--warn-text)" }}>{c.otherPartsNeeded.join(", ")}</span>
                          }
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          <span style={{
                            display: "inline-flex", alignItems: "center", gap: "0.3rem",
                            fontSize: "0.72rem", fontWeight: 600,
                            color: c.predictedStatus === "MATCH" ? "var(--ok-text)" : "var(--warn-text)",
                          }}>
                            {c.predictedStatus === "MATCH" ? <CheckCircle2 size={11} /> : <ArrowRight size={11} />}
                            {c.predictedStatus === "MATCH" ? "MATCH completo" : "Match parcial"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Cotações pendentes de aprovação
// ---------------------------------------------------------------------------

function CotacoesTab({ cotacoes, necessidades, onChanged }: { cotacoes: Cotacao[]; necessidades: NecessidadeItem[]; onChanged: () => void }) {
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
        necessidades={necessidades}
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

function AprovacaoScreen({ cotacao, necessidades, busy, error, onCancel, onAprovar }: {
  cotacao: Cotacao;
  necessidades: NecessidadeItem[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAprovar: (aprovados: Array<{ id: number; qtde: number; chavePeca: string; valorUnitario: number }>) => Promise<string | null>;
}) {
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set(cotacao.items.map(i => i.id)));
  const [qtdes, setQtdes] = useState<Map<number, number>>(() => new Map(cotacao.items.map(i => [i.id, i.qtde])));
  const [done, setDone] = useState<string | null>(null);
  const [projection, setProjection] = useState<CotacaoProjectionResult | null>(null);
  const [projLoading, setProjLoading] = useState(false);
  const [showProjectedModal, setShowProjectedModal] = useState(false);

  function setQtde(id: number, val: number) {
    setQtdes(m => { const n = new Map(m); n.set(id, Math.max(1, val)); return n; });
  }

  const necMap = useMemo(() => {
    const m = new Map<string, NecessidadeItem>();
    for (const n of necessidades) m.set(n.chavePeca, n);
    return m;
  }, [necessidades]);

  const aprovados = cotacao.items.filter(i => selecionados.has(i.id));
  const total = aprovados.reduce((s, i) => s + (qtdes.get(i.id) ?? i.qtde) * i.valorUnitario, 0);

  // Motor canônico: POST /api/cotacoes/project-match com todos os itens selecionados
  useEffect(() => {
    const selected = cotacao.items
      .filter(i => selecionados.has(i.id))
      .map(i => ({ id: i.id, chavePeca: i.chavePeca, qtde: qtdes.get(i.id) ?? i.qtde, valorUnitario: i.valorUnitario }));
    if (selected.length === 0) { setProjection(null); return; }
    const t = setTimeout(() => {
      setProjLoading(true);
      fetch("/api/cotacoes/project-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: selected }),
      })
        .then(r => r.ok ? r.json() as Promise<CotacaoProjectionResult> : null)
        .then(d => { if (d) setProjection(d); })
        .finally(() => setProjLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [selecionados, qtdes, cotacao.items]);

  // Mapa lineProjections por item.id
  const lineMap = useMemo(() => {
    const m = new Map<number, LineProjection>();
    if (projection) for (const lp of projection.lineProjections) m.set(lp.id, lp);
    return m;
  }, [projection]);

  function toggle(id: number) {
    setSelecionados(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleAprovar() {
    const items = Array.from(selecionados).map(id => {
      const item = cotacao.items.find(i => i.id === id)!;
      return { id, qtde: qtdes.get(id) ?? item.qtde, chavePeca: item.chavePeca, valorUnitario: item.valorUnitario };
    });
    const orderNumber = await onAprovar(items);
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

  const incr = projection?.incrementalFullMatches ?? 0;
  const proj = projection?.projectedFullMatches ?? 0;
  const base = projection?.baselineFullMatches ?? 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}><X size={12} /> Voltar</button>
        <div>
          <div style={{ fontWeight: 600 }}>Aprovar cotação — {cotacao.supplier}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Desmarque ou ajuste as quantidades. O motor recalcula ao vivo.</div>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Barra de projeção canônica */}
      {aprovados.length > 0 && (
        <div style={{
          background: "linear-gradient(135deg, rgba(124,58,237,0.12) 0%, rgba(99,102,241,0.06) 100%)",
          border: "1px solid rgba(124,58,237,0.3)",
          borderRadius: "var(--r-lg)",
          padding: "0.75rem 1.25rem",
          marginBottom: "0.875rem",
          display: "flex", alignItems: "center", gap: "1.25rem", flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "var(--accent)" }}>
            <Zap size={14} />
            <span style={{ fontWeight: 700, fontSize: "0.8rem" }}>Projeção canônica</span>
          </div>

          {projLoading ? (
            <Loader2 size={14} className="spin" style={{ color: "var(--muted)" }} />
          ) : (
            <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-start" }}>
              {/* Incremento de matches */}
              <div>
                <div style={{ fontSize: "0.6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Novos matches</div>
                <div style={{ fontWeight: 800, fontSize: "1.1rem", letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums",
                  color: incr > 0 ? "var(--ok-text)" : "var(--muted)" }}>
                  +{incr}
                </div>
                <div style={{ fontSize: "0.6rem", color: "var(--muted)", marginTop: "0.1rem" }}>
                  {base} → {proj} aparelhos
                </div>
              </div>

              {projection && (
                <>
                  <div style={{ width: 1, background: "var(--border)", alignSelf: "stretch" }} />
                  <div>
                    <div style={{ fontSize: "0.6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Venda incremental</div>
                    <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--info-text)", fontVariantNumeric: "tabular-nums" }}>
                      {projection.incrementalRevenue != null ? fmtMoney(projection.incrementalRevenue) : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Margem incremental</div>
                    <div style={{ fontWeight: 700, fontSize: "0.9rem", fontVariantNumeric: "tabular-nums",
                      color: (projection.incrementalMargin ?? 0) >= 0 ? "var(--ok-text)" : "var(--err-text)" }}>
                      {projection.incrementalMargin != null ? fmtMoney(projection.incrementalMargin) : "—"}
                    </div>
                  </div>
                  <div style={{ width: 1, background: "var(--border)", alignSelf: "stretch" }} />
                  <div>
                    <div style={{ fontSize: "0.6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Custo do pedido</div>
                    <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>
                      {fmtMoney(total)}
                    </div>
                  </div>
                  {projection.marginToCostRatio != null && (
                    <div>
                      <div style={{ fontSize: "0.6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Retorno/custo</div>
                      <div style={{ fontWeight: 700, fontSize: "0.9rem", fontVariantNumeric: "tabular-nums",
                        color: projection.marginToCostRatio >= 1 ? "var(--ok-text)" : projection.marginToCostRatio >= 0.5 ? "var(--warn-text)" : "var(--err-text)" }}>
                        {projection.marginToCostRatio.toFixed(1)}×
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {projection && incr > 0 && (
            <>
              <span style={{ flex: 1 }} />
              <button
                className="btn btn-ghost btn-sm"
                style={{ flexShrink: 0, fontSize: "0.78rem" }}
                onClick={() => setShowProjectedModal(true)}
              >
                <ArrowRight size={12} /> Ver {proj} aparelhos
              </button>
            </>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1rem" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr style={{ background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "0.5rem 1rem", width: 36 }}></th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>PEÇA</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>QTDE</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>VALOR UN</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>TOTAL</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }} title="Matches isolados por peça (motor histórico)">MATCH ×1</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--accent)", letterSpacing: "0.04em" }} title="Quantos matches a mais se remover esta linha da seleção — impacto marginal canônico">⚡ MARGINAL</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>VENDA EST.</th>
                <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>MARGEM</th>
              </tr>
            </thead>
            <tbody>
              {cotacao.items.map((item, idx) => {
                const checked = selecionados.has(item.id);
                const nec = necMap.get(item.chavePeca);
                const lp = lineMap.get(item.id);
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
                    <td style={{ padding: "0.25rem 0.5rem", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.25rem" }}>
                        {checked && item.qtde > 1 && (qtdes.get(item.id) ?? item.qtde) < item.qtde && (
                          <span style={{ fontSize: "0.65rem", color: "var(--warn-text)", whiteSpace: "nowrap" }} title={`Cotado: ${item.qtde}`}>
                            /{item.qtde}
                          </span>
                        )}
                        <input
                          type="number" min={1} max={item.qtde}
                          value={qtdes.get(item.id) ?? item.qtde}
                          disabled={!checked}
                          onChange={e => setQtde(item.id, Number(e.target.value))}
                          style={{
                            width: 56, textAlign: "right", padding: "0.2rem 0.35rem",
                            fontSize: "0.82rem", fontVariantNumeric: "tabular-nums",
                            border: checked && (qtdes.get(item.id) ?? item.qtde) < item.qtde
                              ? "1px solid var(--warn-text)" : "1px solid var(--border)",
                            borderRadius: "var(--radius)", background: "var(--surface)",
                            color: "var(--text)", opacity: checked ? 1 : 0.5,
                          }}
                        />
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>{fmtMoney(item.valorUnitario)}</td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>{fmtMoney((qtdes.get(item.id) ?? item.qtde) * item.valorUnitario)}</td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>
                      {nec ? (
                        <span style={{ fontWeight: 600, color: nec.fullMatchCount > 0 ? "var(--ok-text)" : "var(--muted)", fontVariantNumeric: "tabular-nums", fontSize: "0.82rem" }}>
                          {nec.fullMatchCount}
                        </span>
                      ) : <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>
                      {checked && lp ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem",
                          fontWeight: 700, fontSize: "0.85rem", fontVariantNumeric: "tabular-nums",
                          color: lp.marginalFullMatches > 0 ? "var(--accent)" : "var(--muted)" }}
                          title={`Esta linha contribui com +${lp.marginalFullMatches} matches no cenário combinado`}>
                          {lp.marginalFullMatches > 0 && <Zap size={10} />}
                          +{lp.marginalFullMatches}
                        </span>
                      ) : projLoading && checked ? (
                        <Loader2 size={12} className="spin" style={{ color: "var(--muted)" }} />
                      ) : <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.8rem", color: "var(--info-text)", fontVariantNumeric: "tabular-nums" }}>
                      {nec?.saleReleased != null ? fmtMoney(nec.saleReleased) : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums",
                      color: nec?.marginReleased != null && nec.marginReleased >= 0 ? "var(--ok-text)" : nec?.marginReleased != null ? "var(--err-text)" : undefined }}>
                      {nec?.marginReleased != null ? fmtMoney(nec.marginReleased) : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid var(--border)" }}>
                <td colSpan={2} style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontWeight: 600, fontSize: "0.85rem" }}>
                  {aprovados.length} iten{aprovados.length !== 1 ? "s" : ""} selecionado{aprovados.length !== 1 ? "s" : ""}
                </td>
                <td style={{ padding: "0.625rem 0.5rem", textAlign: "right", fontWeight: 600, fontSize: "0.82rem", fontVariantNumeric: "tabular-nums", color: "var(--text-muted)" }}>
                  {aprovados.reduce((s, i) => s + (qtdes.get(i.id) ?? i.qtde), 0)} un
                </td>
                <td />
                <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontWeight: 700, color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>
                  {fmtMoney(total)}
                </td>
                <td />
                <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontWeight: 700, color: incr > 0 ? "var(--ok-text)" : "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                  {projLoading ? <Loader2 size={12} className="spin" /> : `+${incr}`}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
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

      {/* Modal: aparelhos projetados */}
      {showProjectedModal && projection && (
        <ProjectedCasesModal
          projection={projection}
          onClose={() => setShowProjectedModal(false)}
        />
      )}
    </div>
  );
}

function ProjectedCasesModal({ projection, onClose }: { projection: CotacaoProjectionResult; onClose: () => void }) {
  const incremental = projection.projectedCases.filter(c => c.isIncremental);
  const existing = projection.projectedCases.filter(c => !c.isIncremental);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: 700, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <Zap size={15} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>
              Aparelhos com match no cenário projetado
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>
              Base: {projection.baselineFullMatches} · Projetado: {projection.projectedFullMatches} · <span style={{ color: "var(--ok-text)", fontWeight: 600 }}>+{projection.incrementalFullMatches} novos</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {incremental.length > 0 && (
            <>
              <div style={{ padding: "0.625rem 1.25rem 0.25rem", fontSize: "0.7rem", fontWeight: 700, color: "var(--ok-text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Novos matches — gerados por esta compra ({incremental.length})
              </div>
              <CaseTable cases={incremental} />
            </>
          )}
          {existing.length > 0 && (
            <>
              <div style={{ padding: "0.625rem 1.25rem 0.25rem", fontSize: "0.7rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", borderTop: incremental.length > 0 ? "1px solid var(--border)" : undefined, marginTop: incremental.length > 0 ? "0.5rem" : undefined }}>
                Já em match na baseline ({existing.length})
              </div>
              <CaseTable cases={existing} muted />
            </>
          )}
        </div>

        <div style={{ padding: "0.75rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
          <span>
            Venda projetada: <strong style={{ color: "var(--info-text)" }}>{projection.projectedRevenue != null ? fmtMoney(projection.projectedRevenue) : "—"}</strong>
            {" · "}
            Margem projetada: <strong style={{ color: "var(--ok-text)" }}>{projection.projectedMargin != null ? fmtMoney(projection.projectedMargin) : "—"}</strong>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

function CaseTable({ cases, muted }: { cases: ProjectedCase[]; muted?: boolean }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", opacity: muted ? 0.65 : 1 }}>
      <tbody>
        {cases.map((c, i) => (
          <tr key={c.caseId} style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}>
            <td style={{ padding: "0.45rem 1.25rem", fontFamily: "monospace", fontSize: "0.75rem", color: "var(--text-2)", width: 140 }}>
              {c.imei ?? `#${c.caseId}`}
            </td>
            <td style={{ padding: "0.45rem 0.75rem" }}>{c.model ?? "—"}</td>
            <td style={{ padding: "0.45rem 0.75rem", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--info-text)" }}>
              {c.estimatedSale != null ? fmtMoney(c.estimatedSale) : "—"}
            </td>
            <td style={{ padding: "0.45rem 1.25rem 0.45rem 0.75rem", textAlign: "right", fontVariantNumeric: "tabular-nums",
              color: c.margin != null && c.margin >= 0 ? "var(--ok-text)" : c.margin != null ? "var(--err-text)" : "var(--muted)" }}>
              {c.margin != null ? fmtMoney(c.margin) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
