import { useState } from "react";
import type { IssueReport } from "./types.js";

const SEV_LABEL: Record<string, string> = {
  LOW: "Baixa", MEDIUM: "Media", HIGH: "Alta", CRITICAL: "Critica",
};
const SEV_CLASS: Record<string, string> = {
  LOW: "badge-muted", MEDIUM: "badge-info", HIGH: "badge-warn", CRITICAL: "badge-err",
};
const STATUS_LABEL: Record<string, string> = {
  OPEN: "Aberto", IN_ANALYSIS: "Em analise", AWAITING_TEST: "Aguardando validacao",
  RESOLVED: "Resolvido", DISMISSED: "Descartado",
};
const MODULE_LABEL: Record<string, string> = {
  DASHBOARD: "Dashboard", FILA_REPAROS: "Fila de reparos", ANALISE: "Analise",
  ESTOQUE: "Estoque", REFERENCIAS: "Referencias", PEDIDOS: "Pedidos",
  CONTAGEM: "Contagem", MATCH_RULES: "Regras de match", USUARIOS: "Usuarios", OUTRO: "Outro",
};

const ADMIN_STATUSES = [
  { value: "OPEN", label: "Aberto" },
  { value: "IN_ANALYSIS", label: "Em analise" },
  { value: "AWAITING_TEST", label: "Aguardando validacao" },
  { value: "RESOLVED", label: "Resolvido" },
  { value: "DISMISSED", label: "Descartado" },
];

interface Props {
  issue: IssueReport;
  isAdmin: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function IssueDetailModal({ issue, isAdmin, onClose, onUpdated }: Props) {
  const [status, setStatus] = useState(issue.status);
  const [notes, setNotes] = useState(issue.resolution_notes ?? "");
  const [fixCommit, setFixCommit] = useState(issue.fix_commit ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isDirty =
    status !== issue.status ||
    notes !== (issue.resolution_notes ?? "") ||
    fixCommit !== (issue.fix_commit ?? "");

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, string> = {};
      if (status !== issue.status) body.status = status;
      if (notes !== (issue.resolution_notes ?? "")) body.resolution_notes = notes;
      if (fixCommit !== (issue.fix_commit ?? "")) body.fix_commit = fixCommit;

      const r = await fetch(`/api/issue-reports/${issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json() as { error?: string };
        throw new Error(j.error ?? `Erro ${r.status}`);
      }
      onUpdated();
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
      setSaving(false);
    }
  }

  function copyContext() {
    const lines: string[] = [
      `# Problema #${issue.id} — ${issue.title}`,
      `Gravidade: ${SEV_LABEL[issue.severity] ?? issue.severity}`,
      `Status: ${STATUS_LABEL[issue.status] ?? issue.status}`,
      `Modulo: ${MODULE_LABEL[issue.module] ?? issue.module}`,
      `Reportado por: ${issue.created_by_name ?? "desconhecido"} em ${issue.created_at.slice(0, 10)}`,
    ];
    if (issue.description) lines.push(`\nDescricao:\n${issue.description}`);
    if (issue.metadata_json) {
      try {
        const meta = JSON.parse(issue.metadata_json) as unknown;
        lines.push(`\nContexto tecnico:\n${JSON.stringify(meta, null, 2)}`);
      } catch {
        lines.push(`\nContexto tecnico:\n${issue.metadata_json}`);
      }
    }
    if (issue.fix_commit) lines.push(`\nCommit da correcao: ${issue.fix_commit}`);
    if (issue.resolution_notes) lines.push(`\nNota de resolucao:\n${issue.resolution_notes}`);

    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const isResolved = issue.status === "RESOLVED" || issue.status === "DISMISSED";

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem",
        overflowY: "auto",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 560, margin: "auto", padding: "1.5rem" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "1rem", gap: "0.5rem" }}>
          <div>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
              <span className={`badge ${SEV_CLASS[issue.severity] ?? "badge-muted"}`} style={{ fontSize: "0.72rem" }}>
                {SEV_LABEL[issue.severity] ?? issue.severity}
              </span>
              <span className="badge badge-muted" style={{ fontSize: "0.72rem" }}>
                {STATUS_LABEL[issue.status] ?? issue.status}
              </span>
              <span className="badge badge-muted" style={{ fontSize: "0.72rem" }}>
                {MODULE_LABEL[issue.module] ?? issue.module}
              </span>
            </div>
            <h2 style={{ margin: 0, fontSize: "1rem", lineHeight: 1.3 }}>{issue.title}</h2>
            <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
              #{issue.id} · {issue.created_by_name ?? "desconhecido"} · {issue.created_at.slice(0, 10)}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onClose}>✕</button>
        </div>

