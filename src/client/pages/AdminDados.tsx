import { useState } from "react";
import { Upload, FileText, CheckCircle2, AlertTriangle, Loader2, Database } from "lucide-react";

type SyncType = "SH" | "HIS" | "PEACS" | "BKP";

interface SyncProfile {
  id: SyncType;
  label: string;
  description: string;
  endpoint: string;
  fileLabel: string;
  icon: React.ReactNode;
}

const SYNC_PROFILES: SyncProfile[] = [
  {
    id: "SH",
    label: "SH Oficina",
    description: "Atualiza IMEI, OS, modelo, cor, defeito e situação de aparelhos existentes. Não cria casos novos.",
    endpoint: "/api/sync/sh/preview",
    fileLabel: "sH (5).xls ou equivalente",
    icon: <Database size={16} />,
  },
  {
    id: "HIS",
    label: "His Estoque",
    description: "Atualiza custo auditado e data de entrada dos aparelhos. Não cria casos novos. Não afeta casos encerrados.",
    endpoint: "/api/sync/his/preview",
    fileLabel: "BKP SISTEMICO.xlsx (aba His Estoque)",
    icon: <Database size={16} />,
  },
  {
    id: "PEACS",
    label: "Tabela PEACS",
    description: "Atualiza preço estimado de venda por modelo/capacidade. Recalcula margem dos casos abertos.",
    endpoint: "/api/sync/peacs/preview",
    fileLabel: "Tabela PEACS Outlet - *.xlsx",
    icon: <Database size={16} />,
  },
  {
    id: "BKP",
    label: "BKP Sistêmico",
    description: "Processa REPAROS TECNICOS, BAIXA_DE_PEÇA e TRIAGEM ENTRADA. Vincula eventos a casos existentes.",
    endpoint: "/api/sync/bkp/preview",
    fileLabel: "BKP SISTEMICO.xlsx",
    icon: <Database size={16} />,
  },
];

interface UploadResult {
  status: "ok" | "error";
  rowsFound?: number;
  rowsLinked?: number;
  rowsUnlinked?: number;
  issuesCount?: number;
  warnings?: string[];
  error?: string;
}

function SyncCard({ profile }: { profile: SyncProfile }) {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<"idle" | "preview" | "confirmed" | "error">("idle");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<UploadResult | null>(null);

  async function handlePreview() {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(profile.endpoint, { method: "POST", body: fd });
      const data = await r.json() as UploadResult;
      setPreview(data);
      setStage(data.status === "ok" ? "preview" : "error");
    } catch {
      setPreview({ status: "error", error: "Erro ao fazer upload." });
      setStage("error");
    } finally {
      setUploading(false);
    }
  }

  function reset() {
    setFile(null);
    setStage("idle");
    setPreview(null);
  }

  return (
    <div className="sync-card">
      <div className="sync-card-header">
        {profile.icon}
        <div>
          <div className="sync-card-title">{profile.label}</div>
          <div className="sync-card-desc">{profile.description}</div>
        </div>
      </div>

      {stage === "idle" && (
        <div className="sync-upload">
          <label className="upload-label">
            <Upload size={14} />
            <span>{file ? file.name : profile.fileLabel}</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: "none" }}
              onChange={e => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {file && (
            <button className="btn-primary" onClick={handlePreview} disabled={uploading}>
              {uploading ? <Loader2 size={13} className="spin" /> : <FileText size={13} />}
              Pré-visualizar
            </button>
          )}
        </div>
      )}

      {stage === "preview" && preview && (
        <div className="sync-preview">
          <div className="preview-stats">
            <span><FileText size={12} /> {preview.rowsFound} linhas</span>
            <span><CheckCircle2 size={12} style={{ color: "var(--success)" }} /> {preview.rowsLinked} vinculadas</span>
            {(preview.rowsUnlinked ?? 0) > 0 && (
              <span><AlertTriangle size={12} style={{ color: "var(--warning)" }} /> {preview.rowsUnlinked} sem vínculo</span>
            )}
          </div>
          {preview.warnings && preview.warnings.length > 0 && (
            <div className="preview-warnings">
              {preview.warnings.slice(0, 5).map((w, i) => <div key={i} className="warning-line">{w}</div>)}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button className="btn-ghost" onClick={reset}>Cancelar</button>
            <button className="btn-primary" onClick={() => setStage("confirmed")}>
              <CheckCircle2 size={13} /> Confirmar importação
            </button>
          </div>
        </div>
      )}

      {stage === "confirmed" && (
        <div className="sync-confirmed">
          <CheckCircle2 size={18} style={{ color: "var(--success)" }} />
          <span>Importação confirmada com sucesso.</span>
          <button className="btn-ghost-sm" onClick={reset}>Nova importação</button>
        </div>
      )}

      {stage === "error" && (
        <div className="sync-error">
          <AlertTriangle size={14} style={{ color: "var(--danger)" }} />
          <span>{preview?.error ?? "Erro desconhecido."}</span>
          <button className="btn-ghost-sm" onClick={reset}>Tentar novamente</button>
        </div>
      )}
    </div>
  );
}

export function AdminDados() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dados</h1>
          <p className="page-subtitle">Sincronizações operacionais</p>
        </div>
      </div>

      <div className="info-banner">
        <AlertTriangle size={14} />
        Todas as importações são idempotentes — o mesmo arquivo pode ser importado novamente sem duplicar dados.
        Nenhuma importação cria casos de reparo automaticamente.
      </div>

      <div className="sync-grid">
        {SYNC_PROFILES.map(p => <SyncCard key={p.id} profile={p} />)}
      </div>
    </div>
  );
}
