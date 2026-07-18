import { useState } from "react";

const MODULES = [
  { value: "DASHBOARD", label: "Dashboard" },
  { value: "FILA_REPAROS", label: "Fila de reparos" },
  { value: "ANALISE", label: "Analise" },
  { value: "ESTOQUE", label: "Estoque" },
  { value: "REFERENCIAS", label: "Referencias" },
  { value: "PEDIDOS", label: "Pedidos" },
  { value: "CONTAGEM", label: "Contagem" },
  { value: "MATCH_RULES", label: "Regras de match" },
  { value: "USUARIOS", label: "Usuarios" },
  { value: "OUTRO", label: "Outro" },
];

const SEVERITIES = [
  { value: "LOW", label: "Baixa" },
  { value: "MEDIUM", label: "Media" },
  { value: "HIGH", label: "Alta" },
  { value: "CRITICAL", label: "Critica" },
];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function IssueModal({ onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [module, setModule] = useState("OUTRO");
  const [severity, setSeverity] = useState("MEDIUM");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) { setError("Titulo obrigatorio."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined, module, severity }),
      });
      if (!r.ok) { const j = await r.json() as { error?: string }; throw new Error(j.error ?? `Erro ${r.status}`); }
      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 480, margin: 0, padding: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem" }}>
          <h2 style={{ margin: 0 }}>Novo problema</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {error && <div className="alert alert-err" style={{ marginBottom: "0.75rem" }}>{error}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div>
            <label className="label" style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.82rem" }}>
              Titulo *
            </label>
            <input
              className="input"
              style={{ width: "100%" }}
              placeholder="Descreva o problema brevemente"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>

          <div>
            <label className="label" style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.82rem" }}>
              Descricao
            </label>
            <textarea
              className="input"
              style={{ width: "100%", minHeight: 80, resize: "vertical" }}
              placeholder="Detalhes adicionais (opcional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label className="label" style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.82rem" }}>Modulo</label>
              <select className="input" style={{ width: "100%" }} value={module} onChange={(e) => setModule(e.target.value)}>
                {MODULES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.82rem" }}>Gravidade</label>
              <select className="input" style={{ width: "100%" }} value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancelar</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "Enviando…" : "Registrar"}
          </button>
        </div>
      </div>
    </div>
  );
}
