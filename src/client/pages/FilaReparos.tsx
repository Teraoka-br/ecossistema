import { useState, useEffect, useCallback } from "react";
import {
  Clock, Wrench, Package, AlertTriangle, CheckCircle2, ChevronRight,
  Star, RefreshCw, X, UserCheck, Loader2,
  PackageCheck, ShoppingBag, Eye,
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
  MATCH: "Match",
  MATCH_PARCIAL: "Match parcial",
  AGUARDANDO_PECAS: "Aguardando peças",
  APTO_REPARO: "Apto para reparo",
  EM_ANALISE: "Em análise",
  VERIFICAR: "Verificar",
  FINALIZADOS: "Finalizados",
  TODOS: "Todos",
};

function statusMeta(s: string): { label: string; color: string; icon: React.ReactNode } {
  switch (s) {
    case "MATCH":           return { label: "Match",             color: "var(--success)",  icon: <CheckCircle2 size={12} /> };
    case "MATCH_PARCIAL":   return { label: "Match parcial",     color: "var(--warning)",  icon: <PackageCheck size={12} /> };
    case "APTO_REPARO":     return { label: "Apto para reparo",  color: "var(--accent)",   icon: <Wrench size={12} /> };
    case "EM_SEPARACAO":    return { label: "Em separação",      color: "var(--info)",     icon: <Package size={12} /> };
    case "PEDIR_PECA":      return { label: "Pedir peça",        color: "var(--muted)",    icon: <ShoppingBag size={12} /> };
    case "AGUARDANDO_RECEBIMENTO": return { label: "Aguardando",color: "var(--muted)",    icon: <Clock size={12} /> };
    case "EM_ANALISE":      return { label: "Em análise",        color: "var(--muted)",    icon: <Clock size={12} /> };
    case "VERIFICAR":       return { label: "Verificar",         color: "var(--danger)",   icon: <AlertTriangle size={12} /> };
    case "DIRECIONADO_TECNICO": return { label: "Com técnico",   color: "var(--accent)",   icon: <UserCheck size={12} /> };
    case "EM_REPARO":       return { label: "Em reparo",         color: "var(--accent)",   icon: <Wrench size={12} /> };
    case "REPARO_EXECUTADO": return { label: "Reparo executado", color: "var(--success)",  icon: <CheckCircle2 size={12} /> };
    case "TRIAGEM_FINAL":   return { label: "Triagem final",     color: "var(--info)",     icon: <Eye size={12} /> };
    case "CONCLUIDO":       return { label: "Concluído",         color: "var(--success)",  icon: <CheckCircle2 size={12} /> };
    case "CANCELADO":       return { label: "Cancelado",         color: "var(--danger)",   icon: <X size={12} /> };
    default:                return { label: s,                   color: "var(--muted)",    icon: null };
  }
}

function EngineStatusBar({ state, pending, onRun }: { state: EngineState | null; pending: number; onRun: () => void }) {
  const { user } = useAuth();
  if (!state) return null;

  const statusText = state.status === "IDLE" ? "Atualizado"
    : state.status === "RUNNING" ? "Recalculando…"
    : state.status === "STALE" ? "Desatualizado"
    : "Falha no motor";

  const statusColor = state.status === "IDLE" ? "var(--success)"
    : state.status === "RUNNING" ? "var(--accent)"
    : state.status === "STALE" ? "var(--warning)"
    : "var(--danger)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.75rem", color: "var(--muted)" }}>
      {state.status === "RUNNING" && <Loader2 size={12} className="spin" />}
      <span style={{ color: statusColor, fontWeight: 500 }}>{statusText}</span>
      {pending > 0 && <span>({pending} pendente{pending > 1 ? "s" : ""})</span>}
      {user?.role === "ADMIN" && state.status !== "RUNNING" && (
        <button className="btn-ghost-sm" onClick={onRun} title="Executar motor manualmente">
          <RefreshCw size={12} />
        </button>
      )}
    </div>
  );
}

function RepairCard({ item, onClick }: { item: QueueItem; onClick: () => void }) {
  const meta = statusMeta(item.workflowStatus);
  const modelStr = [item.model, item.capacity].filter(Boolean).join(" ");

  return (
    <button
      className="repair-card"
      onClick={onClick}
      style={{ textAlign: "left", width: "100%" }}
    >
      <div className="repair-card-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1, minWidth: 0 }}>
          {item.manualPriorityActive && (
            <Star size={12} style={{ color: "var(--warning)", flexShrink: 0 }} fill="currentColor" />
          )}
          <span className="repair-card-model">{modelStr || "Modelo não identificado"}</span>
          {item.color && <span className="repair-card-sub">{item.color}</span>}
        </div>
        <div className="status-chip" style={{ "--chip-color": meta.color } as React.CSSProperties}>
          {meta.icon}
          {meta.label}
        </div>
      </div>

      <div className="repair-card-meta">
        {item.imei && <span className="repair-card-imei">IMEI {item.imei}</span>}
        {item.os && <span>OS {item.os}</span>}
        {item.repairDate && <span>{item.repairDate}</span>}
        {item.ageDays != null && <span>{item.ageDays}d</span>}
      </div>

      <div className="repair-card-parts">
        <Package size={11} />
        <span>
          {item.matchedParts}/{item.totalParts} peças
          {item.reservedCount > 0 && ` · ${item.reservedCount} reservada${item.reservedCount > 1 ? "s" : ""}`}
        </span>
      </div>

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

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/fila-reparos?filter=${filter}&page=${page}&limit=${LIMIT}`);
      if (r.ok) {
        const data = await r.json() as { items: QueueItem[]; total: number };
        setItems(data.items);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    void loadItems();
    void loadEngine();
  }, [loadItems, loadEngine]);

  // Poll engine state when running or stale
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

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Fila de Reparos</h1>
          <p className="page-subtitle">{total} aparelho{total !== 1 ? "s" : ""}</p>
        </div>
        <EngineStatusBar state={engineState} pending={pending} onRun={runEngine} />
      </div>

      {/* Filtros */}
      <div className="filter-bar">
        {(Object.keys(FILTER_LABELS) as QueueFilter[]).map((f) => (
          <button
            key={f}
            className={`filter-chip ${filter === f ? "active" : ""}`}
            onClick={() => { setFilter(f); setPage(1); }}
          >
            {f === "VERIFICAR" && <AlertTriangle size={11} />}
            {f === "MATCH" && <CheckCircle2 size={11} />}
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Grid de cards */}
      {loading ? (
        <div className="loading-state"><Loader2 size={20} className="spin" /> Carregando…</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2 size={40} />
          <p>Nenhum aparelho nesta fila.</p>
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
              <button className="btn-ghost-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
                Anterior
              </button>
              <span className="page-info">{page} / {totalPages}</span>
              <button className="btn-ghost-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                Próxima
              </button>
            </div>
          )}
        </>
      )}

      {/* Drawer lateral */}
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
