import { useState, useEffect, useCallback, useRef } from "react";
import {
  Clock, Wrench, Package, AlertTriangle, CheckCircle2, ChevronRight,
  Star, RefreshCw, X, UserCheck, Loader2,
  PackageCheck, ShoppingBag, Eye, Boxes, Download, XCircle, MapPin,
  CheckCheck, Ban, Tag, Save, SendToBack,
} from "lucide-react";
import { RepairDrawer } from "../components/RepairDrawer.js";
import { useAuth } from "../auth.js";

type QueueFilter =
  | "DO_NOW" | "MATCH" | "MATCH_PARCIAL" | "AGUARDANDO_PECAS"
  | "COM_TECNICO" | "EM_ANALISE" | "VERIFICAR" | "VENDA_ESTADO"
  | "FINALIZADOS" | "TODOS";

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
  depositoAtual: string | null;
  problema: string | null;
  nextAction: NextAction;
  createdAt: string;
  updatedAt: string;
  margin: number | null;
  creationSource: "IMPORT" | "MANUAL" | "DATASYS";
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
  COM_TECNICO: "Com Técnico",
  EM_ANALISE: "Em análise",
  VERIFICAR: "Verificar",
  VENDA_ESTADO: "Venda no Estado",
  FINALIZADOS: "Finalizados",
  TODOS: "Todos",
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
          style={{ padding: "2px 6px", marginLeft: 2, fontSize: "0.68rem" }}
          onClick={onRun}
          title="Executar motor manualmente"
        >
          Recalcular
        </button>
      )}
    </div>
  );
}

