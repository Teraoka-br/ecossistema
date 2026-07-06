import { useState, useEffect, useCallback } from "react";
import {
  Clock, Wrench, Package, AlertTriangle, CheckCircle2, ChevronRight,
  Star, RefreshCw, X, UserCheck, Loader2,
  PackageCheck, ShoppingBag, Eye, Boxes,
} from "lucide-react";
import { RepairDrawer } from "../components/RepairDrawer.js";
import { useAuth } from "../auth.js";

type QueueFilter =
  | "DO_NOW" | "MATCH" | "MATCH_PARCIAL" | "AGUARDANDO_PECAS"
  | "APTO_REPARO" | "EM_ANALISE" | "VERIFICAR" | "FINALIZADOS" | "TODOS";

interface NextAction {
  code: string;
  label: string;
  description: string;
  enabled: boolean;
  requiredRole: "OPERATOR" | "ADMIN" | "ANY";
}

interface QueueItem {
  id: number;
  imei: string | null;
  os: string | null;
  brand: string | null;
  model: string | null;
  capacity: string | null;
  color: string | null;
  repairDate: string | null;
  ageDays: number | null;
  workflowStatus: string;
  analysisStatus: string;
  manualPriorityActive: boolean;
  assignedTechnicianId: number | null;
  directedTechnicianId: number | null;
  totalParts: number;
  matchedParts: number;
  reservedCount: number;
  nextAction: NextAction;
  createdAt: string;
  updatedAt: string;
}

interface EngineState {
  status: "IDLE" | "RUNNING" | "STALE" | "FAILED";
  lastRunId: number | null;
  staleSince: string | null;
  lastError: string | null;
  updatedAt: string;
}

const FILTER_LABELS: Record<QueueFilter, string> = {
  DO_NOW: "Fazer agora",
  MATCH: "Match completo",
  MATCH_PARCIAL: "Match parcial",
  AGUARDANDO_PECAS: "Aguardando peças",
  APTO_REPARO: "Apto para reparo",
  EM_ANALISE: "Em análise",
  VERIFICAR: "Verificar",
  FINALIZADOS: "Finalizados",
  TODOS: "Todos",
};

const FILTER_ICONS: Partial<Record<QueueFilter, React.ReactNode>> = {
  DO_NOW: <Star size={11} />,
  MATCH: <CheckCircle2 size={11} />,
  VERIFICAR: <AlertTriangle size={11} />,
  FINALIZADOS: <CheckCircle2 size={11} />,
};

function statusMeta(s: string): { label: string; color: string; bg: string; icon: React.ReactNode } {
  switch (s) {
    case "MATCH":           return { label: "Match",            color: "var(--ok-text)",      bg: "var(--ok-dim)",     icon: <CheckCircle2 size={11} /> };
    case "MATCH_PARCIAL":   return { label: "Match parcial",    color: "var(--warn-text)",     bg: "var(--warn-dim)",   icon: <PackageCheck size={11} /> };
    case "APTO_REPARO":     return { label: "Apto reparo",      color: "var(--accent)",        bg: "var(--accent-dim)", icon: <Wrench size={11} /> };
    case "EM_SEPARACAO":    return { label: "Em separação",     color: "var(--info-text)",     bg: "var(--info-dim)",   icon: <Package size={11} /> };
    case "PEDIR_PECA":      return { label: "Pedir peça",       color: "var(--text-muted)",    bg: "var(--elevated)",   icon: <ShoppingBag size={11} /> };
    case "AGUARDANDO_RECEBIMENTO": return { label: "Aguardando", color: "var(--text-muted)",  bg: "var(--elevated)",   icon: <Clock size={11} /> };
    case "EM_ANALISE":      return { label: "Em análise",       color: "var(--text-muted)",    bg: "var(--elevated)",   icon: <Clock size={11} /> };
    case "VERIFICAR":       return { label: "Verificar",        color: "var(--err-text)",      bg: "var(--err-dim)",    icon: <AlertTriangle size={11} /> };
    case "DIRECIONADO_TECNICO": return { label: "Com técnico",  color: "var(--accent)",        bg: "var(--accent-dim)", icon: <UserCheck size={11} /> };
    case "EM_REPARO":       return { label: "Em reparo",        color: "var(--accent)",        bg: "var(--accent-dim)", icon: <Wrench size={11} /> };
    case "REPARO_EXECUTADO": return { label: "Executado",       color: "var(--ok-text)",       bg: "var(--ok-dim)",     icon: <CheckCircle2 size={11} /> };
    case "TRIAGEM_FINAL":   return { label: "Triagem final",    color: "var(--info-text)",     bg: "var(--info-dim)",   icon: <Eye size={11} /> };
    case "CONCLUIDO":       return { label: "Concluído",        color: "var(--ok-text)",       bg: "var(--ok-dim)",     icon: <CheckCircle2 size={11} /> };
    case "CANCELADO":       return { label: "Cancelado",        color: "var(--err-text)",      bg: "var(--err-dim)",    icon: <X size={11} /> };
    default:                return { label: s,                  color: "var(--text-muted)",    bg: "var(--elevated)",   icon: null };
  }
}

