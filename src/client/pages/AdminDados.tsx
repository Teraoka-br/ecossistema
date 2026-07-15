import { useState, useEffect, useRef } from "react";
import {
  Upload, Clock, CheckCircle2, XCircle, AlertTriangle,
  X, Loader2, RefreshCw, Info,
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
  pendingStaging: number;
}

type SourceKey = "his" | "rel-seriais" | "rel-seriais-saldo" | "analise-mi" | "pedidos" | "bkp" | "triagem-saida" | "sh" | "peacs" | "demonstrativo";

interface AllStatus {
  his: SourceStatus;
  "rel-seriais": SourceStatus;
  "rel-seriais-saldo": SourceStatus;
  "analise-mi": SourceStatus;
  pedidos: SourceStatus;
  bkp: SourceStatus;
  "triagem-saida": SourceStatus;
  sh: SourceStatus;
  peacs: SourceStatus;
  demonstrativo: SourceStatus;
}

interface LegadoStatus {
  initialized: boolean;
  lastBatchId: number | null;
  lastBatchAt: string | null;
  ordersFound: number;
  inventoryFound: number;
}

interface PreviewIssue {
  row: number | null;
  severity: "ERROR" | "WARNING" | "INFO";
  code: string;
  message: string;
}

interface PreviewResult {
  stagingId: number;
  source: SourceKey;
  filename: string;
  fileHash: string;
  fileSize: number;
  status: string;
  rowsFound: number;
  rowsValid: number;
  issues: PreviewIssue[];
  alreadyImported: boolean;
  existingImportId: number | null;
  previewRows: Record<string, unknown>[];
  extra?: Record<string, unknown>;
}

interface HistoryEntry {
  id: number;
  filename: string;
  fileHash: string;
  status: string;
  rowsFound: number;
  rowsValid?: number;
  issuesCount: number;
  createdAt: string;
  finishedAt: string | null;
  createdByName?: string | null;
}

interface SourceConfig {
  arquivo: string;
  aba: string;
  chave: string;
  camposPrincipais: string[];
  destino: string;
  observacoes: string;
}

interface SourceDefinition {
  key: SourceKey;
  label: string;
  description: string;
  sourceType: "Snapshot" | "Eventos" | "Enriquecimento" | "Catálogo";
  accept: string;
  config: SourceConfig;
}

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