function RepairCard({
  item,
  selected,
  onToggle,
  onClick,
  depositoMap,
}: {
  item: QueueItem;
  selected: boolean;
  onToggle: () => void;
  onClick: () => void;
  depositoMap: Record<string, string>;
}) {
  const meta = statusMeta(item.workflowStatus);
  const modelStr = [item.brand, item.model, item.capacity, item.color].filter(Boolean).join(" · ");
  const tecnico = item.depositoAtual ? (depositoMap[item.depositoAtual] ?? null) : null;
  const deposito = item.depositoAtual;
  const matchPct = item.totalParts > 0 ? Math.round((item.matchedParts / item.totalParts) * 100) : 0;
  const isOld = (item.ageDays ?? 0) > 30;

  return (
    <button
      className="repair-card"
      onClick={onClick}
      style={{
        textAlign: "left", width: "100%", background: "none", font: "inherit",
        borderLeft: `3px solid ${meta.color}`, borderTop: "none",
        outline: selected ? `2px solid var(--accent)` : undefined,
        outlineOffset: selected ? "-2px" : undefined,
        padding: "0.875rem 1rem",
      }}
    >
      {/* Linha 1: checkbox + modelo + badge status */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <span
          role="checkbox"
          aria-checked={selected}
          onClick={e => { e.stopPropagation(); onToggle(); }}
          style={{
            flexShrink: 0, marginTop: 2,
            width: 15, height: 15, borderRadius: 3,
            border: selected ? "2px solid var(--accent)" : "2px solid rgba(255,255,255,0.2)",
            background: selected ? "var(--accent)" : "transparent",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", transition: "all 0.15s",
          }}
        >
          {selected && (
            <svg width="8" height="8" viewBox="0 0 9 9" fill="none">
              <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.18rem" }}>
            {item.manualPriorityActive && <Star size={10} style={{ color: "var(--warn-text)", flexShrink: 0 }} fill="currentColor" />}
            <span style={{ fontWeight: 600, fontSize: "0.88rem", lineHeight: 1.3, color: "var(--text)" }}>
              {modelStr || "Modelo não identificado"}
            </span>
          </div>
          {/* IMEI + OS + idade + origem */}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.73rem", color: "var(--text-muted)" }}>
            {item.imei && (
              <span style={{ fontFamily: "monospace", letterSpacing: "0.02em" }} title="IMEI completo">
                {item.imei}
              </span>
            )}
            {item.os && <span>OS {item.os}</span>}
            {item.ageDays != null && (
              <span style={{ color: isOld ? "var(--warn-text)" : "var(--text-muted)", fontWeight: isOld ? 600 : 400 }}>
                {item.ageDays}d
              </span>
            )}
            {item.creationSource === "MANUAL" && (
              <span style={{ color: "var(--info-text)", fontSize: "0.67rem", fontWeight: 600 }} title={`Criado em ${new Date(item.createdAt).toLocaleDateString("pt-BR")}`}>
                Manual
              </span>
            )}
            {item.creationSource === "DATASYS" && (
              <span style={{ color: "var(--purple-text)", fontSize: "0.67rem", fontWeight: 600 }}>
                Datasys
              </span>
            )}
          </div>
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "0.25rem",
          padding: "0.2rem 0.55rem", borderRadius: "var(--r-sm)",
          background: meta.bg, color: meta.color,
          fontSize: "0.67rem", fontWeight: 700, whiteSpace: "nowrap",
          textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0,
        }}>
          {meta.icon}{meta.label}
        </div>
      </div>

      {/* Depósito / Técnico */}
      {(tecnico || deposito) && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem",
          fontSize: "0.72rem", marginBottom: "0.35rem" }}>
          <MapPin size={10} style={{ flexShrink: 0, color: tecnico ? "var(--accent)" : "var(--text-muted)" }} />
          {tecnico
            ? <span style={{ color: "var(--accent)", fontWeight: 600 }}>{tecnico}</span>
            : <span style={{ color: "var(--text-muted)" }}>{deposito}</span>
          }
          {tecnico && deposito && deposito !== tecnico && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.68rem" }}>· {deposito}</span>
          )}
        </div>
      )}

      {/* Barra de match */}
      {item.totalParts > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
          <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${matchPct}%`,
              background: matchPct === 100
                ? "linear-gradient(90deg, var(--ok), #34d399)"
                : matchPct > 50
                  ? "linear-gradient(90deg, var(--warn), #fbbf24)"
                  : "linear-gradient(90deg, var(--accent), #8b5cf6)",
              borderRadius: 3, transition: "width 0.4s ease",
            }} />
          </div>
          <span style={{ fontSize: "0.67rem", color: "var(--text-muted)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
            {item.matchedParts}/{item.totalParts} peças
            {item.reservedCount > 0 && <span style={{ color: "var(--purple-text)" }}> · {item.reservedCount} reservada{item.reservedCount !== 1 ? "s" : ""}</span>}
          </span>
        </div>
      )}

      {/* Próxima ação */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        fontSize: "0.72rem", color: "var(--text-muted)", borderTop: "1px solid rgba(255,255,255,0.05)",
        paddingTop: "0.4rem", marginTop: "0.1rem" }}>
        <span>{item.nextAction.label}</span>
        <ChevronRight size={12} />
      </div>
    </button>
  );
}

// ─── Aba VERIFICAR: lista inline editável ─────────────────────────────────

function VerificarList({
  items,
  onCaseClick,
  onRefresh,
}: {
  items: QueueItem[];
  onCaseClick: (id: number) => void;
  onRefresh: () => void;
}) {
  const [closing, setClosing] = useState<number | null>(null);
  const [closeNotes, setCloseNotes] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [depositoEditMap, setDepositoEditMap] = useState<Record<number, string>>({});
  const [savingDep, setSavingDep] = useState<Record<number, string>>({});
  const [depositoOpts, setDepositoOpts] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/depositos")
      .then(r => r.ok ? r.json() : [])
      .then((d: string[]) => setDepositoOpts(d))
      .catch(() => {});
  }, []);

  async function saveDeposito(item: QueueItem) {
    const val = depositoEditMap[item.id] ?? "";
    if (!val.trim()) return;
    setSavingDep(p => ({ ...p, [item.id]: "saving" }));
    await fetch(`/api/fila-reparos/${item.id}/deposito`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deposito: val.trim().toUpperCase() }),
    });
    setSavingDep(p => ({ ...p, [item.id]: "done" }));
    setTimeout(() => setSavingDep(p => { const n = { ...p }; delete n[item.id]; return n; }), 1500);
    onRefresh();
  }

  async function closeCase(id: number, status: string) {
    setCloseError(null);
    const r = await fetch(`/api/fila-reparos/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, notes: closeNotes.trim() || undefined }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setCloseError(body.error ?? `Erro ${r.status}`);
      return;
    }
    setClosing(null);
    setCloseNotes("");
    setCloseError(null);
    onRefresh();
  }

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <CheckCircle2 size={36} style={{ opacity: 0.25 }} />
        <div style={{ fontWeight: 600 }}>Nenhum aparelho para verificar</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Tudo certo — nenhum caso com depósito indeterminado.</div>
      </div>
    );
  }

  return (
    <div>
      <datalist id="deposito-opts">
        {depositoOpts.map(d => <option key={d} value={d} />)}
      </datalist>

      <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.75rem", padding: "0.5rem 0.75rem",
        background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "var(--r-md)" }}>
        <AlertTriangle size={12} style={{ display: "inline", marginRight: "0.4rem", color: "var(--err-text)" }} />
        Depósito atual <strong>não determinado</strong> — informe manualmente onde o aparelho está ou finalize o caso.
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "0.625rem 1rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em" }}>APARELHO</th>
              <th style={{ padding: "0.625rem 0.75rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em" }}>IMEI</th>
              <th style={{ padding: "0.625rem 0.75rem", textAlign: "left", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em", minWidth: 220 }}>DEFINIR DEPÓSITO</th>
              <th style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em" }}>AÇÃO</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const modelStr = [item.brand, item.model, item.capacity, item.color].filter(Boolean).join(" · ");
              const depVal = item.id in depositoEditMap ? depositoEditMap[item.id] : (item.depositoAtual ?? "");
              const isSavingDep = savingDep[item.id];
              const isClosing = closing === item.id;

              return (
                <tr key={item.id} style={{ borderBottom: idx < items.length - 1 ? "1px solid var(--border)" : "none",
                  background: isClosing ? "rgba(124,58,237,0.04)" : undefined }}>
                  <td style={{ padding: "0.75rem 1rem", verticalAlign: "top" }}>
                    <button
                      onClick={() => onCaseClick(item.id)}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                    >
                      <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text)" }}>
                        {modelStr || "Modelo não identificado"}
                      </div>
                      {item.os && <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>OS {item.os}</div>}
                      {item.ageDays != null && (
                        <div style={{ fontSize: "0.7rem", color: (item.ageDays > 30) ? "var(--warn-text)" : "var(--text-muted)" }}>
                          {item.ageDays}d em estoque
                        </div>
                      )}
                    </button>
                  </td>
                  <td style={{ padding: "0.75rem 0.75rem", verticalAlign: "top" }}>
                    <span style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                      {item.imei ?? "—"}
                    </span>
                  </td>
                  <td style={{ padding: "0.75rem 0.75rem", verticalAlign: "top" }}>
                    <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                      <input
                        list="deposito-opts"
                        value={depVal}
                        onChange={e => setDepositoEditMap(p => ({ ...p, [item.id]: e.target.value.toUpperCase() }))}
                        placeholder="Selecione ou digite o depósito…"
                        style={{ flex: 1, fontSize: "0.78rem",
                          background: "var(--surface-alt)", border: "1px solid var(--border)",
                          borderRadius: "var(--r-sm)", padding: "0.3rem 0.5rem", color: "var(--text)" }}
                      />
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ padding: "0.25rem 0.4rem", flexShrink: 0 }}
                        title="Confirmar depósito"
                        onClick={() => saveDeposito(item)}
                        disabled={!(depositoEditMap[item.id] ?? "").trim()}
                      >
                        {isSavingDep === "saving" ? <Loader2 size={11} className="spin" />
                          : isSavingDep === "done" ? <CheckCircle2 size={11} style={{ color: "var(--ok-text)" }} />
                          : <Save size={11} />}
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: "0.75rem 0.75rem", verticalAlign: "top", textAlign: "right" }}>
                    {isClosing ? (
                      <>
                        <div style={{ display: "flex", gap: "0.35rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
                          <button className="btn btn-sm" style={{ background: "var(--ok-dim)", color: "var(--ok-text)", border: "1px solid rgba(16,185,129,0.3)", fontSize: "0.72rem" }}
                            onClick={() => closeCase(item.id, "CONCLUIDO")}>
                            <CheckCheck size={11} /> Reparado
                          </button>
                          <button className="btn btn-sm" style={{ background: "var(--warn-dim)", color: "var(--warn-text)", border: "1px solid rgba(245,158,11,0.3)", fontSize: "0.72rem" }}
                            onClick={() => closeCase(item.id, "VENDA_ESTADO")}>
                            <Tag size={11} /> Vendido no estado
                          </button>
                          <button className="btn btn-sm" style={{ background: "var(--err-dim)", color: "var(--err-text)", border: "1px solid rgba(239,68,68,0.3)", fontSize: "0.72rem" }}
                            onClick={() => closeCase(item.id, "CANCELADO")}>
                            <Ban size={11} /> Cancelado
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: "0.72rem" }}
                            onClick={() => { setClosing(null); setCloseNotes(""); setCloseError(null); }}>
                            <X size={11} />
                          </button>
                        </div>
                        {closeError && (
                          <div style={{ marginTop: "0.35rem", fontSize: "0.72rem", color: "var(--err-text)", textAlign: "right" }}>
                            {closeError}
                          </div>
                        )}
                      </>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ fontSize: "0.73rem" }}
                        onClick={() => setClosing(item.id)}
                      >
                        Finalizar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface StaffMember {
  id: number;
  name: string;
  active: boolean;
  datasysDeposito: string | null;
}

