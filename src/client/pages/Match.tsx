import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface MatchRun {
  id: number;
  algorithm_version: string;
  status: "RUNNING" | "COMPLETED" | "COMPLETED_WITH_WARNINGS" | "FAILED";
  input_hash: string | null;
  created_by: string;
  started_at: string;
  finished_at: string | null;
  notes: string | null;
  error_message: string | null;
  stock_base_type: string | null;
  stock_snapshot_id: number | null;
  stock_usable_units: number;
  stock_total_units: number;
  stock_unmapped_units: number;
  rule_age_days_per_point: number | null;
  devices_full_match: number;
  devices_partial: number;
  devices_incomplete: number;
  devices_verify: number;
  devices_preserved: number;
  devices_considered: number;
  devices_total: number;
  lines_match: number;
  lines_partial: number;
  lines_request_piece: number;
  lines_no_balance: number;
  lines_verify: number;
  lines_preserved: number;
  lines_total: number;
  allocated_units: number;
  remaining_usable_units: number;
  warnings_count: number;
  stale?: boolean;
}

interface DeviceResult {
  id: number;
  device_key: string;
  imei: string | null;
  os_values_json: string;
  os_conflict: number;
  total_parts: number;
  open_parts: number;
  permanent_parts: number;
  score: number;
  margin: number | null;
  priority_rank: number | null;
  kit_status: string | null;
  kit_priority: number | null;
  allocation_phase: string | null;
  warning_codes_json: string;
}

interface LineResult {
  id: number;
  id_pedido: string;
  imei: string | null;
  os: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  concat_peca: string | null;
  allocated_reference: string | null;
  effective_status_before: string | null;
  result_status: string | null;
  result_status_label: string | null;
  kit_status: string | null;
  allocation_phase: string | null;
  reserved_units: number;
  ordem_consumo: number | null;
  stock_for_key_initial: number;
  margin: number | null;
  score: number;
  device_priority_rank: number | null;
  reason_code: string | null;
  warning_codes_json: string;
}

interface ComparisonRow {
  id_pedido: string;
  imei: string | null;
  os: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  concat_peca: string | null;
  legacy_status: string | null;
  effective_status_before: string | null;
  calculated_status: string | null;
  result_status_label: string | null;
  status_equal: boolean;
  legacy_kit_status: string | null;
  calculated_kit_status: string | null;
  kit_status_equal: boolean;
  legacy_kit_priority: number | null;
  calculated_kit_priority: number | null;
  kit_priority_equal: boolean;
  legacy_score: number | null;
  calculated_score: number;
  score_equal: boolean;
  legacy_consumption_order: number | null;
  calculated_consumption_order: number | null;
  consumption_order_equal: boolean;
  legacy_stock_quantity: number | null;
  operational_stock_initial: number;
  stock_quantity_equal: boolean;
  allocation_phase: string | null;
  reserved_units: number;
  allocated_reference: string | null;
  reason_code: string | null;
  warning_codes: string[];
  device_priority_rank: number | null;
}

interface ComparisonSummary {
  totalLines: number;
  fullyEqualLines: number;
  divergentLines: number;
  statusDifferences: number;
  kitStatusDifferences: number;
  kitPriorityDifferences: number;
  scoreDifferences: number;
  consumptionOrderDifferences: number;
  stockQuantityDifferences: number;
}