const SOURCES: SourceDefinition[] = [
  {
    key: "his",
    label: "His Estoque",
    description: "Histórico de custo e idade dos aparelhos em estoque (Trade-In). Regra: última ocorrência por IMEI.",
    sourceType: "Snapshot",
    accept: ".xls,.xlsx",
    config: {
      arquivo: "CONTROLE DE ENTRADA TRADE-IN.xlsx",
      aba: "His Estoque",
      chave: "IMEI (col B = Serial)",
      camposPrincipais: ["Serial → IMEI", "Dias em Estoque (col R)", "Custo estoque (col S)", "Data Relatorio (col U)"],
      destino: "his_import_rows",
      observacoes: "Última ocorrência física por IMEI (equivalente a PROCX search_mode=-1). Zero preservado.",
    },
  },
  {
    key: "rel-seriais-saldo",
    label: "Rel. Estoque de Seriais — Com Saldo",
    description: "Filtro 'Com saldo' do Datasys: uma linha por aparelho com depósito atual. Fonte principal de deposito_atual.",
    sourceType: "Snapshot",
    accept: ".csv",
    config: {
      arquivo: "Rel_Estoque_de_Seriais_ComSaldo (...).csv",
      aba: "CSV (separado por ;)",
      chave: "Serial",
      camposPrincipais: ["Serial", "Produto", "Descrição", "Depósito Atual", "Filial Atual", "Disponível"],
      destino: "rel_seriais_current",
      observacoes: "Uma linha por IMEI — estado atual do aparelho. Use o filtro 'Com Saldo' no Datasys ao exportar.",
    },
  },
  {
    key: "rel-seriais",
    label: "Rel. Estoque de Seriais — Todos (histórico)",
    description: "Filtro 'Todos' do Datasys: histórico completo de eventos por aparelho. Secundário — prefira o 'Com Saldo'.",
    sourceType: "Snapshot",
    accept: ".csv",
    config: {
      arquivo: "Rel_Estoque_de_Seriais (...).csv",
      aba: "CSV (separado por ;)",
      chave: "Serial",
      camposPrincipais: ["Serial", "Produto", "Descrição", "Depósito Atual", "Filial Atual", "Disponível", "Dias em Estoque"],
      destino: "rel_seriais_current",
      observacoes: "Múltiplas linhas por IMEI. A última linha de cada IMEI define o estado atual.",
    },
  },
  {
    key: "analise-mi",
    label: "Análise MI",
    description: "Demandas de peças por aparelho (IMEI/OS/ID PEDIDO). Base de reconciliação de solicitações.",
    sourceType: "Eventos",
    accept: ".xls,.xlsx",
    config: {
      arquivo: "ANALISE MI.xlsx",
      aba: "ANALISEMI (fallback: ANALISE)",
      chave: "ID PEDIDO",
      camposPrincipais: ["ID PEDIDO", "IMEI", "OS", "PEÇASOLICITADA", "STATUS", "DEPÓSITO", "REF", "SOLICITANTE"],
      destino: "analise_mi_rows",
      observacoes: "ID PEDIDO como chave de idempotência. Sem IMEI válido: linha sem vínculo a aparelho.",
    },
  },
  {
    key: "pedidos",
    label: "Pedidos (3 abas)",
    description: "PEDIDOS.xlsx completo: reconciliação de pedidos, snapshot da BIPAGEM DE PEÇAS e catálogo PEACS.",
    sourceType: "Eventos",
    accept: ".xls,.xlsx",
    config: {
      arquivo: "PEDIDOS.xlsx",
      aba: "PEDIDOS + BIPAGEM DE PEÇAS + TABELA DE AVALIAÇÃO (PEACS)",
      chave: "ID PEDIDO (PEDIDOS) · REFERENCIA (BIPAGEM) · MARCA/MODELO (PEACS)",
      camposPrincipais: ["ID PEDIDO", "IMEI", "STATUS", "REFPEÇA", "CHAVEPECA", "REFERENCIA", "ARRUMAR", "TABELA SEMINOVO PRAZO"],
      destino: "pedidos_reconciliation_rows + pedidos_bipagem_rows + peacs_catalog",
      observacoes: "A aba His Estoque não é lida aqui — use o card 'His Estoque'. PEACS substitui catálogo ativo atomicamente.",
    },
  },
  {
    key: "bkp",
    label: "BKP Sistêmico",
    description: "Backup com 3 abas: reparos técnicos realizados, baixas de peças e triagem de entrada.",
    sourceType: "Eventos",
    accept: ".xls,.xlsx",
    config: {
      arquivo: "BKP SISTEMICO.xlsx",
      aba: "REPAROS TECNICOS + BAIXA_DE_PEÇA + TRIAGEM ENTRADA",
      chave: "ID (REPAROS/BAIXA) · OS SH + IMEI (TRIAGEM)",
      camposPrincipais: ["ID", "IMEI", "OS", "DATA", "STATUS", "PEÇA UTILIZADA", "REF", "TÉCNICO RESPONSÁVEL", "TIPO DE REPARO"],
      destino: "systemic_repair_events + systemic_part_writeoffs + device_location_snapshots",
      observacoes: "INSERT OR IGNORE — idempotente por ID interno. Triagem sem ID usa IMEI+OS como chave.",
    },
  },
  {
    key: "triagem-saida",
    label: "Triagem de Saída",
    description: "Saída de aparelhos: destino, reparo efetivo, motivo, técnico e datas. Chave: CONCAT.",
    sourceType: "Eventos",
    accept: ".xls,.xlsx",
    config: {
      arquivo: "TRIAGEM SAIDA.xlsx",
      aba: "triagem saida",
      chave: "CONCAT",
      camposPrincipais: ["CONCAT", "IMEI", "OS", "REPARO EFETIVO", "MOTIVO", "ESTOQUE DESTINO", "DATA REPARO", "DATA TRIAGEM", "TÉCNICO RESPONSÁVEL"],
      destino: "triagem_saida_rows",
      observacoes: "Aceita tanto MANUTEÇÃO (com typo) quanto MANUTENÇÃO. REPARO EFETIVO=NÃO sem motivo gera aviso.",
    },
  },
  {
    key: "sh",
    label: "SH Ordens de Serviço",
    description: "Ordens de serviço do SH: OS, IMEI, marca, modelo, cor, defeito e observação.",
    sourceType: "Enriquecimento",
    accept: ".xls,.xlsx",
    config: {
      arquivo: "sH (...).xls",
      aba: "primeira aba com cabeçalho OS/IMEI",
      chave: "OS (col B) + IMEI/SERIE (col R)",
      camposPrincipais: ["OS (col B)", "Marca (col O)", "Modelo (col P)", "Cor (col Q)", "IMEI/SERIE (col R)", "DEFEITO", "OBS_SERVICO"],
      destino: "sh_os_rows",
      observacoes: "Auto-detecção da linha de cabeçalho (busca por OS/IMEI/SERIE). Indexado por IMEI e OS para prefill.",
    },
  },
  {
    key: "peacs",
    label: "PEACS (standalone)",
    description: "Tabela de preços seminovo (PEACS) independente — substitui a aba PEACS do PEDIDOS.xlsx.",
    sourceType: "Catálogo",
    accept: ".xlsx,.xls",
    config: {
      arquivo: "PEACS (...).xlsx",
      aba: "aba cujo nome contém 'PEACS'",
      chave: "MARCA-MODELO (col A)",
      camposPrincipais: ["MARCA-MODELO (col A)", "TABELA SEMINOVO PRAZO (col E)"],
      destino: "peacs_catalog (active=1)",
      observacoes: "Substitui atomicamente o catálogo ativo (active=0 em todos, depois INSERT novos). Match exato normalizado (sem acentos, maiúsculas).",
    },
  },
  {
    key: "demonstrativo",
    label: "Demonstrativo de Saldos",
    description: "Saldos do Datasys por referência, descrição, código comercial, fabricante e grupo.",
    sourceType: "Snapshot",
    accept: ".xlsx,.xls",
    config: {
      arquivo: "RelDemonstrativoSaldos (...).xls",
      aba: "primeira aba com cabeçalho REFERENCIA/SALDO",
      chave: "REFERENCIA",
      camposPrincipais: ["REFERENCIA", "DESCRIÇÃO", "COD. COMERCIAL", "FABRICANTE", "GRUPO", "SUBGRUPO", "FAMÍLIA", "SALDO"],
      destino: "demonstrativo_rows",
      observacoes: "Auto-detecção do cabeçalho. Persiste todas as linhas para consulta futura de saldos.",
    },
  },
];

