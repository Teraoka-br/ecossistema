import { useState, useEffect } from "react";
import {
  X, Package, Clock, Star, ChevronRight, AlertTriangle, CheckCircle2,
  UserCheck, History, Info, Loader2, Users, ShoppingCart, MessageSquarePlus, RefreshCw, MapPin,
} from "lucide-react";
import { addToPurchase } from "../api.js";

interface PartInfo {
  id: number;
  description: string | null;
  chavePeca: string | null;
  status: string;
  availableQty: number;
  reservedQty: number;
  reservationId: number | null;
  matchResultStatus: string | null;
  allocatedReference: string | null;
  activePurchaseRequestId: number | null;
  purchaseRequestStatus: string | null;
  activePurchaseOrderId: number | null;
  purchaseOrderStatus: string | null;
}

interface HistoryEvent {
  id: number;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  responsible_name: string | null;
  notes: string | null;
  created_at: string;
}

interface CaseDetail {
  id: number;
  imei: string | null;
  os: string | null;
  brand: string | null;
  model: string | null;
  capacity: string | null;
  color: string | null;
  repairDate: string | null;
  ageDays: number | null;
  cost: number | null;
  estimatedSale: number | null;
  margin: number | null;
  workflowStatus: string;
  analysisStatus: string;
  manualPriorityActive: boolean;
  notes: string | null;
  depositoAtual: string | null;
  parts: PartInfo[];
  nextAction: { code: string; label: string; description: string; enabled: boolean };
  technician: { id: number; name: string } | null;
  directedTechnician: { id: number; name: string } | null;
  history: HistoryEvent[];
  purchasablePartsCount: number;
  partsAlreadyInPurchaseCount: number;
}

interface RepairDrawerProps {
  repairCaseId: number;
  onClose: (refresh: boolean) => void;
  userRole: "ADMIN" | "OPERATOR" | "TECHNICIAN";
  userPermissions?: string[];
}

const CANCEL_REASONS = [
  { code: "UNPLANNED_REPAIR", label: "Reparo não previsto" },
  { code: "PRIORITY_ASSISTANCE", label: "Assistência prioritária" },
  { code: "INCOMPATIBLE_REF", label: "Referência incompatível" },
  { code: "ANALYSIS_ERROR", label: "Erro na análise" },
  { code: "EXTERNAL_PRIORITY", label: "Prioridade externa" },
  { code: "OPERATIONAL_DECISION", label: "Decisão operacional" },
  { code: "OTHER", label: "Outro" },
];

const EVENT_LABELS: Record<string, string> = {
  NOTE_ADDED: "Observação adicionada",
  DIRECTED_TO_TECHNICIAN: "Direcionado ao técnico",
  REPAIR_STARTED: "Reparo iniciado",
  REPAIR_COMPLETED: "Reparo concluído",
  PART_SEPARATED: "Peça separada",
  RESERVATION_CREATED: "Reserva criada",
  RESERVATION_RELEASED: "Reserva cancelada",
  ANALYSIS_COMPLETED: "Análise concluída",
  MATCH_STATUS_CHANGED: "Status de match alterado",
  KIT_RESERVED: "Kit reservado",
};

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ").toLowerCase().replace(/^\w/, c => c.toUpperCase());
}

type DrawerTab = "parts" | "score" | "history";
type ConfirmAction = "SEPARATE_KIT" | "SEPARATE_PARTIAL" | "CANCEL_RESERVATION" | "ADD_TO_PURCHASE"
  | "DIRECT_TO_TECHNICIAN" | "REDIRECT_TECHNICIAN" | "START_REPAIR" | "COMPLETE_REPAIR" | "CLOSE_CASE" | "SET_STATUS";

interface ActionConfirmState {
  action: ConfirmAction;
  partId?: number;
  notes: string;
  targetStatus?: string;
}

