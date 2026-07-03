import { useState, useEffect, useRef } from "react";
import {
  Upload, Clock, CheckCircle2, XCircle, AlertTriangle,
  X, Loader2, RefreshCw, Lock,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceStatus {
  lastImportId: number | null;
  lastImportAt: string | null;
  lastStatus: string | null;
  totalImports: number;
  lastRowsFound: number;
  lastIssuesCount: number;
}

interface AllStatus {
  "rel-seriais": SourceStatus;
  sh: SourceStatus;
  his: SourceStatus;
  bkp: SourceStatus;
  "triagem-saida": SourceStatus;
  peacs: SourceStatus;
  legado: SourceStatus;
}

interface LegadoStatus {
  initialized: boolean;
  batchId: number | null;
  batchStatus: string | null;
  ordersFound: number;
  inventoryFound: number;
  createdAt: string | null;
}

interface PreviewIssue {
  row: number | null;
  severity: "ERROR" | "WARNING" | "INFO";
  code: string;
  message: string;
}

interface PreviewResult {
  importId: number;
  source: string;
  filename: string;
  fileHash: string;
  rowsFound: number;
  rowsValid: number;
  issues: PreviewIssue[];
  alreadyImported: boolean;
  existingImportId: number | null;
  previewRows: Record<string, unknown>[];
}

interface HistoryEntry {
  id: number;
  filename: string;
  fileHash: string;
  status: string;
  rowsFound: number;
  rowsLinked?: number;
  rowsUnlinked?: number;
  rowsValid?: number;
  issuesCount: number;
  createdAt: string;
  finishedAt: string | null;
  createdByName?: string | null;
}

type SourceKey = "rel-seriais" | "sh" | "his" | "bkp" | "triagem-saida" | "peacs";

interface SourceDefinition {
  key: SourceKey;
  label: string;
  description: string;
  sourceType: "Snapshot" | "Eventos" | "Enriquecimento" | "Catálogo" | "Legado";
  expectedFile: string;
  accept: string;
}

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

const SOURCES: SourceDefinition[] = [
  {
    key: "rel-seriais",
    label: "Rel. Estoque de Seriais",
    description: "CSV do Datasys com IMEI, técnico responsável, idade e custo auditado dos aparelhos em estoque.",
    sourceType: "Snapshot",
    expectedFile: "Rel_Estoque_de_Seriais.csv",
    accept: ".csv",
  },
  {
    key: "sh",
    label: "SH Oficina",
    description: "Exportação do sistema SH com dados técnicos de reparo por IMEI (OS, defeito, status, data).",
    sourceType: "Enriquecimento",
    expectedFile: "sH.xls / sH.xlsx",
    accept: ".xls,.xlsx",
  },
  {
    key: "his",
    label: "His Estoque (Trade-In)",
    description: "Controle de entrada de aparelhos Trade-In com IMEI, OS, custo auditado e data de entrada.",
    sourceType: "Eventos",
    expectedFile: "CONTROLE DE ENTRADA TRADE-IN.xlsx",
    accept: ".xls,.xlsx",
  },
  {
    key: "bkp",
    label: "BKP Sistêmico",
    description: "Backup do sistema com 3 abas: reparos técnicos, baixas de peças e triagem de entrada.",
    sourceType: "Eventos",
    expectedFile: "BKP SISTEMICO.xlsx",
    accept: ".xls,.xlsx",
  },
  {
    key: "triagem-saida",
    label: "Triagem Saída",
    description: "Registro de saída de aparelhos com destino (venda, reparo, sucata), grade e data.",
    sourceType: "Eventos",
    expectedFile: "TRIAGEM SAIDA.xlsx",
    accept: ".xls,.xlsx",
  },
  {
    key: "peacs",
    label: "PEACS — Catálogo de Preços",
    description: "Tabela de avaliação com preços estimados de venda por marca / modelo / capacidade.",
    sourceType: "Catálogo",
    expectedFile: "PEDIDOS.xlsx (aba TABELA DE AVALIAÇÃO PEACS)",
    accept: ".xls,.xlsx",
  },
];

const SOURCE_TYPE_COLORS: Record<string, string> = {
  Snapshot:      "var(--color-info)",
  Eventos:       "var(--color-warning)",
  Enriquecimento:"var(--color-success)",
  Catálogo:      "#a78bfa",
  Legado:        "var(--color-text-muted)",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function StatusDot({ status }: { status: string | null }) {
  const color = !status ? "var(--color-text-muted)"
    : status === "COMPLETED" ? "var(--color-success)"
    : status === "PENDING"   ? "var(--color-warning)"
    : status === "FAILED"    ? "var(--color-danger)"
    : status === "CANCELLED" ? "var(--color-text-muted)"
    : status.startsWith("COMPLETED") ? "var(--color-success)"
    : "var(--color-text-muted)";

  return (
    <span style={{
      display: "inline-block",
      width: 8, height: 8,
      borderRadius: "50%",
      backgroundColor: color,
      flexShrink: 0,
    }} />
  );
}

// ---------------------------------------------------------------------------
// History drawer
// ---------------------------------------------------------------------------

function HistoryDrawer({ source, label, onClose }: { source: SourceKey; label: string; onClose: () => void }) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/import-central/${source}/history`)
      .then(r => r.json())
      .then(d => setHistory(d.history ?? []))
      .catch(() => setError("Falha ao carregar histórico."));
  }, [source]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      display: "flex", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{ flex: 1, background: "rgba(0,0,0,0.4)" }} />
      <div style={{
        width: 480, background: "var(--color-surface)", boxShadow: "-4px 0 24px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <span style={{ fontWeight: 600 }}>{label} — Histórico</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}
          {!history && !error && <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--color-text-muted)" }}><Loader2 size={14} className="spin" />Carregando…</div>}
          {history && history.length === 0 && <p style={{ color: "var(--color-text-muted)" }}>Nenhuma importação registrada.</p>}
          {history && history.map(h => (
            <div key={h.id} style={{ marginBottom: 16, padding: 12, border: "1px solid var(--color-border)", borderRadius: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <StatusDot status={h.status} />
                <span style={{ fontWeight: 500, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.filename}>{h.filename}</span>
                <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>#{h.id}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                <span>Status: {h.status}</span>
                <span>Linhas: {h.rowsFound}</span>
                {h.rowsLinked !== undefined && <span>Vinculadas: {h.rowsLinked}</span>}
                {h.rowsUnlinked !== undefined && <span>Sem vínculo: {h.rowsUnlinked}</span>}
                {h.rowsValid !== undefined && <span>Válidas: {h.rowsValid}</span>}
                <span>Problemas: {h.issuesCount}</span>
                <span style={{ gridColumn: "1 / -1" }}>Importado: {fmtDate(h.createdAt)}</span>
                {h.createdByName && <span style={{ gridColumn: "1 / -1" }}>Por: {h.createdByName}</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6, fontFamily: "monospace", wordBreak: "break-all" }}>
                {h.fileHash.slice(0, 12)}…
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload + Preview dialog
// ---------------------------------------------------------------------------

function UploadDialog({
  source,
  onClose,
  onDone,
}: {
  source: SourceDefinition;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"upload" | "preview" | "confirming" | "done" | "error">("upload");
  const [preview, setPreview]     = useState<PreviewResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(file: File) {
    setUploading(true);
    setErrorMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`/api/import-central/${source.key}/preview`, { method: "POST", body: fd });
      const data = await r.json() as PreviewResult & { error?: string };
      if (!r.ok) {
        setErrorMsg(data.error ?? "Falha ao processar arquivo.");
        setStep("error");
        return;
      }
      setPreview(data);
      setStep("preview");
    } catch {
      setErrorMsg("Erro de rede.");
      setStep("error");
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    setConfirming(true);
    try {
      const r = await fetch(`/api/import-central/${source.key}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId: preview.importId }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok) {
        setErrorMsg(data.error ?? "Falha ao confirmar importação.");
        setStep("error");
        return;
      }
      setStep("done");
      setTimeout(() => { onDone(); onClose(); }, 1500);
    } catch {
      setErrorMsg("Erro de rede ao confirmar.");
      setStep("error");
    } finally {
      setConfirming(false);
    }
  }

  async function handleCancel() {
    if (preview && !preview.alreadyImported) {
      await fetch(`/api/import-central/${source.key}/imports/${preview.importId}`, { method: "DELETE" }).catch(() => null);
    }
    onClose();
  }

  const hasFatalError = preview?.issues.some(i => i.severity === "ERROR") ?? false;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={handleCancel} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }} />
      <div style={{
        position: "relative", width: "min(640px, 95vw)",
        background: "var(--color-surface)", borderRadius: 8,
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        display: "flex", flexDirection: "column", maxHeight: "90vh", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <Upload size={15} style={{ color: "var(--color-accent)" }} />
          <span style={{ fontWeight: 600, flex: 1 }}>Importar — {source.label}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleCancel}><X size={14} /></button>
        </div>

        <div style={{ overflowY: "auto", padding: 20, flex: 1 }}>
          {/* Upload step */}
          {step === "upload" && (
            <div>
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginBottom: 16 }}>
                Arquivo esperado: <strong>{source.expectedFile}</strong>
              </p>
              <div
                style={{
                  border: "2px dashed var(--color-border)", borderRadius: 8,
                  padding: 32, textAlign: "center", cursor: "pointer",
                  transition: "border-color 0.15s",
                }}
                onClick={() => inputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); }}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f); }}
              >
                {uploading
                  ? <><Loader2 size={24} className="spin" style={{ marginBottom: 8 }} /><p style={{ color: "var(--color-text-muted)" }}>Processando…</p></>
                  : <><Upload size={24} style={{ color: "var(--color-accent)", marginBottom: 8 }} /><p>Clique ou arraste o arquivo aqui</p><p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>Aceita: {source.accept}</p></>
                }
              </div>
              <input ref={inputRef} type="file" accept={source.accept} style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />
            </div>
          )}

          {/* Preview step */}
          {step === "preview" && preview && (
            <div>
              {preview.alreadyImported && (
                <div className="info-banner" style={{ marginBottom: 16, borderColor: "var(--color-warning)" }}>
                  <AlertTriangle size={14} />
                  Este arquivo já foi importado anteriormente (importação #{preview.existingImportId}).
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div style={{ padding: 10, background: "var(--color-surface-alt)", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Arquivo</div>
                  <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={preview.filename}>{preview.filename}</div>
                </div>
                <div style={{ padding: 10, background: "var(--color-surface-alt)", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Hash (SHA-256)</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11 }}>{preview.fileHash.slice(0, 16)}…</div>
                </div>
                <div style={{ padding: 10, background: "var(--color-surface-alt)", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Linhas encontradas</div>
                  <div style={{ fontWeight: 600, fontSize: 18 }}>{preview.rowsFound}</div>
                </div>
                <div style={{ padding: 10, background: "var(--color-surface-alt)", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Linhas válidas</div>
                  <div style={{ fontWeight: 600, fontSize: 18, color: preview.rowsValid > 0 ? "var(--color-success)" : "var(--color-danger)" }}>{preview.rowsValid}</div>
                </div>
              </div>

              {preview.issues.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>Problemas detectados</div>
                  <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {preview.issues.map((issue, i) => (
                      <div key={i} style={{
                        display: "flex", gap: 8, padding: "6px 10px",
                        background: issue.severity === "ERROR" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                        borderRadius: 4, fontSize: 12,
                        borderLeft: `3px solid ${issue.severity === "ERROR" ? "var(--color-danger)" : "var(--color-warning)"}`,
                      }}>
                        <span style={{ flexShrink: 0, color: issue.severity === "ERROR" ? "var(--color-danger)" : "var(--color-warning)" }}>
                          {issue.severity === "ERROR" ? "ERRO" : "AVISO"}
                        </span>
                        <span style={{ color: "var(--color-text-muted)" }}>
                          {issue.row != null ? `linha ${issue.row}: ` : ""}{issue.message}
                          {issue.code && <span style={{ marginLeft: 4, fontFamily: "monospace", fontSize: 10 }}>({issue.code})</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preview.previewRows.length > 0 && (
                <div>
                  <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>Amostra (primeiras {preview.previewRows.length} linhas)</div>
                  <div style={{ overflowX: "auto", borderRadius: 4, border: "1px solid var(--color-border)" }}>
                    <table style={{ fontSize: 11, width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          {Object.keys(preview.previewRows[0]).slice(0, 8).map(k => (
                            <th key={k} style={{ padding: "6px 8px", textAlign: "left", borderBottom: "1px solid var(--color-border)", whiteSpace: "nowrap", background: "var(--color-surface-alt)" }}>{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.previewRows.map((row, ri) => (
                          <tr key={ri}>
                            {Object.values(row).slice(0, 8).map((v, ci) => (
                              <td key={ci} style={{ padding: "5px 8px", borderBottom: "1px solid var(--color-border)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {v == null ? <span style={{ color: "var(--color-text-muted)" }}>—</span> : String(v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Done */}
          {step === "done" && (
            <div style={{ textAlign: "center", padding: 24 }}>
              <CheckCircle2 size={40} style={{ color: "var(--color-success)", marginBottom: 12 }} />
              <p style={{ fontWeight: 600 }}>Importação concluída!</p>
            </div>
          )}

          {/* Error */}
          {step === "error" && (
            <div style={{ textAlign: "center", padding: 24 }}>
              <XCircle size={40} style={{ color: "var(--color-danger)", marginBottom: 12 }} />
              <p style={{ fontWeight: 600, marginBottom: 8 }}>Falha na importação</p>
              {errorMsg && <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{errorMsg}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        {(step === "preview" || step === "error") && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--color-border)" }}>
            <button className="btn btn-secondary btn-sm" onClick={handleCancel}>
              {step === "error" ? "Fechar" : "Cancelar"}
            </button>
            {step === "preview" && !preview?.alreadyImported && (
              <button
                className="btn btn-primary btn-sm"
                disabled={hasFatalError || confirming || (preview?.rowsValid === 0)}
                onClick={handleConfirm}
              >
                {confirming ? <><Loader2 size={13} className="spin" /> Confirmando…</> : "Confirmar importação"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source card
// ---------------------------------------------------------------------------

function SourceCard({
  def,
  status,
  onUpload,
  onHistory,
}: {
  def: SourceDefinition;
  status: SourceStatus;
  onUpload: () => void;
  onHistory: () => void;
}) {
  const typeColor = SOURCE_TYPE_COLORS[def.sourceType] ?? "var(--color-text-muted)";

  return (
    <div style={{
      background: "var(--color-surface)", border: "1px solid var(--color-border)",
      borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <StatusDot status={status.lastStatus} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>{def.label}</span>
          </div>
          <span style={{
            display: "inline-block", fontSize: 10, padding: "2px 6px",
            borderRadius: 10, background: typeColor + "22", color: typeColor,
            fontWeight: 500, marginBottom: 6,
          }}>{def.sourceType}</span>
          <p style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5, margin: 0 }}>{def.description}</p>
        </div>
      </div>

      <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <span>
          <Clock size={11} style={{ verticalAlign: "middle", marginRight: 3 }} />
          {fmtDate(status.lastImportAt)}
        </span>
        <span>
          {status.totalImports} importaç{status.totalImports === 1 ? "ão" : "ões"}
        </span>
        {status.lastStatus && <>
          <span>Linhas: {status.lastRowsFound}</span>
          <span style={{ color: status.lastIssuesCount > 0 ? "var(--color-warning)" : "var(--color-success)" }}>
            {status.lastIssuesCount > 0 ? `⚠ ${status.lastIssuesCount} probl.` : "✓ Sem probl."}
          </span>
        </>}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={onHistory}>
          <Clock size={12} /> Histórico
        </button>
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={onUpload}>
          <Upload size={12} /> Importar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legado card (read-only)
// ---------------------------------------------------------------------------

function LegadoCard({ legado }: { legado: LegadoStatus | null }) {
  return (
    <div style={{
      background: "var(--color-surface)", border: "1px solid var(--color-border)",
      borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <StatusDot status={legado?.initialized ? "COMPLETED" : null} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>PEDIDOS + ANALISE MI (Legado)</span>
        </div>
        <span style={{
          display: "inline-block", fontSize: 10, padding: "2px 6px",
          borderRadius: 10, background: "var(--color-text-muted)22", color: "var(--color-text-muted)",
          fontWeight: 500, marginBottom: 6,
        }}>Legado</span>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5, margin: 0 }}>
          Inicialização única do sistema a partir de PEDIDOS.xlsx e ANALISE MI.xlsx. Somente leitura após inicialização.
        </p>
      </div>

      {legado && (
        <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
          <span>Status: {legado.batchStatus ?? "Não inicializado"}</span>
          <span>Lote: #{legado.batchId ?? "—"}</span>
          <span>Pedidos: {legado.ordersFound}</span>
          <span>Estoque: {legado.inventoryFound}</span>
          <span style={{ gridColumn: "1 / -1" }}>{fmtDate(legado.createdAt)}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} disabled title="Somente leitura — importação bloqueada após inicialização">
          <Lock size={12} /> Bloqueado
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AdminDados() {
  const [allStatus, setAllStatus] = useState<AllStatus | null>(null);
  const [legado, setLegado]       = useState<LegadoStatus | null>(null);
  const [loading, setLoading]     = useState(true);
  const [uploadFor, setUploadFor] = useState<SourceDefinition | null>(null);
  const [historyFor, setHistoryFor] = useState<SourceDefinition | null>(null);
  const [error, setError]         = useState<string | null>(null);

  function loadStatus() {
    setLoading(true);
    fetch("/api/import-central/status")
      .then(r => r.json())
      .then(d => {
        setAllStatus(d.status);
        setLegado(d.legado);
        setError(null);
      })
      .catch(() => setError("Falha ao carregar status das fontes."))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadStatus(); }, []);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Central de Dados</h1>
          <p className="page-subtitle">Importações sistêmicas por fonte — preview → confirmar → auditável</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadStatus} disabled={loading} title="Atualizar status">
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="info-banner" style={{ borderColor: "var(--color-danger)", marginBottom: 16 }}>
          <XCircle size={14} />{error}
        </div>
      )}

      {loading && !allStatus && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-muted)", padding: "24px 0" }}>
          <Loader2 size={16} className="spin" /> Carregando status…
        </div>
      )}

      {/* Summary bar */}
      {allStatus && (
        <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { label: "Fontes com importação", value: Object.values(allStatus).filter(s => s.lastStatus === "COMPLETED").length },
            { label: "Nunca importadas",       value: Object.values(allStatus).filter(s => !s.lastStatus).length },
            { label: "Total de importações",   value: Object.values(allStatus).reduce((a, s) => a + s.totalImports, 0) },
          ].map(stat => (
            <div key={stat.label} style={{ padding: "10px 16px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{stat.label}</div>
              <div style={{ fontWeight: 600, fontSize: 20 }}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Cards grid */}
      {allStatus && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {SOURCES.map(def => (
            <SourceCard
              key={def.key}
              def={def}
              status={allStatus[def.key]}
              onUpload={() => setUploadFor(def)}
              onHistory={() => setHistoryFor(def)}
            />
          ))}
          <LegadoCard legado={legado} />
        </div>
      )}

      {/* Legend */}
      <div style={{ marginTop: 24, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--color-text-muted)" }}>
        {(["Snapshot", "Eventos", "Enriquecimento", "Catálogo", "Legado"] as const).map(t => (
          <span key={t} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: SOURCE_TYPE_COLORS[t] }} />
            {t}
          </span>
        ))}
      </div>

      {/* Dialogs */}
      {uploadFor && (
        <UploadDialog
          source={uploadFor}
          onClose={() => setUploadFor(null)}
          onDone={() => { setUploadFor(null); loadStatus(); }}
        />
      )}
      {historyFor && (
        <HistoryDrawer
          source={historyFor.key}
          label={historyFor.label}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}
