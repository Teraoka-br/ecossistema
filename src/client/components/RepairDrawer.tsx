import { useState, useEffect } from "react";
import {
  X, Package, Clock, Star, ChevronRight, AlertTriangle, CheckCircle2,
  UserCheck, History, Info, Loader2, Users,
} from "lucide-react";

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
  parts: PartInfo[];
  nextAction: { code: string; label: string; description: string; enabled: boolean };
  technician: { id: number; name: string } | null;
  directedTechnician: { id: number; name: string } | null;
  history: Array<{ id: number; event_type: string; created_at: string; created_by?: string }>;
}

interface RepairDrawerProps {
  repairCaseId: number;
  onClose: (refresh: boolean) => void;
  userRole: "ADMIN" | "OPERATOR";
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

type DrawerTab = "parts" | "score" | "history";

export function RepairDrawer({ repairCaseId, onClose }: RepairDrawerProps) {
  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DrawerTab>("parts");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [technicians, setTechnicians] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedTechId, setSelectedTechId] = useState<number | null>(null);
  const [showDirectModal, setShowDirectModal] = useState(false);
  const [cancelingPartId, setCancelingPartId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelReasonCode, setCancelReasonCode] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [didChange, setDidChange] = useState(false);

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
      .then((d: { staff: Array<{ id: number; name: string; active: boolean }> }) => {
        setTechnicians(d.staff.filter(m => m.active));
      })
      .catch(() => {});
  }, []);

  function refresh(changed = true) {
    if (changed) setDidChange(true);
    setRefreshCount(c => c + 1);
  }

  async function handleSeparateKit() {
    if (!data) return;
    setWorking(true);
    setError(null);
    try {
      // Backend determina quais peças e referências reservar — não enviamos partes do cliente
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/reserve-kit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? "Erro ao reservar kit");
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setWorking(false);
    }
  }

  async function handleSeparatePartial() {
    if (!data) return;
    const disponivel = data.parts.filter(p => p.matchResultStatus === "MATCH_PARCIAL" && p.reservationId === null && p.availableQty > 0);
    if (disponivel.length === 0) return;

    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/reserve-partial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: disponivel.map(p => ({
            partRequestId: p.id,
            chavePeca: p.chavePeca ?? "",
            reference: p.allocatedReference,
            quantity: 1,
          })),
        }),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? "Erro ao reservar parcial");
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setWorking(false);
    }
  }

  async function handleCancelReservation() {
    if (!cancelingPartId || !cancelReason) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/release-reservation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partRequestId: cancelingPartId, reason: cancelReason, reasonCode: cancelReasonCode || undefined }),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? "Erro ao cancelar reserva");
      }
      setCancelingPartId(null);
      setCancelReason("");
      setCancelReasonCode("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setWorking(false);
    }
  }

  async function handleDirectToTechnician() {
    if (!selectedTechId) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/fila-reparos/${repairCaseId}/direct-technician`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ technicianId: selectedTechId }),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? "Erro ao direcionar");
      }
      setShowDirectModal(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setWorking(false);
    }
  }

  const modelStr = data ? [data.model, data.capacity].filter(Boolean).join(" ") : "";

  return (
    <div className="drawer-overlay" onClick={() => onClose(didChange)}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {data?.manualPriorityActive && <Star size={14} fill="currentColor" style={{ color: "var(--warning)" }} />}
              <span className="drawer-title">{modelStr || "Aparelho"}</span>
              {data?.color && <span className="drawer-sub">{data.color}</span>}
            </div>
            <div className="drawer-meta">
              {data?.imei && <span>IMEI {data.imei}</span>}
              {data?.os && <span>OS {data.os}</span>}
              {data?.repairDate && <span>{data.repairDate}</span>}
              {data?.ageDays != null && <span>{data.ageDays}d</span>}
            </div>
          </div>
          <button className="btn-ghost-sm" onClick={() => onClose(didChange)}>
            <X size={16} />
          </button>
        </div>

        {/* Linha do processo */}
        {data && (
          <div className="process-line">
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
        <div className="drawer-tabs">
          <button className={`drawer-tab ${tab === "parts" ? "active" : ""}`} onClick={() => setTab("parts")}>
            <Package size={13} /> Peças
          </button>
          <button className={`drawer-tab ${tab === "score" ? "active" : ""}`} onClick={() => setTab("score")}>
            <Info size={13} /> Prioridade
          </button>
          <button className={`drawer-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
            <History size={13} /> Histórico
          </button>
        </div>

        <div className="drawer-body">
          {loading && <div className="loading-state"><Loader2 size={18} className="spin" /></div>}
          {error && <div className="error-banner">{error}</div>}

          {!loading && data && tab === "parts" && (
            <>
              {/* Action CTA */}
              {data.nextAction.enabled && (
                <div className="drawer-cta">
                  <div>
                    <div className="cta-label">{data.nextAction.label}</div>
                    <div className="cta-desc">{data.nextAction.description}</div>
                  </div>
                  {data.nextAction.code === "SEPARATE_KIT" && (
                    <button className="btn-primary" onClick={handleSeparateKit} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <Package size={14} />}
                      Separar kit
                    </button>
                  )}
                  {data.nextAction.code === "SEPARATE_AVAILABLE" && (
                    <button className="btn-primary" onClick={handleSeparatePartial} disabled={working}>
                      {working ? <Loader2 size={14} className="spin" /> : <Package size={14} />}
                      Separar disponíveis
                    </button>
                  )}
                  {data.nextAction.code === "DIRECT_TO_TECHNICIAN" && (
                    <button className="btn-primary" onClick={() => setShowDirectModal(true)} disabled={working}>
                      <UserCheck size={14} />
                      Direcionar
                    </button>
                  )}
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
                      <span className={p.availableQty > 0 ? "stock-ok" : "stock-zero"}>
                        {p.availableQty} disp.
                      </span>
                      {p.reservedQty > 0 && <span className="stock-reserved">{p.reservedQty} res.</span>}
                    </div>
                    <div className="part-status">
                      {p.matchResultStatus === "MATCH" && <CheckCircle2 size={13} style={{ color: "var(--success)" }} />}
                      {p.matchResultStatus === "MATCH_PARCIAL" && <Package size={13} style={{ color: "var(--warning)" }} />}
                      {p.matchResultStatus === "PEDIR_PECA" && <AlertTriangle size={13} style={{ color: "var(--muted)" }} />}
                      <span>{p.status}</span>
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

              {/* Cancel reservation modal */}
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
                        onClick={handleCancelReservation}
                        disabled={!cancelReason || working}
                      >
                        {working ? <Loader2 size={14} className="spin" /> : null}
                        Confirmar cancelamento
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Direct to technician modal */}
              {showDirectModal && (
                <div className="modal-overlay" onClick={() => setShowDirectModal(false)}>
                  <div className="modal" onClick={e => e.stopPropagation()}>
                    <h3>Direcionar ao técnico</h3>
                    <div className="tech-list">
                      {technicians.map(t => (
                        <label key={t.id} className={`tech-option ${selectedTechId === t.id ? "selected" : ""}`}>
                          <input type="radio" name="technician" onChange={() => setSelectedTechId(t.id)} />
                          <Users size={14} />
                          {t.name}
                        </label>
                      ))}
                    </div>
                    <div className="modal-actions">
                      <button className="btn-ghost" onClick={() => setShowDirectModal(false)}>Cancelar</button>
                      <button
                        className="btn-primary"
                        onClick={handleDirectToTechnician}
                        disabled={!selectedTechId || working}
                      >
                        {working ? <Loader2 size={14} className="spin" /> : <UserCheck size={14} />}
                        Confirmar direcionamento
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {!loading && data && tab === "score" && (
            <div className="score-section">
              <div className="score-row">
                <span>Idade</span>
                <span>{data.ageDays ?? "—"} dias</span>
              </div>
              <div className="score-row">
                <span>Custo</span>
                <span>{data.cost != null ? `R$ ${data.cost.toFixed(2)}` : "—"}</span>
              </div>
              <div className="score-row">
                <span>Venda estimada</span>
                <span>{data.estimatedSale != null ? `R$ ${data.estimatedSale.toFixed(2)}` : "—"}</span>
              </div>
              <div className="score-row">
                <span>Margem</span>
                <span style={{ color: (data.margin ?? 0) >= 0 ? "var(--success)" : "var(--danger)" }}>
                  {data.margin != null ? `R$ ${data.margin.toFixed(2)}` : "—"}
                </span>
              </div>
              <div className="score-row">
                <span>Técnico</span>
                <span>{data.technician?.name ?? data.directedTechnician?.name ?? "—"}</span>
              </div>
              <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "1rem" }}>
                Score e pontos detalhados disponíveis nos resultados do motor (Auditoria do Motor).
              </p>
            </div>
          )}

          {!loading && data && tab === "history" && (
            <div className="history-list">
              {data.history.length === 0 && <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Sem histórico registrado.</p>}
              {data.history.map(h => (
                <div key={h.id} className="history-row">
                  <Clock size={12} />
                  <span>{h.event_type}</span>
                  <span style={{ color: "var(--muted)", marginLeft: "auto", fontSize: "0.75rem" }}>
                    {h.created_at.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