function TechDirectModal({
  count,
  onConfirm,
  onCancel,
}: {
  count: number;
  onConfirm: (technicianId: number, notes: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [techs, setTechs] = useState<StaffMember[]>([]);
  const [techId, setTechId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/staff")
      .then(r => r.ok ? r.json() : null)
      .then((d: { staff: StaffMember[] } | null) => {
        if (d?.staff) setTechs(d.staff.filter(s => s.active));
      })
      .catch(() => {});
  }, []);

  async function confirm() {
    if (!techId) return;
    setSending(true);
    setErr(null);
    try {
      await onConfirm(techId as number, notes);
    } catch (e) {
      setErr((e as Error).message);
      setSending(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1100,
      background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem",
    }}
      onClick={e => { if (e.target === e.currentTarget && !sending) onCancel(); }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h2 style={{ margin: 0 }}>
            <SendToBack size={16} style={{ display: "inline", marginRight: "0.4rem", opacity: 0.7 }} />
            Direcionar ao técnico
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={sending}><X size={14} /></button>
        </div>

        <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: "1rem" }}>
          <strong>{count}</strong> aparelho{count !== 1 ? "s" : ""} selecionado{count !== 1 ? "s" : ""} serão direcionados ao técnico escolhido.
        </p>

        <div className="form-group">
          <label>Técnico</label>
          <select
            value={techId}
            onChange={e => setTechId(e.target.value ? Number(e.target.value) : "")}
            autoFocus
          >
            <option value="">— selecione —</option>
            {techs.map(t => (
              <option key={t.id} value={t.id}>{t.name}{t.datasysDeposito ? ` (${t.datasysDeposito})` : ""}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Observação (opcional)</label>
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Ex: Prioridade alta, aguardando peça específica…"
          />
        </div>

        {err && <div className="alert alert-err" style={{ marginBottom: "0.75rem" }}>{err}</div>}

        <div className="gap-row">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void confirm()}
            disabled={!techId || sending}
          >
            {sending ? <><Loader2 size={12} className="spin" /> Direcionando…</> : <><SendToBack size={12} /> Direcionar {count} aparelho{count !== 1 ? "s" : ""}</>}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={sending}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

interface QueueSummary {
  summary: Record<string, number>;
  total: number;
  priorityCount: number;
  filterCounts: Record<string, number>;
}

// Filtros que faz sentido exportar IMEIs (têm aparelhos reais com IMEI)
const EXPORTABLE_FILTERS: QueueFilter[] = ["MATCH", "MATCH_PARCIAL", "DO_NOW", "COM_TECNICO", "AGUARDANDO_PECAS", "VERIFICAR", "VENDA_ESTADO", "TODOS"];

function downloadTxt(text: string, filename: string, onDone: () => void) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  onDone();
}

function copyOrDownload(text: string, filename: string, onCopied: () => void) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onCopied).catch(() => downloadTxt(text, filename, onCopied));
  } else {
    // Contexto não-seguro (HTTP em IP remoto): usa download direto
    downloadTxt(text, filename, onCopied);
  }
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
  const [queueSummary, setQueueSummary] = useState<QueueSummary | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Seleção manual de cards (acumula entre páginas)
  const [selectedMap, setSelectedMap] = useState<Map<number, string | null>>(new Map());
  const [exportingAll, setExportingAll] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [depositoMap, setDepositoMap] = useState<Record<string, string>>({});
  const [showTechModal, setShowTechModal] = useState(false);
  const [techDirectFeedback, setTechDirectFeedback] = useState<string | null>(null);
  const { user } = useAuth();

  useEffect(() => {
    fetch("/api/staff")
      .then(r => r.ok ? r.json() : null)
      .then((d: { depositoMap?: Record<string, string> } | null) => {
        if (d?.depositoMap) setDepositoMap(d.depositoMap);
      })
      .catch(() => {});
  }, []);

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

  useEffect(() => {
    const t = setTimeout(() => { setQ(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch("/api/fila-reparos/summary");
      if (r.ok) setQueueSummary(await r.json() as QueueSummary);
    } catch { /* ignore */ }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const qs = new URLSearchParams({ filter, page: String(page), limit: String(LIMIT) });
      if (q) qs.set("q", q);
      const r = await fetch(`/api/fila-reparos?${qs.toString()}`);
      if (r.ok) {
        const data = await r.json() as { items: QueueItem[]; total: number };
        setItems(data.items);
        setTotal(data.total);
      } else {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setListError(body.error ?? `Erro ${r.status} ao carregar a fila.`);
      }
    } catch (e) {
      setListError((e as Error).message === "Failed to fetch" ? "API indisponível." : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, page, q]);

  useEffect(() => {
    void loadItems();
    void loadEngine();
    void loadSummary();
  }, [loadItems, loadEngine, loadSummary]);

  const prevEngineStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engineState) return;
    const prev = prevEngineStatusRef.current;
    prevEngineStatusRef.current = engineState.status;
    if (prev === "RUNNING" && engineState.status === "IDLE") {
      void loadSummary();
      void loadItems();
    }
  }, [engineState, loadSummary, loadItems]);

  useEffect(() => {
    if (!engineState || (engineState.status !== "RUNNING" && engineState.status !== "STALE")) return;
    const t = setInterval(() => void loadEngine(), 3000);
    return () => clearInterval(t);
  }, [engineState, loadEngine]);

  async function runEngine() {
    await fetch("/api/engine/run", { method: "POST" });
    void loadEngine();
    setTimeout(() => { void loadItems(); void loadEngine(); void loadSummary(); }, 2000);
  }

  function handleDrawerClose(refresh: boolean) {
    setSelectedId(null);
    if (refresh) { void loadItems(); void loadSummary(); }
  }

  // Seleção manual de cards individuais
  function toggleCard(item: QueueItem) {
    setSelectedMap(prev => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item.imei);
      return next;
    });
  }

  function clearSelection() {
    setSelectedMap(new Map());
  }

  function selectAll() {
    setSelectedMap(prev => {
      const next = new Map(prev);
      for (const item of items) next.set(item.id, item.imei);
      return next;
    });
  }

  async function batchDirectTechnician(technicianId: number, notes: string) {
    const ids = [...selectedMap.keys()];
    const r = await fetch("/api/fila-reparos/direct-technician-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseIds: ids, technicianId, notes: notes || undefined }),
    });
    const data = await r.json() as { ok: boolean; succeeded: number; failed: number };
    setShowTechModal(false);
    clearSelection();
    const msg = data.failed > 0
      ? `${data.succeeded} direcionado(s), ${data.failed} com erro.`
      : `${data.succeeded} aparelho(s) direcionado(s) ao técnico.`;
    setTechDirectFeedback(msg);
    setTimeout(() => setTechDirectFeedback(null), 4000);
    void loadItems();
    void loadSummary();
  }

  // Exportar IMEIs dos cards selecionados manualmente
  function exportSelected() {
    const imeis = [...selectedMap.values()].filter(Boolean) as string[];
    copyOrDownload(imeis.join("\n"), "imeis-selecionados.txt", () => {
      setExportFeedback(`${imeis.length} IMEIs copiados`);
      setTimeout(() => setExportFeedback(null), 2500);
    });
  }

  // Exportar todos os resultados do filtro atual como CSV completo (endpoint dedicado)
  async function exportAllImeis() {
    setExportingAll(true);
    setExportFeedback("Gerando arquivo…");
    try {
      const qs = new URLSearchParams({ filter });
      if (q) qs.set("q", q);
      const r = await fetch(`/api/fila-reparos/export?${qs.toString()}`);
      if (!r.ok) throw new Error(`Erro ${r.status}`);
      const blob = await r.blob();
      const disposition = r.headers.get("Content-Disposition") ?? "";
      const fnMatch = disposition.match(/filename="([^"]+)"/);
      const filename = fnMatch?.[1] ?? `fila-reparos-${filter.toLowerCase()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setExportFeedback(`${total} aparelhos exportados`);
      setTimeout(() => setExportFeedback(null), 3000);
    } catch {
      setExportFeedback("Erro ao exportar");
      setTimeout(() => setExportFeedback(null), 2500);
    } finally {
      setExportingAll(false);
    }
  }

  const totalPages = Math.ceil(total / LIMIT);
  const kpiTotal    = queueSummary?.total ?? total;
  const selectedCount = selectedMap.size;
  const canExportAll  = EXPORTABLE_FILTERS.includes(filter) && total > 0 && !loading;

  // Calcula contagens por filtro — usa filterCounts do servidor ou deriva do summary como fallback
  const sumByStatuses = (statuses: string[]) =>
    statuses.reduce((acc, s) => acc + (queueSummary?.summary[s] ?? 0), 0);
  const fc: Record<string, number> = queueSummary?.filterCounts ?? (queueSummary ? {
    MATCH:            sumByStatuses(["MATCH"]),
    MATCH_PARCIAL:    sumByStatuses(["MATCH_PARCIAL"]),
    AGUARDANDO_PECAS: sumByStatuses(["PEDIR_PECA","AGUARDANDO_RECEBIMENTO"]),
    COM_TECNICO:      sumByStatuses(["APTO_REPARO","DIRECIONADO_TECNICO","EM_REPARO","REPARO_EXECUTADO","TRIAGEM_FINAL","RETORNO_TECNICO"]),
    EM_ANALISE:       sumByStatuses(["EM_ANALISE","EM_SEPARACAO"]),
    VERIFICAR:        sumByStatuses(["VERIFICAR"]),
    VENDA_ESTADO:     sumByStatuses(["VENDA_ESTADO"]),
    FINALIZADOS:      sumByStatuses(["CONCLUIDO","CANCELADO"]),
    TODOS:            kpiTotal,
  } : {});

  // Ordem fixa dos cards — sempre visíveis, independente de contagem
  type FilterCardDef = { f: QueueFilter; label: string; sub: string; color: string; borderColor: string };
  const FILTER_CARDS: FilterCardDef[] = [
    { f: "MATCH",           label: "Match",           sub: "prontos",        color: "var(--ok-text)",        borderColor: "rgba(16,185,129,0.4)"  },
    { f: "COM_TECNICO",     label: "Com Técnico",     sub: "distribuídos",   color: "var(--accent)",         borderColor: "rgba(124,58,237,0.4)"  },
    { f: "VERIFICAR",       label: "Verificar",       sub: "atenção",        color: "var(--err-text)",       borderColor: "rgba(239,68,68,0.4)"   },
    { f: "EM_ANALISE",      label: "Em análise",      sub: "separação",      color: "var(--text-muted)",     borderColor: "rgba(255,255,255,0.15)" },
    { f: "AGUARDANDO_PECAS",label: "Aguardando",      sub: "em compra",      color: "var(--text-muted)",     borderColor: "rgba(255,255,255,0.15)" },
    { f: "MATCH_PARCIAL",   label: "Parcial",         sub: "incompletos",    color: "var(--warn-text)",      borderColor: "rgba(245,158,11,0.3)"  },
    { f: "VENDA_ESTADO",    label: "Venda Estado",    sub: "baixo score",    color: "rgba(245,158,11,0.7)",  borderColor: "rgba(245,158,11,0.35)" },
    { f: "FINALIZADOS",     label: "Finalizados",     sub: "concluídos",     color: "var(--ok-text)",        borderColor: "rgba(16,185,129,0.2)"  },
    { f: "TODOS",           label: "Todos",           sub: "aparelhos",      color: "var(--text-muted)",     borderColor: "rgba(255,255,255,0.12)" },
  ];

  return (
    <div className="page-container">
      {/* Cabeçalho */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Fila de Reparos</h1>
          <p className="page-subtitle">
            {filter !== "TODOS"
              ? <>{total} aparelho{total !== 1 ? "s" : ""} neste filtro · <span style={{ opacity: 0.55 }}>{kpiTotal} no total</span></>
              : <>{kpiTotal} aparelho{kpiTotal !== 1 ? "s" : ""} no total</>
            }
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginLeft: "auto" }}>
          <EngineStatusBar state={engineState} pending={pending} onRun={runEngine} />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { void loadSummary(); void loadItems(); void loadEngine(); }}
            title="Atualizar fila"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* KPI cards clicáveis — ordem fixa, sempre visíveis, cabe numa linha */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${FILTER_CARDS.length}, 1fr)`,
        gap: "0.45rem",
        marginBottom: "1.25rem",
      }}>
        {FILTER_CARDS.map(({ f, label, sub, color, borderColor }) => {
          const count = fc[f] ?? 0;
          const isActive = filter === f;
          const hasCount = count > 0;
          return (
            <button
              key={f}
              className="kpi-card"
              onClick={() => { setFilter(f); setPage(1); clearSelection(); }}
              style={{
                cursor: "pointer", font: "inherit", textAlign: "left",
                padding: "0.6rem 0.7rem", minWidth: 0,
                "--kpi-color": color,
                borderColor: isActive ? borderColor : undefined,
                boxShadow: isActive
                  ? `0 0 0 1px ${borderColor}, 0 6px 20px rgba(0,0,0,0.4)`
                  : undefined,
                opacity: hasCount ? 1 : 0.4,
              } as React.CSSProperties}
            >
              <div className="kpi-label" style={{ color, marginBottom: "0.2rem", fontSize: "0.66rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
              <div className="kpi-value" style={{ color, fontSize: "1.45rem", lineHeight: 1.1 }}>{count}</div>
              <div className="kpi-sub" style={{ fontSize: "0.62rem", marginTop: "0.15rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
            </button>
          );
        })}
      </div>

      {/* Busca + exportar todos */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.875rem", alignItems: "center" }}>
        <div className="search-bar" style={{ marginBottom: 0, flex: 1 }}>
          <input
            type="search"
            placeholder="Buscar por IMEI, OS, marca, modelo, peça, depósito…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
        </div>
        {canExportAll && (
          <button
            className="btn btn-primary btn-sm"
            style={{ flexShrink: 0, gap: "0.35rem", whiteSpace: "nowrap" }}
            onClick={() => void exportAllImeis()}
            disabled={exportingAll}
            title={`Exportar CSV com todos os ${total} aparelhos do filtro "${filter}"`}
          >
            {exportingAll ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
            {exportFeedback ?? `Exportar ${total} aparelhos`}
          </button>
        )}
      </div>

      {/* Feedback de direcionamento em lote */}
      {techDirectFeedback && (
        <div className="alert alert-ok" style={{ marginBottom: "0.5rem", cursor: "pointer" }} onClick={() => setTechDirectFeedback(null)}>
          <UserCheck size={13} /> {techDirectFeedback}
        </div>
      )}

      {/* Barra de seleção manual — só aparece se há cards selecionados */}
      {selectedCount > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap",
          background: filter === "COM_TECNICO" ? "rgba(124,58,237,0.12)" : "rgba(124,58,237,0.1)",
          border: `1px solid ${filter === "COM_TECNICO" ? "rgba(124,58,237,0.4)" : "rgba(124,58,237,0.3)"}`,
          borderRadius: "var(--r-md)", padding: "0.5rem 0.875rem",
          marginBottom: "0.875rem",
        }}>
          <span style={{ fontSize: "0.78rem", color: "var(--accent)", fontWeight: 700 }}>
            {selectedCount} selecionado{selectedCount !== 1 ? "s" : ""}
          </span>

          {/* Ação principal: direcionar ao técnico (só em APTO_REPARO) */}
          {filter === "COM_TECNICO" && (
            <>
              <button
                className="btn btn-primary btn-sm"
                style={{ gap: "0.35rem" }}
                onClick={() => setShowTechModal(true)}
              >
                <SendToBack size={12} />
                Direcionar ao técnico
              </button>
              {items.some(i => !selectedMap.has(i.id)) && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ gap: "0.3rem", fontSize: "0.75rem" }}
                  onClick={selectAll}
                >
                  <CheckCheck size={12} />
                  Selecionar todos ({items.length})
                </button>
              )}
            </>
          )}

          {/* Exportar IMEIs */}
          <button
            className="btn btn-ghost btn-sm"
            style={{ gap: "0.35rem" }}
            onClick={exportSelected}
          >
            <Download size={12} />
            {exportFeedback ?? "Exportar IMEIs"}
          </button>

          <button
            className="btn btn-ghost btn-sm"
            style={{ gap: "0.3rem", color: "var(--err-text)", marginLeft: "auto" }}
            onClick={clearSelection}
          >
            <XCircle size={12} />
            Limpar
          </button>
        </div>
      )}

      {/* Conteúdo */}
      {loading ? (
        <div className="loading-state">
          <Loader2 size={18} className="spin" /> Carregando fila…
        </div>
      ) : listError ? (
        <div className="banner err" style={{ marginTop: "1rem" }}>
          <strong>Erro ao carregar a fila:</strong> {listError}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <Boxes size={40} style={{ opacity: 0.25 }} />
          <div>
            {kpiTotal === 0 ? (
              <>
                <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Nenhum aparelho importado ainda</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Importe os dados em <strong>Dados</strong> para começar.
                </div>
              </>
            ) : filter === "TODOS" ? (
              <>
                <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Nenhum aparelho encontrado</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Nenhum resultado para a busca atual.</div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                  Nenhum aparelho no filtro "{FILTER_LABELS[filter]}"
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {`Há ${kpiTotal} aparelho${kpiTotal !== 1 ? "s" : ""} em outros filtros.`}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
            <div className="repair-grid">
              {items.map((item) => (
                <RepairCard
                  key={item.id}
                  item={item}
                  selected={selectedMap.has(item.id)}
                  onToggle={() => toggleCard(item)}
                  onClick={() => setSelectedId(item.id)}
                  depositoMap={depositoMap}
                />
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
          userPermissions={user?.permissions ?? []}
        />
      )}

      {showTechModal && (
        <TechDirectModal
          count={selectedCount}
          onConfirm={batchDirectTechnician}
          onCancel={() => setShowTechModal(false)}
        />
      )}
    </div>
  );
}