function EngineStatusBar({ state, pending, onRun }: { state: EngineState | null; pending: number; onRun: () => void }) {
  const { user } = useAuth();
  if (!state) return null;

  const isRunning = state.status === "RUNNING";
  const statusColor = state.status === "IDLE" ? "var(--ok-text)"
    : state.status === "RUNNING" ? "var(--accent)"
    : state.status === "STALE" ? "var(--warn-text)"
    : "var(--err-text)";
  const statusText = state.status === "IDLE" ? "Motor atualizado"
    : isRunning ? "Recalculando…"
    : state.status === "STALE" ? "Desatualizado"
    : "Falha no motor";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.5rem",
      fontSize: "0.73rem", color: "var(--text-muted)",
      background: "var(--surface-alt)", border: "1px solid var(--border)",
      borderRadius: "var(--r-sm)", padding: "0.3rem 0.75rem",
    }}>
      {isRunning
        ? <Loader2 size={11} className="spin" style={{ color: statusColor }} />
        : <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, display: "inline-block" }} />
      }
      <span style={{ color: statusColor, fontWeight: 600 }}>{statusText}</span>
      {pending > 0 && <span>· {pending} pendente{pending > 1 ? "s" : ""}</span>}
      {user?.role === "ADMIN" && !isRunning && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ padding: "2px 6px", marginLeft: 2 }}
          onClick={onRun}
          title="Executar motor manualmente"
        >
          <RefreshCw size={11} />
        </button>
      )}
    </div>
  );
}

function RepairCard({ item, onClick }: { item: QueueItem; onClick: () => void }) {
  const meta = statusMeta(item.workflowStatus);
  const modelStr = [item.brand, item.model, item.capacity].filter(Boolean).join(" ");
  const matchPct = item.totalParts > 0 ? Math.round((item.matchedParts / item.totalParts) * 100) : 0;

  return (
    <button
      className="repair-card"
      onClick={onClick}
      style={{ textAlign: "left", width: "100%", background: "none", font: "inherit" }}
    >
      <div className="repair-card-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flex: 1, minWidth: 0 }}>
          {item.manualPriorityActive && (
            <Star size={11} style={{ color: "var(--warn-text)", flexShrink: 0 }} fill="currentColor" />
          )}
          <span className="repair-card-model">{modelStr || "Modelo não identificado"}</span>
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "0.25rem",
          padding: "0.18rem 0.5rem", borderRadius: "var(--r-sm)",
          background: meta.bg, color: meta.color,
          fontSize: "0.68rem", fontWeight: 700, whiteSpace: "nowrap",
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>
          {meta.icon}{meta.label}
        </div>
      </div>

      <div className="repair-card-meta">
        {item.color && <span style={{ color: "var(--text-secondary)" }}>{item.color}</span>}
        {item.imei && <span className="repair-card-imei" title="IMEI">···{item.imei.slice(-6)}</span>}
        {item.os && <span>OS {item.os}</span>}
        {item.ageDays != null && (
          <span style={{ color: item.ageDays > 30 ? "var(--warn-text)" : "var(--text-muted)" }}>
            {item.ageDays}d
          </span>
        )}
      </div>

      {item.totalParts > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <div style={{ flex: 1, height: 3, background: "var(--elevated)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${matchPct}%`,
              background: matchPct === 100 ? "var(--ok)" : matchPct > 50 ? "var(--warn)" : "var(--accent)",
              borderRadius: 2, transition: "width 0.3s ease",
            }} />
          </div>
          <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {item.matchedParts}/{item.totalParts} peças
            {item.reservedCount > 0 && ` · ${item.reservedCount}↓`}
          </span>
        </div>
      )}

      <div className="repair-card-action">
        <span>{item.nextAction.label}</span>
        <ChevronRight size={13} />
      </div>
    </button>
  );
}