const SOURCE_TYPE_COLORS: Record<string, string> = {
  Snapshot:      "var(--color-info)",
  Eventos:       "var(--color-warning)",
  Enriquecimento:"var(--color-success)",
  Catálogo:      "#a78bfa",
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
      display: "inline-block", width: 8, height: 8,
      borderRadius: "50%", backgroundColor: color, flexShrink: 0,
    }} />
  );
}

// ---------------------------------------------------------------------------
// Configuração modal
// ---------------------------------------------------------------------------

function ConfigModal({ def, onClose }: { def: SourceDefinition; onClose: () => void }) {
  const c = def.config;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }} />
      <div style={{
        position: "relative", width: "min(520px, 95vw)",
        background: "var(--color-surface)", borderRadius: 8,
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        maxHeight: "85vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <Info size={15} style={{ color: "var(--color-accent)" }} />
          <span style={{ fontWeight: 600, flex: 1 }}>Configuração — {def.label}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          {([
            ["Arquivo esperado", c.arquivo],
            ["Aba(s)",           c.aba],
            ["Chave",            c.chave],
            ["Tabela destino",   c.destino],
            ["Observações",      c.observacoes],
          ] as [string, string][]).map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 13 }}>{val}</div>
            </div>
          ))}
          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 6 }}>Campos principais</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {c.camposPrincipais.map(f => (
                <span key={f} style={{
                  fontSize: 11, padding: "2px 8px",
                  background: "var(--color-surface-alt)", border: "1px solid var(--color-border)",
                  borderRadius: 10, fontFamily: "monospace",
                }}>{f}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending staging drawer — retomada de previews pendentes
// ---------------------------------------------------------------------------

interface StagingEntry {
  id: number;
  filename: string;
  fileHash: string;
  fileSize: number;
  status: "UPLOADED" | "PREVIEW_READY" | "FAILED";
  createdAt: string;
  expiresAt: string;
  previewJson: string | null;
}

function PendingDrawer({
  source,
  label,
  onClose,
  onConfirmed,
}: {
  source: SourceKey;
  label: string;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [entries, setEntries] = useState<StagingEntry[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [selected, setSelected] = useState<{ entry: StagingEntry; preview: PreviewResult } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [operationalWarnings, setOperationalWarnings] = useState<string[] | null>(null);

  function load() {
    setEntries(null);
    setError(null);
    fetch(`/api/import-central/${source}/staged`)
      .then(r => r.json())
      .then(d => setEntries((d.staged ?? []) as StagingEntry[]))
      .catch(() => setError("Falha ao carregar previews pendentes."));
  }

  useEffect(() => { load(); }, [source]);

  function openPreview(entry: StagingEntry) {
    if (!entry.previewJson) return;
    try {
      const preview = JSON.parse(entry.previewJson) as PreviewResult;
      setSelected({ entry, preview });
      setConfirmError(null);
      setOperationalWarnings(null);
    } catch { setError("Preview inválido."); }
  }

  async function handleConfirm() {
    if (!selected) return;
    setConfirming(true);
    setConfirmError(null);
    setOperationalWarnings(null);
    try {
      const r = await fetch(`/api/import-central/${source}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stagingId: selected.entry.id }),
      });
      const data = await r.json() as { ok?: boolean; error?: string; operationalOk?: boolean; operationalErrors?: string[] };
      if (!r.ok) { setConfirmError(data.error ?? "Falha ao confirmar."); return; }
      onConfirmed();
      if (data.operationalOk === false && data.operationalErrors?.length) {
        setOperationalWarnings(data.operationalErrors);
        // Não fecha: importação ok, mas sync operacional falhou — usuário deve ver os erros
      } else {
        onClose();
      }
    } catch { setConfirmError("Erro de rede ao confirmar."); }
    finally { setConfirming(false); }
  }

  async function handleCancel(id: number) {
    await fetch(`/api/import-central/${source}/staged/${id}`, { method: "DELETE" }).catch(() => null);
    load();
    if (selected?.entry.id === id) setSelected(null);
  }

  const now = new Date();

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ flex: 1, background: "rgba(0,0,0,0.4)" }} />
      <div style={{ width: selected ? 640 : 420, background: "var(--color-surface)", boxShadow: "-4px 0 24px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <span style={{ fontWeight: 600 }}>{label} — Previews pendentes</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", display: "flex" }}>
          {/* Lista de entradas */}
          <div style={{ width: 220, borderRight: selected ? "1px solid var(--color-border)" : undefined, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {error && <p style={{ color: "var(--color-danger)", fontSize: 12 }}>{error}</p>}
            {!entries && !error && <div style={{ display: "flex", gap: 6, color: "var(--color-text-muted)", fontSize: 12 }}><Loader2 size={13} className="spin" />Carregando…</div>}
            {entries && entries.length === 0 && <p style={{ color: "var(--color-text-muted)", fontSize: 12 }}>Nenhum preview pendente.</p>}
            {entries && entries.map(entry => {
              const expired  = new Date(entry.expiresAt) < now;
              const hasPreview = !!entry.previewJson;
              const isActive = selected?.entry.id === entry.id;
              return (
                <div key={entry.id} style={{
                  padding: 10, borderRadius: 6, border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border)"}`,
                  background: isActive ? "rgba(99,102,241,0.08)" : "var(--color-surface-alt)",
                  cursor: "pointer", opacity: expired ? 0.5 : 1,
                }} onClick={() => hasPreview && !expired ? openPreview(entry) : undefined}>
                  <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.filename}>{entry.filename}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                    #{entry.id} · {entry.status}
                    {expired && <span style={{ color: "var(--color-danger)" }}> · EXPIRADO</span>}
                    {!hasPreview && !expired && <span style={{ color: "var(--color-warning)" }}> · sem preview</span>}
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                    {hasPreview && !expired && (
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 10, padding: "2px 6px" }} onClick={e => { e.stopPropagation(); openPreview(entry); }}>Abrir</button>
                    )}
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 10, padding: "2px 6px", color: "var(--color-danger)" }}
                      onClick={e => { e.stopPropagation(); handleCancel(entry.id); }}>Cancelar</button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Preview selecionado */}
          {selected && (
            <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { label: "Arquivo", value: selected.preview.filename, mono: false },
                  { label: "SHA-256", value: selected.preview.fileHash.slice(0, 16) + "…", mono: true },
                  { label: "Linhas encontradas", value: String(selected.preview.rowsFound), mono: false },
                  { label: "Linhas válidas", value: String(selected.preview.rowsValid), mono: false },
                ].map(({ label, value, mono }) => (
                  <div key={label} style={{ padding: 8, background: "var(--color-surface-alt)", borderRadius: 5 }}>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{label}</div>
                    <div style={{ fontWeight: 500, fontSize: 12, fontFamily: mono ? "monospace" : undefined }}>{value}</div>
                  </div>
                ))}
              </div>

              {selected.preview.alreadyImported && (
                <div className="info-banner" style={{ borderColor: "var(--color-warning)", fontSize: 12 }}>
                  <AlertTriangle size={13} /> Arquivo já importado anteriormente (#{selected.preview.existingImportId}).
                </div>
              )}

              {selected.preview.issues.length > 0 && (
                <div>
                  <div style={{ fontWeight: 500, fontSize: 12, marginBottom: 6 }}>Problemas ({selected.preview.issues.length})</div>
                  <div style={{ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                    {selected.preview.issues.slice(0, 20).map((issue, i) => (
                      <div key={i} style={{
                        fontSize: 11, padding: "4px 8px", borderRadius: 3,
                        borderLeft: `3px solid ${issue.severity === "ERROR" ? "var(--color-danger)" : issue.severity === "WARNING" ? "var(--color-warning)" : "var(--color-info)"}`,
                        background: issue.severity === "ERROR" ? "rgba(239,68,68,0.07)" : issue.severity === "WARNING" ? "rgba(245,158,11,0.07)" : "rgba(99,102,241,0.05)",
                      }}>
                        <span style={{ color: "var(--color-text-muted)" }}>{issue.row != null ? `L${issue.row}: ` : ""}{issue.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.preview.extra && (
                <details>
                  <summary style={{ fontSize: 11, color: "var(--color-text-muted)", cursor: "pointer" }}>Detalhes técnicos</summary>
                  <pre style={{ fontSize: 10, background: "var(--color-surface-alt)", padding: 8, borderRadius: 4, overflowX: "auto", marginTop: 4 }}>
                    {JSON.stringify(selected.preview.extra, null, 2)}
                  </pre>
                </details>
              )}

              {confirmError && <p style={{ color: "var(--color-danger)", fontSize: 12 }}>{confirmError}</p>}
              {operationalWarnings && (
                <div style={{ background: "var(--color-warning-subtle, rgba(234,179,8,0.1))", border: "1px solid var(--color-warning)", borderRadius: 4, padding: "8px 10px", fontSize: 12 }}>
                  <strong style={{ color: "var(--color-warning)" }}>Importação concluída, mas o sync operacional encontrou erros:</strong>
                  <ul style={{ margin: "4px 0 0 14px", padding: 0 }}>
                    {operationalWarnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                <button className="btn btn-secondary btn-sm" onClick={() => { handleCancel(selected.entry.id); setSelected(null); }}>Cancelar staging</button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={confirming || selected.preview.alreadyImported || selected.preview.issues.some(i => i.severity === "ERROR")}
                  onClick={handleConfirm}
                >
                  {confirming ? <><Loader2 size={12} className="spin" />Confirmando…</> : "Confirmar importação"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
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
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
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
  const [step, setStep] = useState<"upload" | "preview" | "confirming" | "done" | "done_with_errors" | "error">("upload");
  const [preview, setPreview]       = useState<PreviewResult | null>(null);
  const [uploading, setUploading]   = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);
  const [operationalErrors, setOperationalErrors] = useState<string[]>([]);
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
        body: JSON.stringify({ stagingId: preview.stagingId }),
      });
      const data = await r.json() as { ok?: boolean; error?: string; operationalOk?: boolean; operationalErrors?: string[] };
      if (!r.ok) {
        setErrorMsg(data.error ?? "Falha ao confirmar importação.");
        setStep("error");
        return;
      }
      onDone();
      if (data.operationalOk === false && data.operationalErrors?.length) {
        setOperationalErrors(data.operationalErrors);
        setStep("done_with_errors");
        return;
      }
      setStep("done");
      setTimeout(() => { onClose(); }, 1500);
    } catch {
      setErrorMsg("Erro de rede ao confirmar.");
      setStep("error");
    } finally {
      setConfirming(false);
    }
  }

  function handleCancel() {
    if (preview) {
      fetch(`/api/import-central/${source.key}/staged/${preview.stagingId}`, { method: "DELETE" }).catch(() => null);
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <Upload size={15} style={{ color: "var(--color-accent)" }} />
          <span style={{ fontWeight: 600, flex: 1 }}>Importar — {source.label}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleCancel}><X size={14} /></button>
        </div>

        <div style={{ overflowY: "auto", padding: 20, flex: 1 }}>
          {step === "upload" && (
            <div>
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginBottom: 16 }}>
                Arquivo esperado: <strong>{source.config.arquivo}</strong>
              </p>
              <div
                style={{ border: "2px dashed var(--color-border)", borderRadius: 8, padding: 32, textAlign: "center", cursor: "pointer" }}
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

          {step === "preview" && preview && (
            <div>
              {preview.alreadyImported && (
                <div className="info-banner" style={{ marginBottom: 16, borderColor: "var(--color-warning)" }}>
                  <AlertTriangle size={14} />
                  Este arquivo já foi importado anteriormente (importação #{preview.existingImportId}).
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                {[
                  { label: "Arquivo", value: preview.filename, mono: false },
                  { label: "SHA-256", value: preview.fileHash.slice(0, 16) + "…", mono: true },
                  { label: "Linhas encontradas", value: String(preview.rowsFound), mono: false },
                  { label: "Linhas válidas", value: String(preview.rowsValid), mono: false },
                ].map(({ label, value, mono }) => (
                  <div key={label} style={{ padding: 10, background: "var(--color-surface-alt)", borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{label}</div>
                    <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: mono ? "monospace" : undefined }}>{value}</div>
                  </div>
                ))}
              </div>

              {preview.issues.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>Problemas detectados</div>
                  <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {preview.issues.map((issue, i) => (
                      <div key={i} style={{
                        display: "flex", gap: 8, padding: "6px 10px",
                        background: issue.severity === "ERROR" ? "rgba(239,68,68,0.08)" : issue.severity === "WARNING" ? "rgba(245,158,11,0.08)" : "rgba(99,102,241,0.06)",
                        borderRadius: 4, fontSize: 12,
                        borderLeft: `3px solid ${issue.severity === "ERROR" ? "var(--color-danger)" : issue.severity === "WARNING" ? "var(--color-warning)" : "var(--color-info)"}`,
                      }}>
                        <span style={{ flexShrink: 0, color: issue.severity === "ERROR" ? "var(--color-danger)" : issue.severity === "WARNING" ? "var(--color-warning)" : "var(--color-info)" }}>
                          {issue.severity}
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

              {preview.extra && (
                <details style={{ marginTop: 16 }}>
                  <summary style={{ fontSize: 12, color: "var(--color-text-muted)", cursor: "pointer" }}>Detalhes técnicos do preview</summary>
                  <pre style={{ fontSize: 11, background: "var(--color-surface-alt)", padding: 12, borderRadius: 4, overflowX: "auto", marginTop: 8 }}>
                    {JSON.stringify(preview.extra, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}

          {step === "done" && (
            <div style={{ textAlign: "center", padding: 24 }}>
              <CheckCircle2 size={40} style={{ color: "var(--color-success)", marginBottom: 12 }} />
              <p style={{ fontWeight: 600 }}>Importação concluída!</p>
            </div>
          )}

          {step === "done_with_errors" && (
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <CheckCircle2 size={28} style={{ color: "var(--color-success)", flexShrink: 0 }} />
                <p style={{ fontWeight: 600, margin: 0 }}>Importação concluída</p>
              </div>
              <div style={{ background: "var(--color-warning-subtle, rgba(234,179,8,0.1))", border: "1px solid var(--color-warning)", borderRadius: 4, padding: "8px 12px", fontSize: 13 }}>
                <strong style={{ color: "var(--color-warning)" }}>Sync operacional com erros:</strong>
                <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                  {operationalErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            </div>
          )}

          {step === "error" && (
            <div style={{ textAlign: "center", padding: 24 }}>
              <XCircle size={40} style={{ color: "var(--color-danger)", marginBottom: 12 }} />
              <p style={{ fontWeight: 600, marginBottom: 8 }}>Falha na importação</p>
              {errorMsg && <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{errorMsg}</p>}
            </div>
          )}
        </div>

        {(step === "preview" || step === "error" || step === "done_with_errors") && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--color-border)" }}>
            <button className="btn btn-secondary btn-sm" onClick={handleCancel}>
              {step === "error" || step === "done_with_errors" ? "Fechar" : "Cancelar"}
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

const EMPTY_STATUS: SourceStatus = {
  lastImportId: null, lastImportAt: null, lastStatus: null,
  totalImports: 0, lastRowsFound: 0, lastIssuesCount: 0, pendingStaging: 0,
};

function SourceCard({
  def,
  status,
  onUpload,
  onHistory,
  onConfig,
  onPending,
}: {
  def: SourceDefinition;
  status: SourceStatus | null;
  onUpload: () => void;
  onHistory: () => void;
  onConfig: () => void;
  onPending: () => void;
}) {
  const s = status ?? EMPTY_STATUS;
  const typeColor = SOURCE_TYPE_COLORS[def.sourceType] ?? "var(--color-text-muted)";

  return (
    <div style={{
      background: "var(--color-surface)", border: "1px solid var(--color-border)",
      borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <StatusDot status={s.lastStatus} />
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{def.label}</span>
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: "2px 6px" }}
            title="Ver configuração"
            onClick={onConfig}
          >
            <Info size={13} />
          </button>
        </div>
        <span style={{
          display: "inline-block", fontSize: 10, padding: "2px 6px",
          borderRadius: 10, background: typeColor + "22", color: typeColor,
          fontWeight: 500, marginBottom: 6,
        }}>{def.sourceType}</span>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5, margin: 0 }}>{def.description}</p>
      </div>

      <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        {status === null ? (
          <span style={{ gridColumn: "1 / -1", fontStyle: "italic" }}>Nunca importado</span>
        ) : (
          <>
            <span><Clock size={11} style={{ verticalAlign: "middle", marginRight: 3 }} />{fmtDate(s.lastImportAt)}</span>
            <span>{s.totalImports} importaç{s.totalImports === 1 ? "ão" : "ões"}</span>
            {s.lastStatus && <>
              <span>Linhas: {s.lastRowsFound}</span>
              <span style={{ color: s.lastIssuesCount > 0 ? "var(--color-warning)" : "var(--color-success)" }}>
                {s.lastIssuesCount > 0 ? `⚠ ${s.lastIssuesCount} probl.` : "✓ Sem probl."}
              </span>
            </>}
            {s.pendingStaging > 0 && (
              <span
                style={{ gridColumn: "1 / -1", color: "var(--color-warning)", cursor: "pointer", textDecoration: "underline dotted" }}
                onClick={onPending}
              >
                {s.pendingStaging} preview(s) pendente(s) — retomar
              </span>
            )}
          </>
        )}
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
// Legado info (read-only, não é card de grid)
// ---------------------------------------------------------------------------

function LegadoBanner({ legado }: { legado: LegadoStatus | null }) {
  if (!legado) return null;
  return (
    <div style={{
      marginTop: 24, padding: "10px 16px", borderRadius: 6,
      border: "1px solid var(--color-border)", background: "var(--color-surface)",
      fontSize: 12, color: "var(--color-text-muted)",
      display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
    }}>
      <StatusDot status={legado.initialized ? "COMPLETED" : null} />
      <span style={{ fontWeight: 500 }}>Legado (inicialização única)</span>
      <span>Pedidos: {legado.ordersFound}</span>
      <span>Estoque legado: {legado.inventoryFound}</span>
      <span>Lote: #{legado.lastBatchId ?? "—"}</span>
      <span>{fmtDate(legado.lastBatchAt)}</span>
      <span style={{ color: legado.initialized ? "var(--color-success)" : "var(--color-warning)" }}>
        {legado.initialized ? "Inicializado" : "Não inicializado"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AdminDados() {
  const [allStatus, setAllStatus]   = useState<AllStatus | null>(null);
  const [legado, setLegado]         = useState<LegadoStatus | null>(null);
  const [loading, setLoading]       = useState(true);
  const [uploadFor, setUploadFor]   = useState<SourceDefinition | null>(null);
  const [historyFor, setHistoryFor] = useState<SourceDefinition | null>(null);
  const [configFor, setConfigFor]   = useState<SourceDefinition | null>(null);
  const [pendingFor, setPendingFor] = useState<SourceDefinition | null>(null);
  const [error, setError]           = useState<string | null>(null);

  function loadStatus() {
    setLoading(true);
    fetch("/api/import-central/status")
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Erro ${r.status}`);
        }
        return r.json() as Promise<{ status: AllStatus; legado: LegadoStatus }>;
      })
      .then(d => {
        setAllStatus(d.status ?? null);
        setLegado(d.legado ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Erro desconhecido.";
        setError(`Não foi possível carregar o status das fontes: ${msg}`);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadStatus(); }, []);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Central de Dados</h1>
          <p className="page-subtitle">Sete fontes sistêmicas — preview → confirmar → auditável</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadStatus} disabled={loading} title="Atualizar status">
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      {/* Banner de erro com botão de retry — sempre visível quando a API falha */}
      {error && (
        <div className="info-banner" style={{ borderColor: "var(--color-danger)", marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <XCircle size={14} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-secondary btn-sm" onClick={loadStatus} disabled={loading}>
            {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            Tentar novamente
          </button>
        </div>
      )}

      {/* Spinner apenas na primeira carga, antes de qualquer dado */}
      {loading && !allStatus && !error && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-muted)", padding: "24px 0" }}>
          <Loader2 size={16} className="spin" /> Carregando status…
        </div>
      )}

      {/* Resumo numérico — só quando temos dados */}
      {allStatus && (
        <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { label: "Fontes importadas", value: Object.values(allStatus).filter(s => s.lastStatus === "COMPLETED").length },
            { label: "Nunca importadas",  value: Object.values(allStatus).filter(s => !s.lastStatus).length },
            { label: "Total importações", value: Object.values(allStatus).reduce((a, s) => a + s.totalImports, 0) },
            { label: "Previews pendentes",value: Object.values(allStatus).reduce((a, s) => a + s.pendingStaging, 0) },
          ].map(stat => (
            <div key={stat.label} style={{ padding: "10px 16px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{stat.label}</div>
              <div style={{ fontWeight: 600, fontSize: 20 }}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Os 7 cards — SEMPRE renderizados a partir do array estático SOURCES.
          status=null quando API falhou ou ainda está carregando. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {SOURCES.map(def => (
          <SourceCard
            key={def.key}
            def={def}
            status={allStatus?.[def.key] ?? null}
            onUpload={() => setUploadFor(def)}
            onHistory={() => setHistoryFor(def)}
            onConfig={() => setConfigFor(def)}
            onPending={() => setPendingFor(def)}
          />
        ))}
      </div>

      <LegadoBanner legado={legado} />

      <div style={{ marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--color-text-muted)" }}>
        {(["Snapshot", "Eventos", "Catálogo"] as const).map(t => (
          <span key={t} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: SOURCE_TYPE_COLORS[t] }} />
            {t}
          </span>
        ))}
      </div>

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
      {configFor && (
        <ConfigModal def={configFor} onClose={() => setConfigFor(null)} />
      )}
      {pendingFor && (
        <PendingDrawer
          source={pendingFor.key}
          label={pendingFor.label}
          onClose={() => setPendingFor(null)}
          onConfirmed={() => { setPendingFor(null); loadStatus(); }}
        />
      )}
    </div>
  );
}
