import { useState, useEffect } from "react";
import {
  X, Package, Clock, Star, ChevronRight, AlertTriangle, CheckCircle2,
  UserCheck, History, Info, Loader2, Users, ShoppingCart, MessageSquarePlus,
  RefreshCw, MapPin, Edit2, Save, Wrench, CheckCheck, ArrowRight,
  CircleDot, FileText,
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

interface MatchCaseResult {
  runId: number;
  eligible: boolean;
  resultStatus: string;
  verifyReasons: string[];
  margin: number | null;
  marginPoints: number | null;
  agePoints: number | null;
  score: number | null;
  priorityRank: number | null;
  ruleSetId: number | null;
  ruleSetVersion: number | null;
  ruleName: string | null;
  depositoAtual: string | null;
  computedAt: string;
}

interface CaseDetail {
  id: number;
  imei: string | null;
  os: string | null;
  brand: string | null;
  model: string | null;
  capacity: string | null;
  color: string | null;
  problema: string | null;
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
  matchCaseResult: MatchCaseResult | null;
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
  DADOS_SCORE_EDITADOS: "Custo/venda/idade corrigidos",
  DEPOSITO_ALTERADO: "Depósito alterado",
  INFO_EDITADA: "Informações editadas",
  STATUS_ALTERADO: "Status alterado manualmente",
};

const EVENT_ICONS: Record<string, typeof Clock> = {
  NOTE_ADDED: MessageSquarePlus,
  DIRECTED_TO_TECHNICIAN: UserCheck,
  REPAIR_STARTED: Wrench,
  REPAIR_COMPLETED: CheckCheck,
  RESERVATION_CREATED: Package,
  RESERVATION_RELEASED: X,
  KIT_RESERVED: Package,
  DADOS_SCORE_EDITADOS: Edit2,
  DEPOSITO_ALTERADO: MapPin,
  MATCH_STATUS_CHANGED: ArrowRight,
  STATUS_ALTERADO: RefreshCw,
};

const VERIFY_REASON_LABELS: Record<string, string> = {
  IMEI_AUSENTE: "IMEI ausente",
  MODELO_AUSENTE: "Modelo ausente",
  CUSTO_AUSENTE: "Custo ausente",
  VENDA_ESTIMADA_AUSENTE: "Venda estimada ausente",
  IDADE_AUSENTE: "Idade ausente",
  DEPOSITO_NAO_IDENTIFICADO: "Depósito não identificado (não consta no Rel. Seriais Com Saldo)",
  DEPOSITO_FORA_DO_FLUXO: "Depósito fora do fluxo (só AGUARDANDO PEÇA e MANUTENÇÃO INTERNA participam)",
  PECA_NECESSARIA_AUSENTE: "Nenhuma peça necessária cadastrada",
  REFERENCIA_PECA_NAO_RESOLVIDA: "Referência de peça não resolvida",
  MAIS_DE_UMA_REFERENCIA_POSSIVEL: "Mais de uma referência possível — vincule a compatibilidade correta",
};

function verifyReasonLabel(code: string): string {
  return VERIFY_REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

function fmtPts(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ").toLowerCase().replace(/^\w/, c => c.toUpperCase());
}

function fmtDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function statusLabel(s: string): string {
  return s.replace(/_/g, " ");
}

type DrawerTab = "parts" | "score" | "history";
type ConfirmAction =
  | "SEPARATE_KIT" | "SEPARATE_PARTIAL" | "CANCEL_RESERVATION" | "ADD_TO_PURCHASE"
  | "DIRECT_TO_TECHNICIAN" | "REDIRECT_TECHNICIAN" | "START_REPAIR" | "COMPLETE_REPAIR"
  | "CLOSE_CASE" | "SET_STATUS" | "SEND_TO_TRIAGEM";

interface ActionConfirmState {
  action: ConfirmAction;
  partId?: number;
  notes: string;
  targetStatus?: string;
  closeStatus?: string;
}

interface InfoEdit {
  brand: string;
  model: string;
  color: string;
  capacity: string;
  problema: string;
}

export function RepairDrawer({ repairCaseId, onClose, userRole, userPermissions }: RepairDrawerProps) {
  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DrawerTab>("parts");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [technicians, setTechnicians] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedTechId, setSelectedTechId] = useState<number | null>(null);
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

  // Deposito edit with autocomplete
  const [depositoEdit, setDepositoEdit] = useState<string | null>(null);
  const [savingDeposito, setSavingDeposito] = useState(false);
  const [depositoSuggestions, setDepositoSuggestions] = useState<string[]>([]);

  // Info (brand/model/color/capacity/problema) edit
  const [showInfoEdit, setShowInfoEdit] = useState(false);
  const [infoEdit, setInfoEdit] = useState<InfoEdit | null>(null);
  const [savingInfo, setSavingInfo] = useState(false);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // Confirm modal
  const [confirmState, setConfirmState] = useState<ActionConfirmState | null>(null);

  const isAdmin = userRole === "ADMIN" || userPermissions?.includes("OVERRIDE_REPAIR_STATUS");

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

    fetch("/api/depositos")
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((list: string[]) => setDepositoSuggestions(list))
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

  function startInfoEdit() {
    if (!data) return;
    setInfoEdit({
      brand: data.brand ?? "",
      model: data.model ?? "",
      color: data.color ?? "",
      capacity: data.capacity ?? "",
      problema: data.problema ?? "",
    });
    setInfoMsg(null);
    setShowInfoEdit(true);
  }

  async function saveInfo() {
    if (!infoEdit) return;
    setSavingInfo(true);
    setInfoMsg(null);
    try {
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/info`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: infoEdit.brand.trim() || null,
          model: infoEdit.model.trim() || null,
          color: infoEdit.color.trim() || null,
          capacity: infoEdit.capacity.trim() || null,
          problema: infoEdit.problema.trim() || null,
        }),
      });
      if (!r.ok) throw new Error((await r.json() as { error?: string }).error ?? "Erro");
      setShowInfoEdit(false);
      setInfoEdit(null);
      setInfoMsg("Salvo.");
      refresh();
    } catch (e) {
      setInfoMsg(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setSavingInfo(false);
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
        case "SEND_TO_TRIAGEM": {
          const r = await fetch(`/api/fila-reparos/${repairCaseId}/override-status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toStatus: "TRIAGEM_FINAL", notes: state.notes || undefined }),
          });
          if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao enviar para triagem"); }
          break;
        }
        case "CLOSE_CASE": {
          const closeStatus = state.closeStatus ?? "CONCLUIDO";
          if (closeStatus === "CONCLUIDO") {
            const r = await fetch(`/api/fila-reparos/${repairCaseId}/close`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "CONCLUIDO", notes: state.notes }),
            });
            if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao finalizar card"); }
          } else {
            const r = await fetch(`/api/fila-reparos/${repairCaseId}/override-status`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ toStatus: closeStatus, notes: state.notes }),
            });
            if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? "Erro ao finalizar card"); }
          }
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
  const showRedirectTech = ["DIRECIONADO_TECNICO", "EM_REPARO", "REPARO_EXECUTADO", "RETORNO_TECNICO", "TRIAGEM_FINAL"].includes(ws);
  const showStartRepair = ws === "DIRECIONADO_TECNICO";
  const showCompleteRepair = ws === "EM_REPARO";
  const showEnviarTriagem = ws === "REPARO_EXECUTADO";
  const showFinalizar = ws === "TRIAGEM_FINAL" || ws === "RETORNO_TECNICO";

  const statusColor = ((): string => {
    if (ws === "VERIFICAR") return "var(--warning)";
    if (ws === "VENDA_ESTADO") return "var(--danger)";
    if (ws === "CONCLUIDO") return "var(--success)";
    if (ws === "CANCELADO") return "var(--muted)";
    return "var(--accent)";
  })();

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
          width: "min(1100px, calc(100vw - 2rem))", maxHeight: "92vh",
          borderRadius: "var(--r-md, 8px)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div className="drawer-header" style={{ flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              {data?.manualPriorityActive && <Star size={14} fill="currentColor" style={{ color: "var(--warning)" }} />}
              <span className="drawer-title">{data?.brand ? `${data.brand} ${modelStr}`.trim() : (modelStr || "Aparelho")}</span>
              {data?.color && <span className="drawer-sub">{data.color}</span>}
              {data?.capacity && !modelStr.includes(data.capacity) && <span className="drawer-sub">{data.capacity}</span>}
              {data && (
                <span style={{
                  marginLeft: "auto", fontSize: "0.75rem", padding: "2px 10px", borderRadius: 12,
                  background: `color-mix(in srgb, ${statusColor} 15%, transparent)`,
                  color: statusColor, fontWeight: 600, letterSpacing: "0.03em",
                }}>
                  {statusLabel(data.workflowStatus)}
                </span>
              )}
            </div>

            {/* Linha de meta */}
            <div className="drawer-meta" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem 1rem", marginTop: "0.35rem" }}>
              {data?.os && (
                <span style={{ fontWeight: 700, color: "var(--accent)", fontSize: "0.82rem" }}>OS {data.os}</span>
              )}
              {data?.imei && <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>IMEI {data.imei}</span>}
              {data?.repairDate && <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{data.repairDate}</span>}
              {data?.ageDays != null && <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{data.ageDays}d</span>}
              {(data?.technician ?? data?.directedTechnician) && (
                <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                  Técnico: {data!.technician?.name ?? data!.directedTechnician?.name}
                </span>
              )}

              {/* Depósito com autocomplete */}
              {depositoEdit !== null ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                  <input
                    list="deposito-suggestions"
                    value={depositoEdit}
                    onChange={e => setDepositoEdit(e.target.value)}
                    placeholder="Nome do depósito…"
                    style={{
                      fontSize: "0.78rem", padding: "0.15rem 0.4rem",
                      borderRadius: "var(--r-sm)", border: "1px solid var(--border)",
                      background: "var(--surface-alt)", color: "var(--text)", width: 180,
                    }}
                    onKeyDown={e => { if (e.key === "Enter") void saveDeposito(); if (e.key === "Escape") setDepositoEdit(null); }}
                    autoFocus
                  />
                  <datalist id="deposito-suggestions">
                    {depositoSuggestions.map(d => <option key={d} value={d} />)}
                  </datalist>
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
                  style={{
                    background: "none", border: "none", padding: "0.1rem 0.3rem",
                    cursor: "pointer", fontSize: "0.75rem", color: "var(--text-muted)",
                    borderRadius: "var(--r-sm)", display: "inline-flex", alignItems: "center", gap: "0.25rem",
                  }}
                  title="Mover para depósito"
                >
                  <MapPin size={11} />
                  {data?.depositoAtual ?? "Sem depósito"}
                </button>
              )}

              {/* Botão editar info */}
              {isAdmin && data && !showInfoEdit && (
                <button
                  onClick={startInfoEdit}
                  style={{
                    background: "none", border: "none", padding: "0.1rem 0.3rem",
                    cursor: "pointer", fontSize: "0.72rem", color: "var(--muted)",
                    borderRadius: "var(--r-sm)", display: "inline-flex", alignItems: "center", gap: "0.2rem",
                  }}
                  title="Editar marca/modelo/cor/capacidade/problema"
                >
                  <Edit2 size={11} /> Editar info
                </button>
              )}
            </div>

            {/* Problema */}
            {data?.problema && !showInfoEdit && (
              <div style={{
                marginTop: "0.4rem", fontSize: "0.82rem",
                color: "var(--text)", background: "var(--surface-alt)",
                borderLeft: "3px solid var(--accent)", borderRadius: "0 4px 4px 0",
                padding: "0.3rem 0.6rem", display: "flex", alignItems: "center", gap: "0.4rem",
              }}>
                <FileText size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span><strong>Problema:</strong> {data.problema}</span>
              </div>
            )}

            {/* Painel de edição de info */}
            {showInfoEdit && infoEdit && (
              <div style={{
                marginTop: "0.5rem", padding: "0.75rem",
                background: "var(--surface-alt)", borderRadius: "var(--r-md)",
                border: "1px solid var(--border)",
              }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  {(["brand", "model", "color", "capacity"] as const).map(k => (
                    <label key={k} style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.78rem" }}>
                      <span style={{ fontWeight: 500, color: "var(--muted)", textTransform: "capitalize" }}>
                        {{ brand: "Marca", model: "Modelo", color: "Cor", capacity: "Capacidade" }[k]}
                      </span>
                      <input
                        className="input"
                        style={{ fontSize: "0.82rem", padding: "0.3rem 0.5rem" }}
                        value={infoEdit[k]}
                        onChange={e => setInfoEdit(ie => ie ? { ...ie, [k]: e.target.value } : ie)}
                      />
                    </label>
                  ))}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.78rem", marginBottom: "0.5rem" }}>
                  <span style={{ fontWeight: 500, color: "var(--muted)" }}>Problema / defeito relatado</span>
                  <textarea
                    className="input"
                    rows={2}
                    style={{ fontSize: "0.82rem", resize: "vertical" }}
                    value={infoEdit.problema}
                    onChange={e => setInfoEdit(ie => ie ? { ...ie, problema: e.target.value } : ie)}
                    placeholder="Descreva o defeito relatado pelo cliente…"
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <button className="btn btn-primary btn-sm" onClick={() => void saveInfo()} disabled={savingInfo}>
                    {savingInfo ? <Loader2 size={12} className="spin" /> : <Save size={12} />} Salvar
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setShowInfoEdit(false); setInfoEdit(null); setInfoMsg(null); }} disabled={savingInfo}>
                    Cancelar
                  </button>
                  {infoMsg && <span style={{ fontSize: "0.78rem", color: infoMsg === "Salvo." ? "var(--success)" : "var(--danger)" }}>{infoMsg}</span>}
                </div>
              </div>
            )}
          </div>
          <button className="btn-ghost-sm" onClick={() => onClose(didChange)} style={{ alignSelf: "flex-start", marginLeft: "0.5rem" }}>
            <X size={16} />
          </button>
        </div>

        {/* Linha do processo */}
        {data && (
          <div className="process-line" style={{ flexShrink: 0 }}>
            {["Análise", "Match", "Separação", "Técnico", "Triagem", "Conclusão"].map((step, i) => {
              const active = (
                (i === 0 && ["EM_ANALISE", "VERIFICAR"].includes(data.workflowStatus)) ||
                (i === 1 && ["MATCH", "MATCH_PARCIAL", "PEDIR_PECA", "AGUARDANDO_RECEBIMENTO"].includes(data.workflowStatus)) ||
                (i === 2 && ["EM_SEPARACAO", "APTO_REPARO"].includes(data.workflowStatus)) ||
                (i === 3 && ["DIRECIONADO_TECNICO", "EM_REPARO"].includes(data.workflowStatus)) ||
                (i === 4 && ["REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO"].includes(data.workflowStatus)) ||
                (i === 5 && ["CONCLUIDO", "VENDA_ESTADO", "CANCELADO"].includes(data.workflowStatus))
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
            <Info size={13} /> Análise
          </button>
          <button className={`drawer-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
            <History size={13} /> Histórico
            {data && data.history.length > 0 && (
              <span style={{ marginLeft: 4, fontSize: "0.7rem", background: "var(--accent)", color: "#fff", borderRadius: 10, padding: "0 5px" }}>
                {data.history.length}
              </span>
            )}
          </button>
        </div>

        {/* Corpo */}
        <div className="drawer-body" style={{ overflowY: "auto", flex: 1 }}>
          {loading && <div className="loading-state"><Loader2 size={18} className="spin" /></div>}

          {/* Banner VERIFICAR — pendências bloqueando o motor */}
          {!loading && data && (data.workflowStatus === "VERIFICAR" || (data.matchCaseResult && data.matchCaseResult.verifyReasons.length > 0)) && (
            <div style={{
              margin: "0.75rem 0", padding: "0.75rem 1rem",
              border: "1px solid var(--warn-border, rgba(245,158,11,0.4))",
              background: "rgba(245,158,11,0.08)", borderRadius: "var(--r-md)",
            }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--warning)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <AlertTriangle size={14} /> Pendências para participar do motor de match
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                {(data.matchCaseResult?.verifyReasons ?? []).map(r => (
                  <li key={r}>{verifyReasonLabel(r)}</li>
                ))}
                {(!data.matchCaseResult || data.matchCaseResult.verifyReasons.length === 0) && data.workflowStatus === "VERIFICAR" && (
                  <li>Pendência identificada — rode o motor para ver detalhes.</li>
                )}
              </ul>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.4rem" }}>
                Corrija os dados na aba <strong>Análise</strong> (custo/venda/idade), no depósito acima, ou edite as informações do aparelho.
              </div>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          {/* ─── ABA PEÇAS ─── */}
          {!loading && data && tab === "parts" && (
            <>
              {/* CTA principal */}
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
                  {showStartRepair && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "START_REPAIR", notes: "" })} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <Wrench size={14} />}
                      Iniciar reparo
                    </button>
                  )}
                  {showCompleteRepair && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "COMPLETE_REPAIR", notes: "" })} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                      Concluir reparo
                    </button>
                  )}
                  {showEnviarTriagem && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "SEND_TO_TRIAGEM", notes: "" })} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
                      Enviar para triagem
                    </button>
                  )}
                  {showFinalizar && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "CLOSE_CASE", notes: "", closeStatus: "CONCLUIDO" })} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <CheckCheck size={14} />}
                      Finalizar card
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
                </div>
              )}

              {/* CTA para REPARO_EXECUTADO/TRIAGEM_FINAL quando nextAction.enabled = false */}
              {!data.nextAction.enabled && (showEnviarTriagem || showFinalizar) && (
                <div className="drawer-cta">
                  <div>
                    <div className="cta-label">{showEnviarTriagem ? "Reparo concluído" : "Triagem em andamento"}</div>
                    <div className="cta-desc">{showEnviarTriagem ? "Envie para a triagem final." : "Confirme o resultado do aparelho."}</div>
                  </div>
                  {showEnviarTriagem && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "SEND_TO_TRIAGEM", notes: "" })} disabled={working}>
                      <ArrowRight size={14} /> Enviar para triagem
                    </button>
                  )}
                  {showFinalizar && (
                    <button className="btn-primary" onClick={() => setConfirmState({ action: "CLOSE_CASE", notes: "", closeStatus: "CONCLUIDO" })} disabled={working}>
                      <CheckCheck size={14} /> Finalizar card
                    </button>
                  )}
                  {showRedirectTech && (
                    <button className="btn-secondary" onClick={() => setConfirmState({ action: "REDIRECT_TECHNICIAN", notes: "" })} disabled={working} style={{ fontSize: "0.8rem" }}>
                      <RefreshCw size={13} /> Alterar técnico
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
                      disabled={working}
                      style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
                    >
                      {working ? <Loader2 size={13} className="spin" /> : <ShoppingCart size={13} />}
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

              {/* Ações admin */}
              {isAdmin && (
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
                    onClick={() => setConfirmState({ action: "CLOSE_CASE", notes: "", closeStatus: "CONCLUIDO" })}
                    disabled={working}
                    title="Finalizar este card"
                  >
                    <CheckCircle2 size={12} /> Finalizar card
                  </button>
                </div>
              )}

              {/* Lista de peças */}
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
                        <span style={{
                          fontSize: "0.72rem", padding: "1px 5px", borderRadius: "4px",
                          background: p.purchaseOrderStatus === "AWAITING_RECEIPT" || p.purchaseOrderStatus === "PARTIALLY_RECEIVED"
                            ? "var(--warning-subtle, rgba(234,179,8,0.15))" : "var(--accent-subtle, rgba(99,102,241,0.1))",
                          color: p.purchaseOrderStatus === "AWAITING_RECEIPT" || p.purchaseOrderStatus === "PARTIALLY_RECEIVED"
                            ? "var(--warning)" : "var(--accent)",
                        }}>
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

              {/* Modal de cancelar reserva */}
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

          {/* ─── ABA ANÁLISE (score) ─── */}
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
                if (!r.ok) throw new Error((await r.json() as { error?: string }).error ?? "Erro");
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
                    <div className="score-row">
                      <span>Custo</span>
                      <span>{data.cost != null ? `R$ ${data.cost.toFixed(2)}` : <span style={{ color: "var(--warning)" }}>Ausente</span>}</span>
                    </div>
                    <div className="score-row">
                      <span>Venda estimada</span>
                      <span>{data.estimatedSale != null ? `R$ ${data.estimatedSale.toFixed(2)}` : <span style={{ color: "var(--warning)" }}>Ausente</span>}</span>
                    </div>
                    <div className="score-row">
                      <span>Margem</span>
                      <span style={{ color: data.margin == null ? "var(--muted)" : (data.margin ?? 0) >= 0 ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
                        {data.margin != null ? `R$ ${data.margin.toFixed(2)}` : "—"}
                      </span>
                    </div>
                    <div className="score-row"><span>Técnico</span><span>{data.technician?.name ?? data.directedTechnician?.name ?? "—"}</span></div>
                    {data.matchCaseResult && (
                      <>
                        <div className="score-row" style={{ borderTop: "1px solid var(--border)", marginTop: "0.5rem", paddingTop: "0.5rem" }}>
                          <span>Pontos de margem</span><span>{fmtPts(data.matchCaseResult.marginPoints)}</span>
                        </div>
                        <div className="score-row"><span>Pontos de idade</span><span>{fmtPts(data.matchCaseResult.agePoints)}</span></div>
                        <div className="score-row"><span style={{ fontWeight: 600 }}>Score total</span><span style={{ fontWeight: 600 }}>{fmtPts(data.matchCaseResult.score)}</span></div>
                        <div className="score-row"><span>Posição na disputa</span><span>{data.matchCaseResult.priorityRank != null ? `#${data.matchCaseResult.priorityRank}` : "—"}</span></div>
                        <div className="score-row">
                          <span>Regra utilizada</span>
                          <span>{data.matchCaseResult.ruleName ?? "—"} (v{data.matchCaseResult.ruleSetVersion ?? "?"})</span>
                        </div>
                        <div className="score-row"><span>Resultado do motor</span><span>{data.matchCaseResult.resultStatus}</span></div>
                        <div className="score-row"><span>Depósito na avaliação</span><span>{data.matchCaseResult.depositoAtual ?? "—"}</span></div>
                      </>
                    )}
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
                      Margem = venda estimada − custo. O score usa a precisão decimal completa — a formatação acima é apenas visual.
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
                      { label: "Margem (R$)", key: "margin" as const, placeholder: "calculada automaticamente se custo+venda presentes" },
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

          {/* ─── ABA HISTÓRICO ─── */}
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

              {/* Timeline visual */}
              {data.history.length === 0 ? (
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", padding: "1rem 0" }}>
                  Não há eventos registrados para este aparelho.
                </p>
              ) : (
                <div style={{ position: "relative", paddingTop: "0.75rem" }}>
                  {data.history.map((h, idx) => {
                    const Icon = EVENT_ICONS[h.event_type] ?? CircleDot;
                    const isLast = idx === data.history.length - 1;
                    return (
                      <div key={h.id} style={{ display: "flex", gap: "0.75rem", position: "relative", paddingBottom: isLast ? 0 : "1.25rem" }}>
                        {/* Linha vertical */}
                        {!isLast && (
                          <div style={{
                            position: "absolute", left: "0.75rem", top: "1.5rem",
                            width: "1px", bottom: 0,
                            background: "var(--border)",
                          }} />
                        )}
                        {/* Ícone */}
                        <div style={{
                          width: "1.5rem", height: "1.5rem", borderRadius: "50%", flexShrink: 0,
                          background: "var(--surface-alt)", border: "1px solid var(--border)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: "var(--accent)", zIndex: 1,
                        }}>
                          <Icon size={11} />
                        </div>
                        {/* Conteúdo */}
                        <div style={{ flex: 1, minWidth: 0, paddingTop: "0.05rem" }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 600, fontSize: "0.82rem" }}>{eventLabel(h.event_type)}</span>
                            <span style={{ fontSize: "0.72rem", color: "var(--muted)", marginLeft: "auto" }}>{fmtDate(h.created_at)}</span>
                          </div>
                          {(h.previous_status || h.new_status) && (
                            <div style={{ fontSize: "0.77rem", color: "var(--muted)", marginTop: "0.1rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                              {h.previous_status && <span style={{ textDecoration: "line-through" }}>{statusLabel(h.previous_status)}</span>}
                              {h.previous_status && h.new_status && <ArrowRight size={10} />}
                              {h.new_status && <span style={{ color: "var(--accent)", fontWeight: 500 }}>{statusLabel(h.new_status)}</span>}
                            </div>
                          )}
                          {h.responsible_name && (
                            <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.1rem" }}>{h.responsible_name}</div>
                          )}
                          {h.notes && (
                            <div style={{ fontSize: "0.82rem", marginTop: "0.2rem", color: "var(--text)", background: "var(--surface-alt)", borderRadius: "var(--r-sm)", padding: "0.25rem 0.5rem" }}>
                              {h.notes}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal de confirmação de ação */}
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
                onChangeCloseStatus={closeStatus => setConfirmState(s => s ? { ...s, closeStatus } : s)}
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
  onChangeCloseStatus: (status: string) => void;
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
  REDIRECT_TECHNICIAN: { title: "Alterar técnico", warn: "O técnico responsável será substituído. O registro fica no histórico.", showNotes: true, notesRequired: true },
  START_REPAIR: { title: "Iniciar reparo", warn: "O status mudará para EM REPARO. As peças permanecerão reservadas." },
  COMPLETE_REPAIR: { title: "Concluir reparo", warn: "As peças reservadas serão consumidas do estoque. Esta ação não pode ser desfeita.", showNotes: true },
  SEND_TO_TRIAGEM: { title: "Enviar para triagem final", warn: "O aparelho passará para TRIAGEM FINAL.", showNotes: true },
  CLOSE_CASE: { title: "Finalizar card", warn: "O card será removido da fila ativa. Esta ação não pode ser desfeita.", showNotes: true, notesRequired: true },
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

const CLOSE_STATUS_OPTIONS = [
  { value: "CONCLUIDO", label: "Concluído — reparo finalizado com sucesso" },
  { value: "CANCELADO", label: "Cancelado — não vai ser reparado" },
  { value: "VENDA_ESTADO", label: "Venda no estado — vender com defeito" },
];

function ActionConfirmModal({
  state, data, technicians, selectedTechId, onSelectTech,
  onChangeNotes, onChangeTargetStatus, onChangeCloseStatus,
  cancelReason, onConfirm, onCancel, working,
}: ActionConfirmModalProps) {
  const meta = ACTION_META[state.action];
  const modelStr = data ? [data.model, data.capacity].filter(Boolean).join(" ") : "Aparelho";

  const isDirectTech = state.action === "DIRECT_TO_TECHNICIAN" || state.action === "REDIRECT_TECHNICIAN";
  const canConfirm = !working && (
    isDirectTech ? selectedTechId != null :
    state.action === "CANCEL_RESERVATION" ? cancelReason.length > 0 :
    state.action === "CLOSE_CASE" ? (state.notes.trim().length > 0 && !!state.closeStatus) :
    state.action === "SET_STATUS" ? (state.notes.trim().length > 0 && !!state.targetStatus) :
    meta.notesRequired ? state.notes.trim().length > 0 :
    true
  );

  return (
    <>
      <h3 style={{ marginBottom: "0.75rem" }}>{meta.title}</h3>
      <div style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        <div><strong>Aparelho:</strong> {modelStr}</div>
        {data && <div><strong>Status atual:</strong> {statusLabel(data.workflowStatus)}</div>}
      </div>
      <p style={{
        fontSize: "0.82rem", color: "var(--warning)",
        background: "var(--warning-subtle, rgba(234,179,8,0.1))",
        borderRadius: 6, padding: "0.5rem 0.75rem", marginBottom: "0.75rem",
      }}>
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

      {state.action === "CLOSE_CASE" && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 500, marginBottom: "0.4rem" }}>Resultado do card:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {CLOSE_STATUS_OPTIONS.map(opt => (
              <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="close-status"
                  value={opt.value}
                  checked={state.closeStatus === opt.value}
                  onChange={() => onChangeCloseStatus(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {meta.showNotes && (
        <textarea
          className="input"
          placeholder={meta.notesRequired || state.action === "CLOSE_CASE" ? "Justificativa obrigatória…" : "Observação (opcional)…"}
          rows={2}
          value={state.notes}
          onChange={e => onChangeNotes(e.target.value)}
          style={{ marginBottom: "0.75rem", resize: "vertical", fontSize: "0.85rem" }}
        />
      )}

      <div className="modal-actions">
        <button className="btn-ghost" onClick={onCancel}>Cancelar</button>
        <button
          className={state.action === "COMPLETE_REPAIR" || state.action === "CANCEL_RESERVATION" || state.closeStatus === "CANCELADO" ? "btn-danger" : "btn-primary"}
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