export function FilaReparos() {
  const [filter, setFilter] = useState<QueueFilter>("DO_NOW");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [pending, setPending] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { user } = useAuth();

  const LIMIT = 30;

  const loadEngine = useCallback(async () => {
    try {
      const r = await fetch("/api/engine/state");
      if (r.ok) {
        const data = await r.json() as { state: EngineState; pending: number };
        setEngineState(data.state);
        setPending(data.pending);
      }
    } catch { /* ignore */ }
  }, []);

  // Debounce search input → q
  useEffect(() => {
    const t = setTimeout(() => { setQ(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ filter, page: String(page), limit: String(LIMIT) });
      if (q) qs.set("q", q);
      const r = await fetch(`/api/fila-reparos?${qs.toString()}`);
      if (r.ok) {
        const data = await r.json() as { items: QueueItem[]; total: number };
        setItems(data.items);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [filter, page, q]);

  useEffect(() => {
    void loadItems();
    void loadEngine();
  }, [loadItems, loadEngine]);

  useEffect(() => {
    if (!engineState || (engineState.status !== "RUNNING" && engineState.status !== "STALE")) return;
    const t = setInterval(() => void loadEngine(), 3000);
    return () => clearInterval(t);
  }, [engineState, loadEngine]);

  async function runEngine() {
    await fetch("/api/engine/run", { method: "POST" });
    void loadEngine();
    setTimeout(() => { void loadItems(); void loadEngine(); }, 2000);
  }

  function handleDrawerClose(refresh: boolean) {
    setSelectedId(null);
    if (refresh) void loadItems();
  }

  const totalPages = Math.ceil(total / LIMIT);

  // KPIs a partir dos items visíveis
  const kpiMatch    = items.filter(i => i.workflowStatus === "MATCH").length;
  const kpiVerif    = items.filter(i => i.workflowStatus === "VERIFICAR").length;
  const kpiPriority = items.filter(i => i.manualPriorityActive).length;

  return (
    <div className="page-container">
      {/* Cabeçalho */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Fila de Reparos</h1>
          <p className="page-subtitle">
            {total} aparelho{total !== 1 ? "s" : ""} na fila
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginLeft: "auto" }}>
          <EngineStatusBar state={engineState} pending={pending} onRun={runEngine} />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { void loadItems(); void loadEngine(); }}
            title="Atualizar"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* KPI bar — só quando tem dados */}
      {!loading && total > 0 && (
        <div className="kpi-bar">
          <div className="kpi-card">
            <div className="kpi-label">Total</div>
            <div className="kpi-value">{total}</div>
            <div className="kpi-sub">aparelhos</div>
          </div>
          {kpiMatch > 0 && (
            <div className="kpi-card" style={{ borderColor: "rgba(16,185,129,0.3)" }}>
              <div className="kpi-label" style={{ color: "var(--ok-text)" }}>Match completo</div>
              <div className="kpi-value" style={{ color: "var(--ok-text)" }}>{kpiMatch}</div>
              <div className="kpi-sub">prontos para separar</div>
            </div>
          )}
          {kpiVerif > 0 && (
            <div className="kpi-card" style={{ borderColor: "rgba(239,68,68,0.3)" }}>
              <div className="kpi-label" style={{ color: "var(--err-text)" }}>Verificar</div>
              <div className="kpi-value" style={{ color: "var(--err-text)" }}>{kpiVerif}</div>
              <div className="kpi-sub">precisam atenção</div>
            </div>
          )}
          {kpiPriority > 0 && (
            <div className="kpi-card" style={{ borderColor: "rgba(245,158,11,0.3)" }}>
              <div className="kpi-label" style={{ color: "var(--warn-text)" }}>
                <Star size={10} style={{ display: "inline", marginRight: 3 }} fill="currentColor" />
                Prioritários
              </div>
              <div className="kpi-value" style={{ color: "var(--warn-text)" }}>{kpiPriority}</div>
              <div className="kpi-sub">prioridade manual</div>
            </div>
          )}
        </div>
      )}

      {/* Busca */}
      <div className="search-bar" style={{ marginBottom: "0.75rem" }}>
        <input
          type="search"
          placeholder="Buscar por IMEI, OS, marca, modelo, peça, depósito…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          style={{ width: "100%", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: "0.875rem" }}
        />
      </div>

      {/* Filtros */}
      <div className="filter-bar">
        {(Object.keys(FILTER_LABELS) as QueueFilter[]).map((f) => (
          <button
            key={f}
            className={`filter-chip${filter === f ? " active" : ""}`}
            onClick={() => { setFilter(f); setPage(1); }}
          >
            {FILTER_ICONS[f]}
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Conteúdo */}
      {loading ? (
        <div className="loading-state">
          <Loader2 size={18} className="spin" /> Carregando fila…
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <Boxes size={40} style={{ opacity: 0.25 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Nenhum aparelho nesta fila</div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              {filter === "DO_NOW" ? "Todos os aparelhos estão em dia." : `Sem itens no filtro "${FILTER_LABELS[filter]}".`}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="repair-grid">
            {items.map((item) => (
              <RepairCard key={item.id} item={item} onClick={() => setSelectedId(item.id)} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ← Anterior
              </button>
              <span className="page-info">{page} / {totalPages}</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Próxima →
              </button>
            </div>
          )}
        </>
      )}

      {selectedId !== null && (
        <RepairDrawer
          repairCaseId={selectedId}
          onClose={handleDrawerClose}
          userRole={user?.role ?? "OPERATOR"}
        />
      )}
    </div>
  );
}