export function RepairDrawer({ repairCaseId, onClose, userRole, userPermissions }: RepairDrawerProps) {
  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DrawerTab>("parts");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [technicians, setTechnicians] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedTechId, setSelectedTechId] = useState<number | null>(null);
  const [addingToPurchase] = useState(false);
  const [purchaseMsg, setPurchaseMsg] = useState<string | null>(null);
  const [cancelingPartId, setCancelingPartId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelReasonCode, setCancelReasonCode] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [didChange, setDidChange] = useState(false);

  // Notes
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // Score manual edit
  const [scoreEdit, setScoreEdit] = useState<{ ageDays: string; cost: string; estimatedSale: string; margin: string } | null>(null);
  const [savingScore, setSavingScore] = useState(false);
  const [scoreMsg, setScoreMsg] = useState<string | null>(null);

  // Mover para depósito
  const [depositoEdit, setDepositoEdit] = useState<string | null>(null);
  const [savingDeposito, setSavingDeposito] = useState(false);

  // Confirm modal
  const [confirmState, setConfirmState] = useState<ActionConfirmState | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/fila-reparos/${repairCaseId}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Erro ao carregar")))
      .then((d: CaseDetail) => setData(d))
      .catch(e => setError(e instanceof Error ? e.message : "Erro ao carregar"))
      .finally(() => setLoading(false));
  }, [repairCaseId, refreshCount]);

  useEffect(() => {
    fetch("/api/staff")
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { staff: Array<{ id: number; name: string; active: boolean; userId: number | null }> }) => {
        setTechnicians(d.staff.filter(m => m.active && m.userId != null));
      })
      .catch(() => {});
  }, []);

  function refresh(changed = true) {
    if (changed) setDidChange(true);
    setRefreshCount(c => c + 1);
  }

  async function handleSaveNote() {
    if (!noteText.trim() || noteText.trim().length < 2) return;
    setSavingNote(true);
    setError(null);
    try {
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteText.trim() }),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? "Erro ao salvar observação");
      }
      setNoteText("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setSavingNote(false);
    }
  }

  async function saveDeposito() {
    if (depositoEdit === null) return;
    setSavingDeposito(true);
    setError(null);
    try {
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/deposito`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deposito: depositoEdit.trim() || null }),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? "Erro ao mover depósito");
      }
      setDepositoEdit(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setSavingDeposito(false);
    }
  }

  async function executeConfirmedAction(state: ActionConfirmState) {
    if (!data) return;
    setWorking(true);
    setError(null);
    setConfirmState(null);
    try {
      switch (state.action) {
        case "SEPARATE_KIT": {
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/reserve-kit`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao reservar kit"); }
          break;
        }
        case "SEPARATE_PARTIAL": {
          const disponivel = data.parts.filter(p => p.matchResultStatus === "MATCH_PARCIAL" && p.reservationId === null && p.availableQty > 0);
          if (disponivel.length === 0) break;
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/reserve-partial`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: disponivel.map(p => ({ partRequestId: p.id, chavePeca: p.chavePeca ?? "", reference: p.allocatedReference, quantity: 1 })) }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao reservar parcial"); }
          break;
        }
        case "CANCEL_RESERVATION": {
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/release-reservation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ partRequestId: state.partId, reason: cancelReason, reasonCode: cancelReasonCode || undefined }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao cancelar reserva"); }
          setCancelingPartId(null); setCancelReason(""); setCancelReasonCode("");
          break;
        }
        case "ADD_TO_PURCHASE": {
          const res = await addToPurchase(repairCaseId);
          setPurchaseMsg(res.created > 0 ? `${res.created} solicitação(ões) criada(s) em compra.` : "Todas as peças já estavam em compra.");
          break;
        }
        case "DIRECT_TO_TECHNICIAN":
        case "REDIRECT_TECHNICIAN": {
          if (!selectedTechId) break;
          const endpoint = state.action === "REDIRECT_TECHNICIAN"
            ? `/api/fila-reparos/${repairCaseId}/redirect-technician`
            : `/api/fila-reparos/${repairCaseId}/direct-technician`;
          const r = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ technicianId: selectedTechId, notes: state.notes || undefined }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao direcionar"); }
          break;
        }
        case "START_REPAIR": {
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/start-repair`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao iniciar reparo"); }
          break;
        }
        case "COMPLETE_REPAIR": {
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/complete-repair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes: state.notes || undefined }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao concluir reparo"); }
          break;
        }
        case "CLOSE_CASE": {
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/close`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "CONCLUIDO", notes: state.notes }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao finalizar card"); }
          break;
        }
        case "SET_STATUS": {
          if (!state.targetStatus) throw new Error("Selecione um status.");
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/override-status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toStatus: state.targetStatus, notes: state.notes }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao alterar fase"); }
          break;
        }
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setWorking(false);
    }
  }

  const modelStr = data ? [data.model, data.capacity].filter(Boolean).join(" ") : "";
  const ws = data?.workflowStatus ?? "";

  const showSeparateKit = ws === "MATCH";
  const showSeparatePartial = ws === "MATCH_PARCIAL";
  const showAddToPurchase = ws === "PEDIR_PECA" || ws === "MATCH_PARCIAL";
  const showDirectTech = ws === "APTO_REPARO";
  const showRedirectTech = ws === "DIRECIONADO_TECNICO";
  const showStartRepair = ws === "DIRECIONADO_TECNICO";
  const showCompleteRepair = ws === "EM_REPARO";

  return (
    <div
      className="drawer-overlay"
      onClick={() => onClose(didChange)}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        className="drawer"
        onClick={e => e.stopPropagation()}
        style={{
          position: "relative", inset: "auto",
          width: "min(1040px, calc(100vw - 2rem))", maxHeight: "92vh",
          borderRadius: "var(--r-md, 8px)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header fixo */}
        <div className="drawer-header" style={{ flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {data?.manualPriorityActive && <Star size={14} fill="currentColor" style={{ color: "var(--warning)" }} />}
              <span className="drawer-title">{modelStr || "Aparelho"}</span>
              {data?.color && <span className="drawer-sub">{data.color}</span>}
              {data && (
                <span style={{ marginLeft: "auto", fontSize: "0.75rem", padding: "2px 8px", borderRadius: 12,
                  background: "var(--accent-subtle, rgba(99,102,241,0.1))", color: "var(--accent)" }}>
                  {data.workflowStatus.replace(/_/g, " ")}
                </span>
              )}
            </div>
            <div className="drawer-meta">
              {data?.imei && <span>IMEI {data.imei}</span>}
              {data?.os && <span>OS {data.os}</span>}
              {data?.repairDate && <span>{data.repairDate}</span>}
              {data?.ageDays != null && <span>{data.ageDays}d</span>}
              {(data?.technician ?? data?.directedTechnician) && (
                <span>Técnico: {data.technician?.name ?? data.directedTechnician?.name}</span>
              )}
              {depositoEdit !== null ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                  <input
                    value={depositoEdit}
                    onChange={e => setDepositoEdit(e.target.value)}
                    placeholder="Nome do depósito…"
                    style={{ fontSize: "0.78rem", padding: "0.15rem 0.4rem", borderRadius: "var(--r-sm)", border: "1px solid var(--border)", background: "var(--surface-alt)", color: "var(--text)", width: 160 }}
                    onKeyDown={e => { if (e.key === "Enter") void saveDeposito(); if (e.key === "Escape") setDepositoEdit(null); }}
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm" style={{ padding: "0.15rem 0.5rem", fontSize: "0.72rem" }} onClick={() => void saveDeposito()} disabled={savingDeposito}>
                    {savingDeposito ? "…" : "OK"}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ padding: "0.15rem 0.4rem", fontSize: "0.72rem" }} onClick={() => setDepositoEdit(null)}>
                    <X size={11} />
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setDepositoEdit(data?.depositoAtual ?? "")}
                  style={{ background: "none", border: "none", padding: "0.1rem 0.3rem", cursor: "pointer", fontSize: "0.75rem", color: "var(--text-muted)", borderRadius: "var(--r-sm)", display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
                  title="Mover para depósito"
                >
                  <MapPin size={11} />
                  {data?.depositoAtual ?? "Sem depósito"}
                </button>
              )}
            </div>
          </div>
          <button className="btn-ghost-sm" onClick={() => onClose(didChange)}>
            <X size={16} />
          </button>
        </div>

        {/* Linha do processo */}
        {data && (
          <div className="process-line" style={{ flexShrink: 0 }}>
            {["Análise", "Match", "Separação", "Técnico", "Triagem", "Conclusão"].map((step, i) => {
              const active = (
                (i === 0 && ["EM_ANALISE"].includes(data.workflowStatus)) ||
                (i === 1 && ["MATCH","MATCH_PARCIAL","PEDIR_PECA","AGUARDANDO_RECEBIMENTO"].includes(data.workflowStatus)) ||
                (i === 2 && ["EM_SEPARACAO","APTO_REPARO"].includes(data.workflowStatus)) ||
                (i === 3 && ["DIRECIONADO_TECNICO","EM_REPARO"].includes(data.workflowStatus)) ||
                (i === 4 && ["REPARO_EXECUTADO","TRIAGEM_FINAL","RETORNO_TECNICO"].includes(data.workflowStatus)) ||
                (i === 5 && ["CONCLUIDO","VENDA_ESTADO","CANCELADO"].includes(data.workflowStatus))
              );
              return (
                <div key={step} className={`process-step ${active ? "active" : ""}`}>
                  <span>{step}</span>
                  {i < 5 && <ChevronRight size={10} />}
                </div>
              );
            })}
          </div>
        )}

        {/* Tabs */}
        <div className="drawer-tabs" style={{ flexShrink: 0 }}>
          <button className={`drawer-tab ${tab === "parts" ? "active" : ""}`} onClick={() => setTab("parts")}>
            <Package size={13} /> Peças
          </button>
          <button className={`drawer-tab ${tab === "score" ? "active" : ""}`} onClick={() => setTab("score")}>
            <Info size={13} /> Prioridade
          </button>
          <button className={`drawer-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
            <History size={13} /> Histórico {data && data.history.length > 0 && <span style={{ marginLeft: 4, fontSize: "0.7rem", background: "var(--accent)", color: "#fff", borderRadius: 10, padding: "0 5px" }}>{data.history.length}</span>}
          </button>
        </div>

        {/* Corpo rolável */}
        <div className="drawer-body" style={{ overflowY: "auto", flex: 1 }}>
          {loading && <div className="loading-state"><Loader2 size={18} className="spin" /></div>}
          {error && <div className="error-banner">{error}</div>}

          {!loading && data && tab === "parts" && (
            <>
              {/* Next action CTA */}
              {data.nextAction.enabled && (
                <div className="drawer-cta">
                  <div>
                    <div className="cta-label">{data.nextAction.label}</div>
                    <div className="cta-desc">{data.nextAction.description}</div>
                  </div>
                  {showSeparateKit && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "SEPARATE_KIT", notes: "" })} disabled={working}>
                      <Package size={14} /> Separar kit
                    </button>
                  )}
                  {showSeparatePartial && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "SEPARATE_PARTIAL", notes: "" })} disabled={working}>
                      <Package size={14} /> Separar disponíveis
                    </button>
                  )}
                  {showDirectTech && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "DIRECT_TO_TECHNICIAN", notes: "" })} disabled={working}>
                      <UserCheck size={14} /> Direcionar ao técnico
                    </button>
                  )}
                  {showRedirectTech && (
                    <button
                      className="btn-secondary"
                      onClick={() => setConfirmState({ action: "REDIRECT_TECHNICIAN", notes: "" })}
                      disabled={working}
                      style={{ fontSize: "0.8rem" }}
                    >
                      <RefreshCw size={13} /> Alterar técnico
                    </button>
                  )}
                  {showStartRepair && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "START_REPAIR", notes: "" })} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <UserCheck size={14} />}
                      Iniciar reparo
                    </button>
                  )}
                  {showCompleteRepair && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "COMPLETE_REPAIR", notes: "" })} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                      Concluir reparo
                    </button>
                  )}
                </div>
              )}

              {/* Incluir em compra */}
              {showAddToPurchase && (data.purchasablePartsCount > 0 || data.partsAlreadyInPurchaseCount > 0) && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
                  {data.purchasablePartsCount > 0 ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setConfirmState({ action: "ADD_TO_PURCHASE", notes: "" })}
                      disabled={addingToPurchase}
                      style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
                    >
                      {addingToPurchase ? <Loader2 size={13} className="spin" /> : <ShoppingCart size={13} />}
                      Incluir em compra
                    </button>
                  ) : (
                    <span style={{ fontSize: "0.82rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                      <ShoppingCart size={13} /> Peças faltantes já incluídas em compra
                    </span>
                  )}
                  {purchaseMsg && <span style={{ fontSize: "0.8rem", color: "var(--success)" }}>{purchaseMsg}</span>}
                </div>
              )}

              {/* Ações manuais — visíveis para admin ou quem tem OVERRIDE_REPAIR_STATUS */}
              {(userRole === "ADMIN" || userPermissions?.includes("OVERRIDE_REPAIR_STATUS")) && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", padding: "0.5rem 0" }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "0.75rem" }}
                    onClick={() => setConfirmState({ action: "SET_STATUS", notes: "", targetStatus: "" })}
                    disabled={working}
                    title="Alterar fase do aparelho manualmente"
                  >
                    <RefreshCw size={12} /> Alterar fase
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--err-text, #f87171)", fontSize: "0.75rem" }}
                    onClick={() => setConfirmState({ action: "CLOSE_CASE", notes: "" })}
                    disabled={working}
                    title="Finalizar este card com justificativa"
                  >
                    <CheckCircle2 size={12} /> Finalizar card
                  </button>
                </div>
              )}

              {/* Parts list */}
              <div className="parts-list">
                {data.parts.map(p => (
                  <div key={p.id} className="part-row">
                    <div className="part-info">
                      <span className="part-desc">{p.description || p.chavePeca || "(sem descrição)"}</span>
                      {p.chavePeca && <span className="part-chave">{p.chavePeca}</span>}
                      {p.allocatedReference && <span className="part-ref">REF {p.allocatedReference}</span>}
                    </div>
                    <div className="part-stock">
                      <span className={p.availableQty > 0 ? "stock-ok" : "stock-zero"}>{p.availableQty} disp.</span>
                      {p.reservedQty > 0 && <span className="stock-reserved">{p.reservedQty} res.</span>}
                    </div>
                    <div className="part-status">
                      {p.matchResultStatus === "MATCH" && <CheckCircle2 size={13} style={{ color: "var(--success)" }} />}
                      {p.matchResultStatus === "MATCH_PARCIAL" && <Package size={13} style={{ color: "var(--warning)" }} />}
                      {p.matchResultStatus === "PEDIR_PECA" && <AlertTriangle size={13} style={{ color: "var(--muted)" }} />}
                      <span>{p.status}</span>
                      {p.activePurchaseRequestId != null && (
                        <span style={{ fontSize: "0.72rem", padding: "1px 5px", borderRadius: "4px",
                          background: p.purchaseOrderStatus === "AWAITING_RECEIPT" || p.purchaseOrderStatus === "PARTIALLY_RECEIVED"
                            ? "var(--warning-subtle, rgba(234,179,8,0.15))" : "var(--accent-subtle, rgba(99,102,241,0.1))",
                          color: p.purchaseOrderStatus === "AWAITING_RECEIPT" || p.purchaseOrderStatus === "PARTIALLY_RECEIVED"
                            ? "var(--warning)" : "var(--accent)" }}>
                          {p.purchaseOrderStatus === "AWAITING_RECEIPT" || p.purchaseOrderStatus === "PARTIALLY_RECEIVED" ? "Em pedido" : "Em compra"}
                        </span>
                      )}
                    </div>
                    {p.reservationId !== null && (
                      <button
                        className="btn-ghost-sm danger"
                        onClick={() => { setCancelingPartId(p.id); setCancelReason(""); setCancelReasonCode(""); }}
                        title="Cancelar reserva"
                      >
                        <X size={12} /> Cancelar
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Cancel reservation — seleção de motivo */}
              {cancelingPartId !== null && (
                <div className="modal-overlay" onClick={() => setCancelingPartId(null)}>
                  <div className="modal" onClick={e => e.stopPropagation()}>
                    <h3>Cancelar reserva</h3>
                    <p style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Selecione o motivo:</p>
                    <div className="reason-list">
                      {CANCEL_REASONS.map(r => (
                        <label key={r.code} className="reason-option">
                          <input type="radio" name="reason" value={r.code} onChange={() => { setCancelReasonCode(r.code); setCancelReason(r.label); }} />
                          {r.label}
                        </label>
                      ))}
                    </div>
                    {cancelReasonCode === "OTHER" && (
                      <input
                        className="input"
                        placeholder="Descreva o motivo…"
                        value={cancelReason === "Outro" ? "" : cancelReason}
                        onChange={e => setCancelReason(e.target.value)}
                        style={{ marginTop: "0.5rem" }}
                      />
                    )}
                    <div className="modal-actions">
                      <button className="btn-ghost" onClick={() => setCancelingPartId(null)}>Voltar</button>
                      <button
                        className="btn-danger"
                        onClick={() => setConfirmState({ action: "CANCEL_RESERVATION", partId: cancelingPartId!, notes: cancelReason })}
                        disabled={!cancelReason}
                      >
                        Confirmar cancelamento
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {!loading && data && tab === "score" && (() => {
            const editing = scoreEdit !== null;
            function startEdit() {
              setScoreEdit({
                ageDays: data!.ageDays != null ? String(data!.ageDays) : "",
                cost: data!.cost != null ? String(data!.cost) : "",
                estimatedSale: data!.estimatedSale != null ? String(data!.estimatedSale) : "",
                margin: data!.margin != null ? String(data!.margin) : "",
              });
              setScoreMsg(null);
            }
            async function saveScore() {
              if (!scoreEdit) return;
              setSavingScore(true);
              setScoreMsg(null);
              const toVal = (s: string) => s.trim() === "" ? null : parseFloat(s.replace(",", "."));
              try {
                const r = await fetch(`/api/fila-reparos/${repairCaseId}/score`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ageDays: toVal(scoreEdit.ageDays),
                    cost: toVal(scoreEdit.cost),
                    estimatedSale: toVal(scoreEdit.estimatedSale),
                    margin: toVal(scoreEdit.margin),
                  }),
                });
                if (!r.ok) throw new Error((await r.json()).error ?? "Erro");
                setScoreEdit(null);
                setScoreMsg("Salvo com sucesso.");
                refresh(true);
              } catch (e) {
                setScoreMsg(e instanceof Error ? e.message : "Erro ao salvar.");
              } finally {
                setSavingScore(false);
              }
            }
            return (
              <div className="score-section">
                {!editing ? (
                  <>
                    <div className="score-row"><span>Idade</span><span>{data.ageDays != null ? `${data.ageDays} dias` : "—"}</span></div>
                    <div className="score-row"><span>Custo</span><span>{data.cost != null ? `R$ ${data.cost.toFixed(2)}` : "—"}</span></div>
                    <div className="score-row"><span>Venda estimada</span><span>{data.estimatedSale != null ? `R$ ${data.estimatedSale.toFixed(2)}` : "—"}</span></div>
                    <div className="score-row">
                      <span>Margem</span>
                      <span style={{ color: (data.margin ?? 0) >= 0 ? "var(--success)" : "var(--danger)" }}>
                        {data.margin != null ? `R$ ${data.margin.toFixed(2)}` : "—"}
                      </span>
                    </div>
                    <div className="score-row"><span>Técnico</span><span>{data.technician?.name ?? data.directedTechnician?.name ?? "—"}</span></div>
                    {data.notes && (
                      <div className="score-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: "0.25rem" }}>
                        <span>Observações</span>
                        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{data.notes}</span>
                      </div>
                    )}
                    <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <button className="btn btn-secondary btn-sm" onClick={startEdit}>Editar manualmente</button>
                      {scoreMsg && <span style={{ fontSize: "0.8rem", color: "var(--success)" }}>{scoreMsg}</span>}
                    </div>
                    <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.75rem" }}>
                      Score e pontos detalhados disponíveis nos resultados do motor (Auditoria do Motor).
                    </p>
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: 0 }}>
                      Deixe em branco para remover o valor. Use ponto ou vírgula como decimal.
                    </p>
                    {[
                      { label: "Idade (dias)", key: "ageDays" as const, placeholder: "ex: 45" },
                      { label: "Custo (R$)", key: "cost" as const, placeholder: "ex: 350.00" },
                      { label: "Venda estimada (R$)", key: "estimatedSale" as const, placeholder: "ex: 800.00" },
                      { label: "Margem (R$)", key: "margin" as const, placeholder: "ex: 150.00" },
                    ].map(({ label, key, placeholder }) => (
                      <div key={key} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                        <label style={{ fontSize: "0.8rem", fontWeight: 500 }}>{label}</label>
                        <input
                          className="input"
                          type="text"
                          inputMode="decimal"
                          placeholder={placeholder}
                          value={scoreEdit[key]}
                          onChange={e => setScoreEdit(se => se ? { ...se, [key]: e.target.value } : se)}
                          style={{ fontSize: "0.9rem" }}
                        />
                      </div>
                    ))}
                    {scoreMsg && <p style={{ fontSize: "0.8rem", color: "var(--danger)", margin: 0 }}>{scoreMsg}</p>}
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button className="btn btn-primary btn-sm" onClick={saveScore} disabled={savingScore}>
                        {savingScore ? <Loader2 size={13} className="spin" /> : null}
                        Salvar
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => { setScoreEdit(null); setScoreMsg(null); }} disabled={savingScore}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {!loading && data && tab === "history" && (
            <div>
              {/* Adicionar observação */}
              <div style={{ padding: "0.75rem 0", borderBottom: "1px solid var(--border)", display: "flex", gap: "0.5rem", flexDirection: "column" }}>
                <textarea
                  className="input"
                  placeholder="Adicionar observação…"
                  rows={2}
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  style={{ resize: "vertical", fontSize: "0.85rem" }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleSaveNote}
                    disabled={savingNote || noteText.trim().length < 2}
                    style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
                  >
                    {savingNote ? <Loader2 size={13} className="spin" /> : <MessageSquarePlus size={13} />}
                    Adicionar observação
                  </button>
                </div>
              </div>

              {/* Timeline */}
              <div className="history-list">
                {data.history.length === 0 && (
                  <p style={{ color: "var(--muted)", fontSize: "0.85rem", padding: "1rem 0" }}>
                    Não há eventos operacionais registrados para este aparelho.
                  </p>
                )}
                {data.history.map(h => (
                  <div key={h.id} className="history-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: "0.2rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                      <Clock size={12} />
                      <span style={{ fontWeight: 500 }}>{eventLabel(h.event_type)}</span>
                      <span style={{ color: "var(--muted)", marginLeft: "auto", fontSize: "0.75rem" }}>
                        {h.created_at.slice(0, 16).replace("T", " ")}
                      </span>
                    </div>
                    {(h.previous_status || h.new_status) && (
                      <div style={{ fontSize: "0.77rem", color: "var(--muted)", paddingLeft: "1.2rem" }}>
                        {h.previous_status && <span>{h.previous_status.replace(/_/g, " ")}</span>}
                        {h.previous_status && h.new_status && <span> → </span>}
                        {h.new_status && <span style={{ color: "var(--accent)" }}>{h.new_status.replace(/_/g, " ")}</span>}
                      </div>
                    )}
                    {h.responsible_name && (
                      <div style={{ fontSize: "0.77rem", color: "var(--muted)", paddingLeft: "1.2rem" }}>
                        {h.responsible_name}
                      </div>
                    )}
                    {h.notes && (
                      <div style={{ fontSize: "0.82rem", paddingLeft: "1.2rem", paddingTop: "0.1rem" }}>
                        {h.notes}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ActionConfirmModal */}
        {confirmState && (
          <div className="modal-overlay" onClick={() => setConfirmState(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
              <ActionConfirmModal
                state={confirmState}
                data={data}
                technicians={technicians}
                selectedTechId={selectedTechId}
                onSelectTech={setSelectedTechId}
                onChangeNotes={notes => setConfirmState(s => s ? { ...s, notes } : s)}
                onChangeTargetStatus={targetStatus => setConfirmState(s => s ? { ...s, targetStatus } : s)}
                cancelReason={cancelReason}
                onConfirm={() => executeConfirmedAction(confirmState)}
                onCancel={() => setConfirmState(null)}
                working={working}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ActionConfirmModalProps {
  state: ActionConfirmState;
  data: CaseDetail | null;
  technicians: Array<{ id: number; name: string }>;
  selectedTechId: number | null;
  onSelectTech: (id: number) => void;
  onChangeNotes: (notes: string) => void;
  onChangeTargetStatus: (status: string) => void;
  cancelReason: string;
  onConfirm: () => void;
  onCancel: () => void;
  working: boolean;
}

const ACTION_META: Record<ConfirmAction, { title: string; warn: string; showNotes?: boolean; notesRequired?: boolean }> = {
  SEPARATE_KIT: { title: "Separar kit completo", warn: "Todas as peças do motor serão reservadas no estoque." },
  SEPARATE_PARTIAL: { title: "Separar peças disponíveis", warn: "Apenas as peças com saldo disponível serão reservadas." },
  CANCEL_RESERVATION: { title: "Cancelar reserva", warn: "A reserva será liberada e o estoque ficará disponível novamente." },
  ADD_TO_PURCHASE: { title: "Incluir em compra", warn: "As peças sem saldo serão incluídas em uma solicitação de compra." },
  DIRECT_TO_TECHNICIAN: { title: "Direcionar ao técnico", warn: "O aparelho ficará aguardando início de reparo.", showNotes: true },
  REDIRECT_TECHNICIAN: { title: "Alterar técnico", warn: "O técnico responsável será substituído. O registro fica no histórico.", showNotes: true },
  START_REPAIR: { title: "Iniciar reparo", warn: "O status mudará para EM REPARO. As peças permanecerão reservadas." },
  COMPLETE_REPAIR: { title: "Concluir reparo", warn: "As peças reservadas serão consumidas do estoque. Esta ação não pode ser desfeita.", showNotes: true },
  CLOSE_CASE: { title: "Finalizar card", warn: "O card será marcado como CONCLUÍDO e removido da fila ativa.", showNotes: true, notesRequired: true },
  SET_STATUS: { title: "Alterar fase", warn: "A fase do aparelho será alterada manualmente. A justificativa fica registrada para auditoria.", showNotes: true, notesRequired: true },
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "EM_ANALISE", label: "Em análise" },
  { value: "PEDIR_PECA", label: "Pedir peça" },
  { value: "AGUARDANDO_RECEBIMENTO", label: "Aguardando recebimento" },
  { value: "MATCH_PARCIAL", label: "Match parcial" },
  { value: "MATCH", label: "Match" },
  { value: "EM_SEPARACAO", label: "Em separação" },
  { value: "APTO_REPARO", label: "Apto para reparo" },
  { value: "DIRECIONADO_TECNICO", label: "Direcionado ao técnico" },
  { value: "EM_REPARO", label: "Em reparo" },
  { value: "REPARO_EXECUTADO", label: "Reparo executado" },
  { value: "TRIAGEM_FINAL", label: "Triagem final" },
  { value: "RETORNO_TECNICO", label: "Retorno técnico" },
  { value: "VERIFICAR", label: "Verificar" },
  { value: "CONCLUIDO", label: "Concluído" },
  { value: "VENDA_ESTADO", label: "Venda no estado" },
  { value: "CANCELADO", label: "Cancelado" },
];

function ActionConfirmModal({ state, data, technicians, selectedTechId, onSelectTech, onChangeNotes, onChangeTargetStatus, cancelReason, onConfirm, onCancel, working }: ActionConfirmModalProps) {
  const meta = ACTION_META[state.action];
  const modelStr = data ? [data.model, data.capacity].filter(Boolean).join(" ") : "Aparelho";

  const isDirectTech = state.action === "DIRECT_TO_TECHNICIAN" || state.action === "REDIRECT_TECHNICIAN";
  const canConfirm = !working && (
    isDirectTech ? selectedTechId != null :
    state.action === "CANCEL_RESERVATION" ? cancelReason.length > 0 :
    state.action === "CLOSE_CASE" ? state.notes.trim().length > 0 :
    state.action === "SET_STATUS" ? (state.notes.trim().length > 0 && !!state.targetStatus) :
    true
  );

  return (
    <>
      <h3 style={{ marginBottom: "0.75rem" }}>{meta.title}</h3>
      <div style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        <div><strong>Aparelho:</strong> {modelStr}</div>
        {data && <div><strong>Status atual:</strong> {data.workflowStatus.replace(/_/g, " ")}</div>}
      </div>
      <p style={{ fontSize: "0.82rem", color: "var(--warning)", background: "var(--warning-subtle, rgba(234,179,8,0.1))", borderRadius: 6, padding: "0.5rem 0.75rem", marginBottom: "0.75rem" }}>
        ⚠ {meta.warn}
      </p>

      {isDirectTech && (
        <div style={{ marginBottom: "0.75rem" }}>
          {technicians.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Nenhum técnico ativo cadastrado.</p>
          ) : (
            <div className="tech-list">
              {technicians.map(t => (
                <label key={t.id} className={`tech-option ${selectedTechId === t.id ? "selected" : ""}`}>
                  <input type="radio" name="tech-confirm" onChange={() => onSelectTech(t.id)} />
                  <Users size={14} /> {t.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {state.action === "SET_STATUS" && (
        <div style={{ marginBottom: "0.75rem" }}>
          <select
            className="input"
            value={state.targetStatus ?? ""}
            onChange={e => onChangeTargetStatus(e.target.value)}
            style={{ fontSize: "0.85rem" }}
          >
            <option value="">Selecione a nova fase…</option>
            {STATUS_OPTIONS.filter(o => o.value !== data?.workflowStatus).map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

      {meta.showNotes && (
        <textarea
          className="input"
          placeholder={meta.notesRequired ? "Justificativa obrigatória…" : "Observação (opcional)…"}
          rows={2}
          value={state.notes}
          onChange={e => onChangeNotes(e.target.value)}
          style={{ marginBottom: "0.75rem", resize: "vertical", fontSize: "0.85rem" }}
        />
      )}

      <div className="modal-actions">
        <button className="btn-ghost" onClick={onCancel}>Cancelar</button>
        <button
          className={state.action === "COMPLETE_REPAIR" || state.action === "CANCEL_RESERVATION" ? "btn-danger" : "btn-primary"}
          onClick={onConfirm}
          disabled={!canConfirm}
        >
          {working ? <Loader2 size={14} className="spin" /> : null}
          Confirmar
        </button>
      </div>
    </>
  );
}
