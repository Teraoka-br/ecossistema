import { useEffect, useState } from "react";
import { Loading, ErrorBanner, fmtInt } from "../ui.js";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface SeparationBatch {
  id: number;
  batch_number: string;
  match_run_id: number;
  status: "OPEN" | "PARTIALLY_COMPLETED" | "COMPLETED" | "CANCELLED";
  created_by: string;
  created_at: string;
  notes: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

interface SeparationItem {
  id: number;
  separation_batch_id: number;
  match_device_result_id: number | null;
  id_pedido: string;
  imei: string | null;
  os: string | null;
  description: string | null;
  chave_peca: string | null;
  reference: string | null;
  quantity: number;
  match_result_status: string | null;
  match_allocation_phase: string | null;
  match_consumption_order: number | null;
  status: "RESERVED" | "CONFIRMED" | "CANCELLED";
  reserved_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  cancelled_at: string | null;
  stock_movement_id: number | null;
  operational_event_id: number | null;
}

interface DeviceGroup {
  deviceResultId: number | null;
  imei: string | null;
  os: string | null;
  kitStatus: string | null;
  priorityRank: number | null;
  items: SeparationItem[];
  allConfirmed: boolean;
  allCancelled: boolean;
  hasReserved: boolean;
}

interface BatchTotals {
  totalItems: number;
  reservedItems: number;
  confirmedItems: number;
  cancelledItems: number;
  totalDevices: number;
  completedDevices: number;
}

interface BatchState {
  batch: SeparationBatch;
  totals: BatchTotals;
  devices: DeviceGroup[];
  partialItems: SeparationItem[];
  warnings: string[];
}

interface ListResponse {
  batches: SeparationBatch[];
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  OPEN: "ABERTO",
  PARTIALLY_COMPLETED: "PARCIALMENTE CONCLUÍDO",
  COMPLETED: "CONCLUÍDO",
  CANCELLED: "CANCELADO",
};

const ITEM_STATUS_LABELS: Record<string, string> = {
  RESERVED: "RESERVADO",
  CONFIRMED: "CONFIRMADO",
  CANCELLED: "CANCELADO",
};

const TAB_STATUSES = ["OPEN", "PARTIALLY_COMPLETED", "COMPLETED", "CANCELLED"] as const;

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Erro ${r.status}`);
  }
  return r.json() as Promise<T>;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function Separacao() {
  const [tab, setTab] = useState<(typeof TAB_STATUSES)[number]>("OPEN");
  const [batches, setBatches] = useState<SeparationBatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [batchState, setBatchState] = useState<BatchState | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [responsible, setResponsible] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch<ListResponse>(`/api/separation-batches?status=${tab}&limit=50`);
      setBatches(d.batches);
      setTotal(d.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadBatch(id: number) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchState(null);
    try {
      const d = await apiFetch<BatchState>(`/api/separation-batches/${id}/state`);
      setBatchState(d);
    } catch (e) {
      setBatchError((e as Error).message);
    } finally {
      setBatchLoading(false);
    }
  }

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (selectedBatchId !== null) void loadBatch(selectedBatchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBatchId]);

  function idempotency(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function handleConfirmAll() {
    if (!batchState || !responsible.trim()) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await postJson(`/api/separation-batches/${batchState.batch.id}/confirm-all`, {
        confirmedBy: responsible.trim(),
        idempotencyKey: idempotency(),
      });
      await loadBatch(batchState.batch.id);
      await loadList();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmDevice(devResultId: number) {
    if (!batchState || !responsible.trim()) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await postJson(`/api/separation-batches/${batchState.batch.id}/devices/${devResultId}/confirm`, {
        confirmedBy: responsible.trim(),
        idempotencyKey: idempotency(),
      });
      await loadBatch(batchState.batch.id);
      await loadList();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmItem(itemId: number) {
    if (!batchState || !responsible.trim()) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await postJson(`/api/separation-items/${itemId}/confirm`, {
        confirmedBy: responsible.trim(),
        idempotencyKey: idempotency(),
      });
      await loadBatch(batchState.batch.id);
      await loadList();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCancelBatch() {
    if (!batchState || !responsible.trim() || cancelReason.trim().length < 10) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await postJson(`/api/separation-batches/${batchState.batch.id}/cancel`, {
        cancelledBy: responsible.trim(),
        cancelReason: cancelReason.trim(),
      });
      await loadBatch(batchState.batch.id);
      await loadList();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCancelDevice(devResultId: number) {
    if (!batchState || !responsible.trim() || cancelReason.trim().length < 10) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await postJson(`/api/separation-batches/${batchState.batch.id}/devices/${devResultId}/cancel`, {
        cancelledBy: responsible.trim(),
        cancelReason: cancelReason.trim(),
      });
      await loadBatch(batchState.batch.id);
      await loadList();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCancelItem(itemId: number) {
    if (!batchState || !responsible.trim() || cancelReason.trim().length < 10) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await postJson(`/api/separation-items/${itemId}/cancel`, {
        cancelledBy: responsible.trim(),
        cancelReason: cancelReason.trim(),
      });
      await loadBatch(batchState.batch.id);
      await loadList();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  const isOpen = batchState?.batch.status === "OPEN" || batchState?.batch.status === "PARTIALLY_COMPLETED";

  return (
    <div>
      <h1>Separação de peças</h1>

      {/* Aviso obrigatório */}
      <div className="card" style={{ background: "#fff3cd", borderLeft: "4px solid #f0a500", marginBottom: "1rem" }}>
        <strong>Atenção:</strong> Confirmar a separação retira a unidade do estoque operacional.
        Essa ação não pode ser desfeita diretamente.
      </div>

      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>

        {/* Painel esquerdo — lista */}
        <div style={{ minWidth: 340 }}>
          <div className="card" style={{ padding: "0.5rem 0" }}>
            <div className="row" style={{ padding: "0 0.75rem 0.5rem" }}>
              {TAB_STATUSES.map((s) => (
                <button
                  key={s}
                  className={tab === s ? "" : "secondary"}
                  style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                  onClick={() => { setTab(s); setSelectedBatchId(null); setBatchState(null); }}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            {loading && <Loading />}
            {error && <ErrorBanner message={error} />}
            {!loading && !error && batches.length === 0 && (
              <p className="muted" style={{ padding: "0.75rem" }}>Nenhum lote com status {STATUS_LABELS[tab]}.</p>
            )}
            {batches.map((b) => (
              <div
                key={b.id}
                className={`card ${selectedBatchId === b.id ? "selected" : ""}`}
                style={{ margin: "0.3rem 0.5rem", cursor: "pointer", padding: "0.6rem 0.75rem" }}
                onClick={() => setSelectedBatchId(b.id)}
              >
                <strong>{b.batch_number}</strong>
                <span className={`badge ${b.status === "COMPLETED" ? "ok" : b.status === "CANCELLED" ? "err" : "neutral"}`}
                  style={{ marginLeft: "0.5rem", fontSize: "0.7rem" }}>
                  {STATUS_LABELS[b.status]}
                </span>
                <div className="muted small">
                  Run #{b.match_run_id} · {b.created_by} · {b.created_at.slice(0, 16)}
                </div>
              </div>
            ))}
            {total > batches.length && (
              <p className="muted small" style={{ padding: "0.5rem 0.75rem" }}>
                Mostrando {batches.length} de {total}
              </p>
            )}
          </div>
        </div>

        {/* Painel direito — detalhe */}
        <div style={{ flex: 1 }}>
          {!selectedBatchId && (
            <div className="card muted">Selecione um lote para ver os detalhes.</div>
          )}

          {batchLoading && <Loading />}
          {batchError && <ErrorBanner message={batchError} />}

          {batchState && (
            <>
              {batchState.warnings.length > 0 && (
                <div className="card" style={{ background: "#fff3cd", borderLeft: "4px solid #f0a500", marginBottom: "0.75rem" }}>
                  {batchState.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
                </div>
              )}

              <div className="card">
                <h2 style={{ margin: "0 0 0.5rem" }}>{batchState.batch.batch_number}</h2>
                <div className="row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
                  <div>
                    <span className="muted small">Status:</span>{" "}
                    <span className={`badge ${batchState.batch.status === "COMPLETED" ? "ok" : batchState.batch.status === "CANCELLED" ? "err" : "neutral"}`}>
                      {STATUS_LABELS[batchState.batch.status]}
                    </span>
                  </div>
                  <div><span className="muted small">Run:</span> #{batchState.batch.match_run_id}</div>
                  <div><span className="muted small">Responsável:</span> {batchState.batch.created_by}</div>
                  <div><span className="muted small">Criado:</span> {batchState.batch.created_at.slice(0, 16)}</div>
                </div>

                <div className="row" style={{ marginTop: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
                  {[
                    { label: "Total", val: batchState.totals.totalItems },
                    { label: "Reservados", val: batchState.totals.reservedItems },
                    { label: "Confirmados", val: batchState.totals.confirmedItems },
                    { label: "Cancelados", val: batchState.totals.cancelledItems },
                    { label: "Aparelhos", val: batchState.totals.totalDevices },
                    { label: "Kits completos", val: batchState.totals.completedDevices },
                  ].map(({ label, val }) => (
                    <div key={label} className="card" style={{ padding: "0.3rem 0.75rem", textAlign: "center", minWidth: 80 }}>
                      <div style={{ fontWeight: 700, fontSize: "1.2rem" }}>{fmtInt(val)}</div>
                      <div className="muted small">{label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Responsável e motivo — para ações */}
              {isOpen && (
                <div className="card">
                  <div className="row" style={{ gap: "1rem", flexWrap: "wrap" }}>
                    <div className="field">
                      <label>Responsável pela ação</label>
                      <input value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder="Nome do operador" />
                    </div>
                    <div className="field" style={{ flex: 2 }}>
                      <label>Motivo de cancelamento (mín. 10 caracteres)</label>
                      <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Necessário para cancelamentos" />
                    </div>
                  </div>
                  {actionError && <ErrorBanner message={actionError} />}
                  <div className="row" style={{ marginTop: "0.75rem", gap: "0.5rem" }}>
                    <button onClick={handleConfirmAll} disabled={!responsible.trim() || actionLoading}>
                      ✅ Confirmar tudo
                    </button>
                    <button
                      className="secondary"
                      onClick={handleCancelBatch}
                      disabled={!responsible.trim() || cancelReason.trim().length < 10 || actionLoading}
                    >
                      ✖ Cancelar lote
                    </button>
                  </div>
                </div>
              )}

              {/* Kits completos */}
              {batchState.devices.length > 0 && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>Kits completos ({batchState.devices.length})</h3>
                  {batchState.devices.map((dev) => (
                    <div key={dev.deviceResultId} className="card" style={{ marginBottom: "0.75rem" }}>
                      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                        <div>
                          <strong>IMEI {dev.imei ?? "(sem IMEI)"}</strong>
                          {dev.os && <span className="muted small"> · OS {dev.os}</span>}
                          {dev.priorityRank && <span className="muted small"> · Rank #{dev.priorityRank}</span>}
                        </div>
                        {isOpen && dev.hasReserved && (
                          <div className="row" style={{ gap: "0.4rem" }}>
                            <button
                              style={{ fontSize: "0.75rem" }}
                              onClick={() => dev.deviceResultId && handleConfirmDevice(dev.deviceResultId)}
                              disabled={!responsible.trim() || actionLoading}
                            >
                              ✅ Confirmar
                            </button>
                            <button
                              className="secondary"
                              style={{ fontSize: "0.75rem" }}
                              onClick={() => dev.deviceResultId && handleCancelDevice(dev.deviceResultId)}
                              disabled={!responsible.trim() || cancelReason.trim().length < 10 || actionLoading}
                            >
                              ✖ Cancelar
                            </button>
                          </div>
                        )}
                      </div>
                      <table style={{ width: "100%", marginTop: "0.5rem", fontSize: "0.82rem" }}>
                        <thead>
                          <tr>
                            <th>ID Pedido</th><th>Peça</th><th>Referência</th><th>Ordem</th><th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dev.items.map((item) => (
                            <tr key={item.id} style={{ opacity: item.status === "CANCELLED" ? 0.5 : 1 }}>
                              <td>{item.id_pedido}</td>
                              <td>{item.chave_peca ?? "-"}</td>
                              <td>{item.reference ?? "-"}</td>
                              <td>{item.match_consumption_order ?? "-"}</td>
                              <td>
                                <span className={`badge ${item.status === "CONFIRMED" ? "ok" : item.status === "CANCELLED" ? "err" : "neutral"}`}
                                  style={{ fontSize: "0.7rem" }}>
                                  {ITEM_STATUS_LABELS[item.status]}
                                </span>
                                {item.confirmed_by && <span className="muted small"> · {item.confirmed_by}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}

              {/* Itens parciais */}
              {batchState.partialItems.length > 0 && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>Itens parciais ({batchState.partialItems.length})</h3>
                  <table style={{ width: "100%", fontSize: "0.82rem" }}>
                    <thead>
                      <tr>
                        <th>ID Pedido</th><th>IMEI</th><th>Peça</th><th>Referência</th><th>Status</th>
                        {isOpen && <th>Ações</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {batchState.partialItems.map((item) => (
                        <tr key={item.id} style={{ opacity: item.status === "CANCELLED" ? 0.5 : 1 }}>
                          <td>{item.id_pedido}</td>
                          <td>{item.imei ?? "-"}</td>
                          <td>{item.chave_peca ?? "-"}</td>
                          <td>{item.reference ?? "-"}</td>
                          <td>
                            <span className={`badge ${item.status === "CONFIRMED" ? "ok" : item.status === "CANCELLED" ? "err" : "neutral"}`}
                              style={{ fontSize: "0.7rem" }}>
                              {ITEM_STATUS_LABELS[item.status]}
                            </span>
                          </td>
                          {isOpen && (
                            <td>
                              {item.status === "RESERVED" && (
                                <div className="row" style={{ gap: "0.3rem" }}>
                                  <button style={{ fontSize: "0.7rem" }}
                                    onClick={() => handleConfirmItem(item.id)}
                                    disabled={!responsible.trim() || actionLoading}>
                                    ✅
                                  </button>
                                  <button className="secondary" style={{ fontSize: "0.7rem" }}
                                    onClick={() => handleCancelItem(item.id)}
                                    disabled={!responsible.trim() || cancelReason.trim().length < 10 || actionLoading}>
                                    ✖
                                  </button>
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