interface StockSummary {
  chave_peca_norm: string;
  chave_peca: string | null;
  stock_initial: number;
  allocated_full: number;
  allocated_partial: number;
  allocated_total: number;
  remaining: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

function kitStatusColor(status: string | null): string {
  switch (status) {
    case "KIT POSSIVEL": return "#16a34a";
    case "MATCH PARCIAL": return "#d97706";
    case "KIT INCOMPLETO": return "#dc2626";
    case "VERIFICAR": return "#7c3aed";
    default: return "#6b7280";
  }
}

function resultStatusColor(status: string | null): string {
  switch (status) {
    case "MATCH": return "#16a34a";
    case "MATCH PARCIAL": return "#d97706";
    case "PEDIR PECA": return "#2563eb";
    case "SEM SALDO": return "#dc2626";
    case "VERIFICAR": return "#7c3aed";
    default: return "#6b7280";
  }
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        background: color + "22",
        color,
        border: `1px solid ${color}44`,
        borderRadius: 4,
        padding: "1px 6px",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function Card({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "12px 16px",
        minWidth: 120,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? "var(--fg)" }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function Match() {
  const [latestRun, setLatestRun] = useState<MatchRun | null>(null);
  const [currentState, setCurrentState] = useState<{
    hash: string;
    initialized: boolean;
    stockBase: string;
    stockSnapshotId: number | null;
    stockUsable: number;
    stockTotal: number;
    stockUnmapped: number;
    activeRule: { id: number; name: string } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createdBy, setCreatedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [force, setForce] = useState(false);
  const [activeTab, setActiveTab] = useState<"devices" | "stock" | "comparison" | "warnings">(
    "devices",
  );

  // Separação
  const [selectedFullDeviceIds, setSelectedFullDeviceIds] = useState<Set<number>>(new Set());
  const [selectedPartialResultIds, setSelectedPartialResultIds] = useState<Set<number>>(new Set());
  const [showSepForm, setShowSepForm] = useState(false);
  const [sepCreatedBy, setSepCreatedBy] = useState("");
  const [sepNotes, setSepNotes] = useState("");
  const [sepError, setSepError] = useState<string | null>(null);
  const [sepLoading, setSepLoading] = useState(false);
  const [sepResult, setSepResult] = useState<{ batchNumber: string; batchId: number } | null>(null);

  // Abas de conteúdo
  const [devices, setDevices] = useState<DeviceResult[]>([]);
  const [devicesTotal, setDevicesTotal] = useState(0);
  const [devicesOffset, setDevicesOffset] = useState(0);
  const [deviceSearch, setDeviceSearch] = useState("");
  const [deviceKitFilter, setDeviceKitFilter] = useState("");
  const [expandedDevice, setExpandedDevice] = useState<number | null>(null);
  const [deviceLines, setDeviceLines] = useState<Map<number, LineResult[]>>(new Map());

  const [stockSummary, setStockSummary] = useState<StockSummary[]>([]);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [compTotal, setCompTotal] = useState(0);
  const [compOffset, setCompOffset] = useState(0);
  const [compSummary, setCompSummary] = useState<ComparisonSummary | null>(null);
  const [onlyDivergent, setOnlyDivergent] = useState(false);

  const devicesPageSize = 30;
  const compPageSize = 50;

  async function loadState() {
    try {
      setLoading(true);
      const data = await apiFetch<{
        state: typeof currentState;
        latest: MatchRun | null;
      }>("/api/match-runs/current-state");
      setCurrentState(data.state);
      setLatestRun(data.latest);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadState();
  }, []);

  async function loadDevices(runId: number, offset = 0, search = "", kitStatus = "") {
    const qs = new URLSearchParams({
      limit: String(devicesPageSize),
      offset: String(offset),
    });
    if (search) qs.set("search", search);
    if (kitStatus) qs.set("kitStatus", kitStatus);
    const data = await apiFetch<{ devices: DeviceResult[]; total: number }>(
      `/api/match-runs/${runId}/devices?${qs}`,
    );
    setDevices(data.devices);
    setDevicesTotal(data.total);
    setDevicesOffset(offset);
  }

  async function loadStockSummary(runId: number) {
    const data = await apiFetch<{ summary: StockSummary[] }>(
      `/api/match-runs/${runId}/stock-summary`,
    );
    setStockSummary(data.summary);
  }

  async function loadComparison(runId: number, offset = 0, divergent = false) {
    const qs = new URLSearchParams({
      limit: String(compPageSize),
      offset: String(offset),
      onlyDivergent: String(divergent),
    });
    const data = await apiFetch<{
      results: ComparisonRow[];
      total: number;
      summary: ComparisonSummary;
    }>(`/api/match-runs/${runId}/comparison?${qs}`);
    setComparison(data.results);
    setCompTotal(data.total);
    setCompOffset(offset);
    setCompSummary(data.summary ?? null);
  }

  async function loadTabData(run: MatchRun, tab: typeof activeTab) {
    if (tab === "devices") await loadDevices(run.id, 0, deviceSearch, deviceKitFilter);
    if (tab === "stock") await loadStockSummary(run.id);
    if (tab === "comparison") await loadComparison(run.id, 0, onlyDivergent);
  }

  useEffect(() => {
    if (latestRun && latestRun.status !== "FAILED") {
      void loadTabData(latestRun, activeTab);
    }
  }, [latestRun, activeTab]);

  async function loadDeviceLines(runId: number, deviceId: number) {
    if (deviceLines.has(deviceId)) return;
    const data = await apiFetch<{ lines: LineResult[] }>(
      `/api/match-runs/${runId}/devices/${deviceId}/results`,
    );
    setDeviceLines((prev) => {
      const m = new Map(prev);
      m.set(deviceId, data.lines);
      return m;
    });
  }

  async function handleCreateSeparation() {
    if (!latestRun || !sepCreatedBy.trim()) return;
    setSepLoading(true);
    setSepError(null);
    try {
      const idempotencyKey = `sep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const body = {
        createdBy: sepCreatedBy.trim(),
        notes: sepNotes.trim() || null,
        fullDeviceResultIds: [...selectedFullDeviceIds],
        partialMatchResultIds: [...selectedPartialResultIds],
        idempotencyKey,
        matchRunId: latestRun.id,
      };
      const r = await apiFetch<{ batch: { id: number; batch_number: string } }>(
        "/api/separation-batches",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setSepResult({ batchNumber: r.batch.batch_number, batchId: r.batch.id });
      setSelectedFullDeviceIds(new Set());
      setSelectedPartialResultIds(new Set());
      setShowSepForm(false);
      // Recarregar estado para refletir que o run ficou stale
      await loadState();
    } catch (e) {
      setSepError((e as Error).message);
    } finally {
      setSepLoading(false);
    }
  }

  function toggleFullDevice(deviceId: number) {
    setSelectedFullDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
    setSepResult(null);
  }

  function togglePartialResult(resultId: number) {
    setSelectedPartialResultIds((prev) => {
      const next = new Set(prev);
      if (next.has(resultId)) next.delete(resultId);
      else next.add(resultId);
      return next;
    });
    setSepResult(null);
  }

  async function handleRun() {
    if (!createdBy.trim()) {
      setError("Informe o responsável antes de executar.");
      return;
    }
    setRunning(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await apiFetch<{ run: MatchRun; reused: boolean; message: string }>(
        "/api/match-runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ createdBy: createdBy.trim(), notes: notes.trim() || null, force }),
        },
      );
      setLatestRun(result.run);
      setSuccess(result.message);
      setForce(false);
      await loadTabData(result.run, activeTab);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <div style={{ padding: 32 }}>Carregando…</div>;

  const stale = latestRun?.stale ?? false;
  const sameHash =
    latestRun && currentState && latestRun.input_hash === currentState.hash;
  const statusLabel =
    latestRun && !stale && sameHash ? "ATUAL" : latestRun ? "DESATUALIZADO" : "—";

  return (
    <div style={{ padding: "24px 32px", fontFamily: "monospace" }}>
      {/* Aviso de segurança visual */}
      <div
        style={{
          background: "#fef3c7",
          border: "1px solid #f59e0b",
          borderRadius: 6,
          padding: "8px 14px",
          marginBottom: 20,
          fontSize: 13,
          color: "#92400e",
        }}
      >
        ⚠️ <strong>Este resultado é uma recomendação calculada. Nenhuma peça foi retirada ou
        reservada no estoque.</strong>
      </div>

      {/* Cabeçalho */}
      <div
        style={{
          display: "flex",
          gap: 32,
          flexWrap: "wrap",
          alignItems: "flex-start",
          marginBottom: 24,
        }}
      >
        <div style={{ flex: 1, minWidth: 300 }}>
          <h2 style={{ margin: "0 0 8px" }}>Motor de Match</h2>
          {currentState && (
            <table style={{ fontSize: 12, borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ color: "var(--muted)", paddingRight: 12 }}>Base de estoque</td>
                  <td>{currentState.stockBase || "—"}</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--muted)" }}>Total / utilizável / sem mapeamento</td>
                  <td>
                    {currentState.stockTotal} / {currentState.stockUsable} /{" "}
                    {currentState.stockUnmapped}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--muted)" }}>Regra ativa</td>
                  <td>{currentState.activeRule?.name ?? <span style={{ color: "#dc2626" }}>Nenhuma</span>}</td>
                </tr>
                {latestRun && (
                  <>
                    <tr>
                      <td style={{ color: "var(--muted)" }}>Última execução</td>
                      <td>
                        #{latestRun.id} — {latestRun.started_at.substring(0, 16).replace("T", " ")} por{" "}
                        <strong>{latestRun.created_by}</strong>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "var(--muted)" }}>Versão do algoritmo</td>
                      <td>v{latestRun.algorithm_version}</td>
                    </tr>
                    <tr>
                      <td style={{ color: "var(--muted)" }}>Estado</td>
                      <td>
                        <span
                          style={{
                            fontWeight: 700,
                            color: stale ? "#dc2626" : "#16a34a",
                          }}
                        >
                          {statusLabel}
                        </span>
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Formulário de execução */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 16,
            minWidth: 280,
          }}
        >
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>Responsável *</label>
            <input
              type="text"
              value={createdBy}
              onChange={(e) => setCreatedBy(e.target.value)}
              placeholder="Seu nome"
              style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 10px" }}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>Observação (opcional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 10px" }}
            />
          </div>
          {latestRun && !stale && sameHash && (
            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Forçar nova execução (mesmo estado)
            </label>
          )}
          <button
            onClick={handleRun}
            disabled={running || !currentState?.initialized || !currentState?.activeRule}
            style={{ width: "100%", padding: "8px 0", fontWeight: 700 }}
          >
            {running ? "Calculando…" : "EXECUTAR MATCH"}
          </button>
          {!currentState?.initialized && (
            <p style={{ fontSize: 11, color: "#dc2626", marginTop: 6 }}>
              Sistema não inicializado.
            </p>
          )}
          {currentState?.initialized && !currentState.activeRule && (
            <p style={{ fontSize: 11, color: "#dc2626", marginTop: 6 }}>
              Nenhuma regra de decisão ativa.
            </p>
          )}
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #dc2626",
            borderRadius: 6,
            padding: "8px 14px",
            marginBottom: 16,
            color: "#dc2626",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          style={{
            background: "#dcfce7",
            border: "1px solid #16a34a",
            borderRadius: 6,
            padding: "8px 14px",
            marginBottom: 16,
            color: "#15803d",
          }}
        >
          {success}
        </div>
      )}

      {/* Resumo (cards) */}
      {latestRun && latestRun.status !== "FAILED" && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 20,
            }}
          >
            <Card label="Aparelhos considerados" value={latestRun.devices_considered} />
            <Card label="Kits completos" value={latestRun.devices_full_match} color="#16a34a" />
            <Card label="Parcialmente atendidos" value={latestRun.devices_partial} color="#d97706" />
            <Card label="Kits incompletos" value={latestRun.devices_incomplete} color="#dc2626" />
            <Card label="Verificar" value={latestRun.devices_verify} color="#7c3aed" />
            <Card label="Preservados" value={latestRun.devices_preserved} color="#6b7280" />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
            <Card label="MATCH" value={latestRun.lines_match} color="#16a34a" />
            <Card label="MATCH PARCIAL" value={latestRun.lines_partial} color="#d97706" />
            <Card label="PEDIR PEÇA" value={latestRun.lines_request_piece} color="#2563eb" />
            <Card label="SEM SALDO" value={latestRun.lines_no_balance} color="#dc2626" />
            <Card label="VERIFICAR" value={latestRun.lines_verify} color="#7c3aed" />
            <Card label="Preservadas" value={latestRun.lines_preserved} color="#6b7280" />
            <Card label="Unidades alocadas (simulado)" value={latestRun.allocated_units} />
            <Card label="Saldo utilizável restante" value={latestRun.remaining_usable_units} />
          </div>

          {/* Separação — resultado criado */}
          {sepResult && (
            <div style={{ background: "#dcfce7", border: "1px solid #16a34a", borderRadius: 6, padding: "10px 14px", marginBottom: 16 }}>
              ✅ Lote de separação <strong>{sepResult.batchNumber}</strong> criado.{" "}
              <Link to="/separacao" style={{ color: "#15803d" }}>Ir para SEPARAÇÃO →</Link>
              <span style={{ fontSize: 12, color: "#15803d", marginLeft: 8 }}>
                (Este run ficou desatualizado após a criação de reservas)
              </span>
            </div>
          )}

          {/* Painel GERAR SEPARAÇÃO */}
          {!stale && (selectedFullDeviceIds.size > 0 || selectedPartialResultIds.size > 0) && (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>Selecionados para separação:</strong>{" "}
                  {selectedFullDeviceIds.size > 0 && (
                    <span style={{ marginRight: 12 }}>{selectedFullDeviceIds.size} kit(s) completo(s)</span>
                  )}
                  {selectedPartialResultIds.size > 0 && (
                    <span>{selectedPartialResultIds.size} linha(s) parcial(is)</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setSelectedFullDeviceIds(new Set()); setSelectedPartialResultIds(new Set()); }} className="secondary" style={{ fontSize: 12 }}>
                    Limpar seleção
                  </button>
                  <button onClick={() => setShowSepForm(!showSepForm)} style={{ fontWeight: 700 }}>
                    GERAR SEPARAÇÃO
                  </button>
                </div>
              </div>
              {showSepForm && (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                    <div>
                      <label style={{ fontSize: 12, color: "var(--muted)" }}>Responsável *</label>
                      <input value={sepCreatedBy} onChange={(e) => setSepCreatedBy(e.target.value)} placeholder="Nome do operador" style={{ display: "block", marginTop: 4, padding: "6px 10px" }} />
                    </div>
                    <div style={{ flex: 2 }}>
                      <label style={{ fontSize: 12, color: "var(--muted)" }}>Observação (opcional)</label>
                      <input value={sepNotes} onChange={(e) => setSepNotes(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 10px" }} />
                    </div>
                  </div>
                  {sepError && (
                    <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 4, padding: "6px 10px", marginBottom: 8, fontSize: 12 }}>{sepError}</div>
                  )}
                  <button onClick={handleCreateSeparation} disabled={!sepCreatedBy.trim() || sepLoading} style={{ fontWeight: 700 }}>
                    {sepLoading ? "Criando…" : "Confirmar e criar lote"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Aviso stale */}
          {stale && (
            <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 6, padding: "8px 14px", marginBottom: 16, fontSize: 12, color: "#92400e" }}>
              ⚠️ Este resultado está desatualizado (o estoque ou as reservas mudaram). Execute um novo match para gerar separações.
            </div>
          )}

          {/* Aviso de warnings */}
          {latestRun.warnings_count > 0 && (
            <div
              style={{
                background: "#fef3c7",
                border: "1px solid #f59e0b",
                borderRadius: 6,
                padding: "6px 12px",
                marginBottom: 16,
                fontSize: 12,
                color: "#92400e",
              }}
            >
              {latestRun.warnings_count} avisos na execução —{" "}
              <button
                style={{ background: "none", border: "none", color: "#92400e", cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "monospace" }}
                onClick={() => setActiveTab("warnings")}
              >
                ver avisos
              </button>
            </div>
          )}

          {/* Abas */}
          <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "2px solid var(--border)" }}>
            {(["devices", "stock", "comparison", "warnings"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom: activeTab === tab ? "2px solid var(--accent)" : "none",
                  padding: "8px 18px",
                  cursor: "pointer",
                  fontWeight: activeTab === tab ? 700 : 400,
                  fontFamily: "monospace",
                  marginBottom: -2,
                  color: activeTab === tab ? "var(--accent)" : "var(--fg)",
                }}
              >
                {tab === "devices" ? "Aparelhos" : tab === "stock" ? "Estoque" : tab === "comparison" ? "Comparação" : "Avisos"}
              </button>
            ))}
          </div>

          {/* Aba: Aparelhos */}
          {activeTab === "devices" && (
            <DevicesTab
              runId={latestRun.id}
              devices={devices}
              total={devicesTotal}
              offset={devicesOffset}
              pageSize={devicesPageSize}
              search={deviceSearch}
              kitFilter={deviceKitFilter}
              expandedDevice={expandedDevice}
              deviceLines={deviceLines}
              selectedFullDeviceIds={selectedFullDeviceIds}
              selectedPartialResultIds={selectedPartialResultIds}
              stale={stale}
              onSearch={(s) => {
                setDeviceSearch(s);
                void loadDevices(latestRun.id, 0, s, deviceKitFilter);
              }}
              onKitFilter={(k) => {
                setDeviceKitFilter(k);
                void loadDevices(latestRun.id, 0, deviceSearch, k);
              }}
              onPage={(o) => loadDevices(latestRun.id, o, deviceSearch, deviceKitFilter)}
              onExpand={(id) => {
                if (expandedDevice === id) {
                  setExpandedDevice(null);
                } else {
                  setExpandedDevice(id);
                  void loadDeviceLines(latestRun.id, id);
                }
              }}
              onToggleFullDevice={toggleFullDevice}
              onTogglePartialResult={togglePartialResult}
            />
          )}

          {/* Aba: Estoque */}
          {activeTab === "stock" && <StockTab summary={stockSummary} />}

          {/* Aba: Comparação */}
          {activeTab === "comparison" && (
            <ComparisonTab
              runId={latestRun.id}
              results={comparison}
              total={compTotal}
              offset={compOffset}
              pageSize={compPageSize}
              onlyDivergent={onlyDivergent}
              summary={compSummary}
              onToggleDivergent={(v) => {
                setOnlyDivergent(v);
                void loadComparison(latestRun.id, 0, v);
              }}
              onPage={(o) => loadComparison(latestRun.id, o, onlyDivergent)}
            />
          )}

          {/* Aba: Avisos */}
          {activeTab === "warnings" && (
            <div style={{ fontSize: 13 }}>
              <p>
                Total de avisos: <strong>{latestRun.warnings_count}</strong>
              </p>
              <p style={{ color: "var(--muted)" }}>
                Os avisos estão distribuídos por linha na aba Aparelhos e Comparação (coluna
                warningCodes).
              </p>
            </div>
          )}
        </>
      )}

      {latestRun?.status === "FAILED" && (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #dc2626",
            borderRadius: 6,
            padding: 12,
          }}
        >
          <strong>Última execução falhou:</strong>
          <pre style={{ margin: "8px 0 0", fontSize: 12 }}>{latestRun.error_message}</pre>
        </div>
      )}

      {!latestRun && !loading && (
        <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
          Nenhuma execução realizada ainda. Clique em EXECUTAR MATCH para iniciar.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componentes
// ---------------------------------------------------------------------------

function DevicesTab({
  runId,
  devices,
  total,
  offset,
  pageSize,
  search,
  kitFilter,
  expandedDevice,
  deviceLines,
  selectedFullDeviceIds,
  selectedPartialResultIds,
  stale,
  onSearch,
  onKitFilter,
  onPage,
  onExpand,
  onToggleFullDevice,
  onTogglePartialResult,
}: {
  runId: number;
  devices: DeviceResult[];
  total: number;
  offset: number;
  pageSize: number;
  search: string;
  kitFilter: string;
  expandedDevice: number | null;
  deviceLines: Map<number, LineResult[]>;
  selectedFullDeviceIds: Set<number>;
  selectedPartialResultIds: Set<number>;
  stale: boolean;
  onSearch: (s: string) => void;
  onKitFilter: (k: string) => void;
  onPage: (o: number) => Promise<void>;
  onExpand: (id: number) => void;
  onToggleFullDevice: (deviceId: number) => void;
  onTogglePartialResult: (resultId: number) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Buscar IMEI…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          style={{ padding: "5px 10px", flex: 1, maxWidth: 260 }}
        />
        <select
          value={kitFilter}
          onChange={(e) => onKitFilter(e.target.value)}
          style={{ padding: "5px 10px" }}
        >
          <option value="">Todos os kits</option>
          <option value="KIT POSSIVEL">KIT POSSÍVEL</option>
          <option value="MATCH PARCIAL">MATCH PARCIAL</option>
          <option value="KIT INCOMPLETO">KIT INCOMPLETO</option>
          <option value="VERIFICAR">VERIFICAR</option>
        </select>
        <span style={{ fontSize: 12, color: "var(--muted)", alignSelf: "center" }}>
          {total} aparelhos
        </span>
        <a
          href={`/api/match-runs/${runId}/export-csv`}
          style={{ fontSize: 12, alignSelf: "center", color: "var(--accent)" }}
          download
        >
          Exportar CSV
        </a>
        <a
          href={`/api/match-runs/${runId}/export-csv?onlyDivergent=true`}
          style={{ fontSize: 12, alignSelf: "center", color: "var(--accent)" }}
          download
        >
          Exportar divergências
        </a>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid var(--border)", textAlign: "left" }}>
            {!stale && <th style={{ padding: "6px 4px" }} title="Selecionar para separação">Sep.</th>}
            <th style={{ padding: "6px 8px" }}>Rank</th>
            <th style={{ padding: "6px 8px" }}>IMEI</th>
            <th style={{ padding: "6px 8px" }}>OS</th>
            <th style={{ padding: "6px 8px" }}>Peças abertas</th>
            <th style={{ padding: "6px 8px" }}>Score</th>
            <th style={{ padding: "6px 8px" }}>Margem</th>
            <th style={{ padding: "6px 8px" }}>Kit</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const osValues: string[] = JSON.parse(d.os_values_json || "[]");
            const warningCodes: string[] = JSON.parse(d.warning_codes_json || "[]");
            const expanded = expandedDevice === d.id;
            const isFullKit = d.allocation_phase === "FULL" && d.kit_status === "KIT POSSIVEL";
            const isSelected = selectedFullDeviceIds.has(d.id);
            const isReservedOrSep = d.kit_status === "EM SEPARACAO";
            return (
              <>
                <tr
                  key={d.id}
                  style={{
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    background: expanded ? "var(--surface)" : isSelected ? "#dcfce7" : undefined,
                    opacity: isReservedOrSep ? 0.5 : 1,
                  }}
                  onClick={() => onExpand(d.id)}
                >
                  {!stale && (
                    <td style={{ padding: "5px 4px" }} onClick={(e) => e.stopPropagation()}>
                      {isFullKit && !isReservedOrSep && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleFullDevice(d.id)}
                          title="Selecionar kit completo para separação"
                        />
                      )}
                    </td>
                  )}
                  <td style={{ padding: "5px 8px" }}>{d.priority_rank ?? "—"}</td>
                  <td style={{ padding: "5px 8px" }}>
                    {d.imei ?? <span style={{ color: "var(--muted)" }}>(sem IMEI)</span>}
                    {d.os_conflict ? (
                      <span style={{ color: "#d97706", marginLeft: 4 }} title="OS divergente">⚠</span>
                    ) : null}
                  </td>
                  <td style={{ padding: "5px 8px", color: "var(--muted)" }}>
                    {osValues.join(", ") || "—"}
                  </td>
                  <td style={{ padding: "5px 8px" }}>
                    {d.open_parts}
                    {d.permanent_parts > 0 && (
                      <span style={{ color: "var(--muted)", marginLeft: 4 }}>
                        (+{d.permanent_parts} perm.)
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "5px 8px" }}>{d.score}</td>
                  <td style={{ padding: "5px 8px" }}>
                    {d.margin != null ? `R$ ${d.margin.toFixed(0)}` : "—"}
                  </td>
                  <td style={{ padding: "5px 8px" }}>
                    {d.kit_status ? (
                      <Badge text={d.kit_status} color={kitStatusColor(d.kit_status)} />
                    ) : (
                      "—"
                    )}
                    {warningCodes.length > 0 && (
                      <span
                        style={{ color: "#d97706", marginLeft: 4, fontSize: 10 }}
                        title={warningCodes.join(", ")}
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr key={`${d.id}-lines`}>
                    <td colSpan={stale ? 7 : 8} style={{ padding: "4px 16px 12px", background: "var(--surface)" }}>
                      <DeviceLinesTable
                        lines={deviceLines.get(d.id)}
                        deviceId={d.id}
                        selectedPartialResultIds={selectedPartialResultIds}
                        stale={stale}
                        onTogglePartialResult={onTogglePartialResult}
                      />
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>

      <Pagination total={total} offset={offset} pageSize={pageSize} onPage={onPage} />
    </div>
  );
}

function DeviceLinesTable({
  lines,
  selectedPartialResultIds,
  stale,
  onTogglePartialResult,
}: {
  lines: LineResult[] | undefined;
  deviceId: number;
  selectedPartialResultIds: Set<number>;
  stale: boolean;
  onTogglePartialResult: (id: number) => void;
}) {
  if (!lines) return <div style={{ fontSize: 12, color: "var(--muted)" }}>Carregando…</div>;
  if (lines.length === 0)
    return <div style={{ fontSize: 12, color: "var(--muted)" }}>Sem linhas encontradas.</div>;

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          {!stale && <th style={{ padding: "4px 4px" }} title="Selecionar para separação (parcial)">Sep.</th>}
          <th style={{ padding: "4px 6px", textAlign: "left" }}>ID_PEDIDO</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>CHAVEPECA</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Descrição</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Ref alocada</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Resultado</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Fase</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Ordem</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Est. inicial</th>
          <th style={{ padding: "4px 6px", textAlign: "left" }}>Motivo</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const isPartialMatch = l.allocation_phase === "PARTIAL" && l.result_status === "MATCH PARCIAL";
          const isSelected = selectedPartialResultIds.has(l.id);
          return (
            <tr key={l.id_pedido} style={{ borderBottom: "1px solid var(--border)44", background: isSelected ? "#fef9c3" : undefined }}>
              {!stale && (
                <td style={{ padding: "3px 4px" }}>
                  {isPartialMatch && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onTogglePartialResult(l.id)}
                      title="Selecionar linha parcial para separação"
                    />
                  )}
                </td>
              )}
              <td style={{ padding: "3px 6px" }}>{l.id_pedido}</td>
              <td style={{ padding: "3px 6px" }}>{l.chave_peca ?? "—"}</td>
              <td style={{ padding: "3px 6px", color: "var(--muted)", fontSize: 10 }}>
                {l.concat_peca ?? "—"}
              </td>
              <td style={{ padding: "3px 6px", color: "var(--muted)" }}>
                {l.allocated_reference ?? "—"}
              </td>
              <td style={{ padding: "3px 6px" }}>
                {l.result_status_label ? (
                  <Badge
                    text={l.result_status_label}
                    color={resultStatusColor(l.result_status)}
                  />
                ) : (
                  "—"
                )}
              </td>
              <td style={{ padding: "3px 6px", color: "var(--muted)", fontSize: 10 }}>
                {l.allocation_phase ?? "—"}
              </td>
              <td style={{ padding: "3px 6px" }}>{l.ordem_consumo ?? "—"}</td>
              <td style={{ padding: "3px 6px" }}>{l.stock_for_key_initial}</td>
              <td style={{ padding: "3px 6px", color: "var(--muted)", fontSize: 10 }}>
                {l.reason_code ?? ""}
                {JSON.parse(l.warning_codes_json || "[]")
                  .map((w: string) => (
                    <span key={w} style={{ marginLeft: 4, color: "#d97706" }} title={w}>
                      ⚠
                    </span>
                  ))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StockTab({ summary }: { summary: StockSummary[] }) {
  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
        Estoque por CHAVEPECA — quantidade inicial, alocada (kit completo / parcial) e saldo.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid var(--border)" }}>
            <th style={{ padding: "6px 8px", textAlign: "left" }}>CHAVEPECA</th>
            <th style={{ padding: "6px 8px", textAlign: "right" }}>Inicial</th>
            <th style={{ padding: "6px 8px", textAlign: "right" }}>Kit completo</th>
            <th style={{ padding: "6px 8px", textAlign: "right" }}>Parcial</th>
            <th style={{ padding: "6px 8px", textAlign: "right" }}>Total alocado</th>
            <th style={{ padding: "6px 8px", textAlign: "right" }}>Saldo</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((s) => (
            <tr key={s.chave_peca_norm} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "5px 8px" }}>{s.chave_peca ?? s.chave_peca_norm}</td>
              <td style={{ padding: "5px 8px", textAlign: "right" }}>{s.stock_initial}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", color: "#16a34a" }}>
                {s.allocated_full}
              </td>
              <td style={{ padding: "5px 8px", textAlign: "right", color: "#d97706" }}>
                {s.allocated_partial}
              </td>
              <td style={{ padding: "5px 8px", textAlign: "right" }}>{s.allocated_total}</td>
              <td
                style={{
                  padding: "5px 8px",
                  textAlign: "right",
                  fontWeight: 700,
                  color: s.remaining === 0 ? "#dc2626" : "var(--fg)",
                }}
              >
                {s.remaining}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonTab({
  runId,
  results,
  total,
  offset,
  pageSize,
  onlyDivergent,
  summary,
  onToggleDivergent,
  onPage,
}: {
  runId: number;
  results: ComparisonRow[];
  total: number;
  offset: number;
  pageSize: number;
  onlyDivergent: boolean;
  summary: ComparisonSummary | null;
  onToggleDivergent: (v: boolean) => void;
  onPage: (o: number) => Promise<void>;
}) {
  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, display: "flex", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={onlyDivergent}
            onChange={(e) => onToggleDivergent(e.target.checked)}
          />
          Somente divergentes
        </label>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{total} linhas</span>
        <a href={`/api/match-runs/${runId}/export-csv`} style={{ fontSize: 12, color: "var(--accent)" }} download>
          CSV completo
        </a>
        <a href={`/api/match-runs/${runId}/export-csv?onlyDivergent=true`} style={{ fontSize: 12, color: "var(--accent)" }} download>
          CSV divergências
        </a>
      </div>

      {summary && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>Total: <strong>{summary.totalLines}</strong></span>
          <span>Divergentes: <strong style={{ color: summary.divergentLines > 0 ? "#dc2626" : "inherit" }}>{summary.divergentLines}</strong></span>
          <span>Status: {summary.statusDifferences}</span>
          <span>Kit: {summary.kitStatusDifferences}</span>
          <span>Prioridade kit: {summary.kitPriorityDifferences}</span>
          <span>Score: {summary.scoreDifferences}</span>
          <span>Ordem: {summary.consumptionOrderDifferences}</span>
          <span>Estoque: {summary.stockQuantityDifferences} (info)</span>
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid var(--border)" }}>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>ID_PEDIDO</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>CHAVEPECA</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>Status legado</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>Status calculado</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>Kit legado / calc.</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>Score leg. / calc.</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>Ordem leg. / calc.</th>
            <th style={{ padding: "5px 6px", textAlign: "left" }}>Fase</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            // Usa boolean do backend — sem falso positivo por acentos
            const anyDiverge =
              !r.status_equal || !r.kit_status_equal || !r.kit_priority_equal ||
              !r.score_equal || !r.consumption_order_equal;
            return (
              <tr
                key={r.id_pedido}
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: anyDiverge ? "#fef3c744" : undefined,
                }}
              >
                <td style={{ padding: "4px 6px" }}>{r.id_pedido}</td>
                <td style={{ padding: "4px 6px", fontSize: 10 }}>
                  <div>{r.chave_peca ?? "—"}</div>
                  {r.concat_peca && <div style={{ color: "var(--muted)" }}>{r.concat_peca}</div>}
                </td>
                <td style={{ padding: "4px 6px", color: !r.status_equal ? "#dc2626" : "var(--muted)" }}>
                  {r.legacy_status ?? "—"}
                </td>
                <td style={{ padding: "4px 6px" }}>
                  {r.result_status_label ? (
                    <Badge text={r.result_status_label} color={resultStatusColor(r.calculated_status)} />
                  ) : "—"}
                </td>
                <td style={{ padding: "4px 6px", fontSize: 10 }}>
                  <span style={{ color: !r.kit_status_equal ? "#dc2626" : "var(--muted)" }}>
                    {r.legacy_kit_status ?? "—"}
                  </span>
                  {" / "}
                  <span>{r.calculated_kit_status ?? "—"}</span>
                </td>
                <td style={{ padding: "4px 6px", fontSize: 10 }}>
                  <span style={{ color: !r.score_equal ? "#dc2626" : "var(--muted)" }}>
                    {r.legacy_score ?? "—"}
                  </span>
                  {" / "}
                  <span>{r.calculated_score}</span>
                </td>
                <td style={{ padding: "4px 6px", fontSize: 10 }}>
                  <span style={{ color: !r.consumption_order_equal ? "#dc2626" : "var(--muted)" }}>
                    {r.legacy_consumption_order ?? "—"}
                  </span>
                  {" / "}
                  <span>{r.calculated_consumption_order ?? "—"}</span>
                </td>
                <td style={{ padding: "4px 6px", fontSize: 10, color: "var(--muted)" }}>
                  {r.allocation_phase ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pagination total={total} offset={offset} pageSize={pageSize} onPage={onPage} />
    </div>
  );
}

function Pagination({
  total,
  offset,
  pageSize,
  onPage,
}: {
  total: number;
  offset: number;
  pageSize: number;
  onPage: (o: number) => Promise<void>;
}) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const current = Math.floor(offset / pageSize);

  // Janela deslizante: até 5 páginas centradas na atual
  const windowSize = 5;
  let winStart = Math.max(0, current - Math.floor(windowSize / 2));
  const winEnd = Math.min(pages - 1, winStart + windowSize - 1);
  if (winEnd - winStart + 1 < windowSize) {
    winStart = Math.max(0, winEnd - windowSize + 1);
  }

  const btnStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    padding: "3px 8px",
    fontWeight: active ? 700 : 400,
    background: active ? "var(--accent)" : undefined,
    color: active ? "#fff" : disabled ? "var(--muted)" : undefined,
    border: "1px solid var(--border)",
    borderRadius: 4,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div style={{ display: "flex", gap: 4, marginTop: 12, fontSize: 12, alignItems: "center", flexWrap: "wrap" }}>
      <button disabled={current === 0} onClick={() => void onPage(0)} style={btnStyle(false, current === 0)}>
        «
      </button>
      <button disabled={current === 0} onClick={() => void onPage((current - 1) * pageSize)} style={btnStyle(false, current === 0)}>
        ‹
      </button>

      {winStart > 0 && (
        <>
          <button onClick={() => void onPage(0)} style={btnStyle(false)}>1</button>
          {winStart > 1 && <span style={{ color: "var(--muted)", alignSelf: "center" }}>…</span>}
        </>
      )}

      {Array.from({ length: winEnd - winStart + 1 }, (_, i) => {
        const p = winStart + i;
        return (
          <button key={p} onClick={() => void onPage(p * pageSize)} style={btnStyle(p === current)}>
            {p + 1}
          </button>
        );
      })}

      {winEnd < pages - 1 && (
        <>
          {winEnd < pages - 2 && <span style={{ color: "var(--muted)", alignSelf: "center" }}>…</span>}
          <button onClick={() => void onPage((pages - 1) * pageSize)} style={btnStyle(false)}>{pages}</button>
        </>
      )}

      <button disabled={current === pages - 1} onClick={() => void onPage((current + 1) * pageSize)} style={btnStyle(false, current === pages - 1)}>
        ›
      </button>
      <button disabled={current === pages - 1} onClick={() => void onPage((pages - 1) * pageSize)} style={btnStyle(false, current === pages - 1)}>
        »
      </button>
      <span style={{ color: "var(--muted)", alignSelf: "center" }}>
        Pág. {current + 1} de {pages}
      </span>
    </div>
  );
}