        {/* Descricao */}
        {issue.description && (
          <div style={{ marginBottom: "0.75rem", fontSize: "0.85rem", background: "var(--surface-alt)", borderRadius: "var(--radius)", padding: "0.6rem 0.75rem" }}>
            {issue.description}
          </div>
        )}

        {/* Contexto tecnico */}
        {issue.metadata_json && (() => {
          let parsed: unknown;
          try { parsed = JSON.parse(issue.metadata_json); } catch { parsed = issue.metadata_json; }
          return (
            <div style={{ marginBottom: "0.75rem" }}>
              <div className="muted" style={{ fontSize: "0.72rem", marginBottom: "0.25rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Contexto tecnico</div>
              <pre style={{ margin: 0, fontSize: "0.72rem", overflow: "auto", background: "var(--surface-alt)", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", maxHeight: 160 }}>
                {typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}
              </pre>
            </div>
          );
        })()}

        {/* Fix commit (readonly, se nao for admin) */}
        {issue.fix_commit && !isAdmin && (
          <div style={{ marginBottom: "0.75rem", fontSize: "0.82rem" }}>
            <span className="muted">Commit da correcao: </span>
            <code style={{ fontSize: "0.78rem" }}>{issue.fix_commit}</code>
          </div>
        )}

        {/* Validated by */}
        {issue.validated_at && (
          <div className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            Validado em {issue.validated_at.slice(0, 10)}
          </div>
        )}

        {/* Notas de resolucao (readonly para nao-admin) */}
        {issue.resolution_notes && !isAdmin && (
          <div style={{ marginBottom: "0.75rem", fontSize: "0.82rem", background: "var(--surface-alt)", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)" }}>
            <strong>Resolucao:</strong> {issue.resolution_notes}
          </div>
        )}

        {/* --- Admin actions --- */}
        {isAdmin && (
          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "0.75rem", marginTop: "0.25rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
              <div>
                <label className="label" style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.78rem" }}>Status</label>
                <select className="input" style={{ width: "100%" }} value={status} onChange={(e) => setStatus(e.target.value as IssueReport["status"])}>
                  {ADMIN_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label" style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.78rem" }}>Commit da correcao</label>
                <input
                  className="input"
                  style={{ width: "100%" }}
                  placeholder="abc1234 ou #55"
                  value={fixCommit}
                  onChange={(e) => setFixCommit(e.target.value)}
                  maxLength={200}
                />
              </div>
            </div>
            <div>
              <label className="label" style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.78rem" }}>Notas de resolucao</label>
              <textarea
                className="input"
                style={{ width: "100%", minHeight: 72, resize: "vertical" }}
                placeholder="Descreva o que foi feito para resolver"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
              />
            </div>
            {saveError && <div className="alert alert-err" style={{ fontSize: "0.82rem" }}>{saveError}</div>}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "space-between", alignItems: "center", marginTop: "1rem", flexWrap: "wrap" }}>
          <button className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem" }} onClick={copyContext}>
            {copied ? "✓ Copiado" : "Copiar contexto tecnico"}
          </button>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {isAdmin && isResolved && (
              <button
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={() => { setStatus("OPEN"); }}
                title="Reabrir este problema"
              >
                Reabrir
              </button>
            )}
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Fechar</button>
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !isDirty}>
                {saving ? "Salvando…" : "Salvar"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
