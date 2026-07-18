import { useState, useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Bug, X, Send, ChevronDown } from "lucide-react";

const PATH_TO_MODULE: Record<string, string> = {
  "/fila-reparos": "FILA_REPAROS",
  "/analise":      "ANALISE",
  "/estoque":      "ESTOQUE",
  "/bipagem":      "CONTAGEM",
  "/compras":      "PEDIDOS",
  "/admin/dashboards": "DASHBOARD",
  "/admin/usuarios":   "USUARIOS",
  "/admin/regras-match": "MATCH_RULES",
  "/estoque/referencias": "REFERENCIAS",
};

function pathToModule(pathname: string): string {
  for (const [prefix, mod] of Object.entries(PATH_TO_MODULE)) {
    if (pathname.startsWith(prefix)) return mod;
  }
  return "OUTRO";
}

function pathToLabel(pathname: string): string {
  const map: Record<string, string> = {
    "/fila-reparos":          "Fila de Reparos",
    "/analise":               "Análise de Aparelho",
    "/estoque/referencias":   "Referências de Peças",
    "/estoque":               "Estoque",
    "/bipagem":               "Contagem / Bipagem",
    "/compras":               "Pedidos de Peças",
    "/admin/dashboards":      "Dashboards",
    "/admin/usuarios":        "Pessoas e Usuários",
    "/admin/dados":           "Dados",
    "/admin/regras-match":    "Regras do Match",
    "/diagnostico":           "Diagnóstico",
    "/inicio":                "Início (Técnico)",
    "/minha-fila":            "Minha Fila",
  };
  for (const [prefix, label] of Object.entries(map)) {
    if (pathname.startsWith(prefix)) return label;
  }
  return pathname;
}

type Step = "idle" | "open" | "sent";

export function BugReportWidget() {
  const location = useLocation();
  const [step, setStep]             = useState<Step>("idle");
  const [description, setDescription] = useState("");
  const [sending, setSending]       = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pageLabel  = pathToLabel(location.pathname);
  const module     = pathToModule(location.pathname);

  useEffect(() => {
    if (step === "open") setTimeout(() => textareaRef.current?.focus(), 60);
  }, [step]);

  async function submit() {
    if (!description.trim()) return;
    setSending(true);
    try {
      const meta = JSON.stringify({
        path:       location.pathname,
        search:     location.search,
        pageLabel,
        module,
        reportedAt: new Date().toISOString(),
      });
      await fetch("/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:         `[${pageLabel}] ${description.slice(0, 80)}`,
          description:   description.trim(),
          module,
          severity:      "MEDIUM",
          metadata_json: meta,
        }),
      });
      setStep("sent");
      setDescription("");
    } finally {
      setSending(false);
    }
  }

  function close() {
    setStep("idle");
    setDescription("");
  }

  return (
    <div style={{
      position: "fixed", bottom: "1.25rem", right: "1.25rem",
      zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem",
    }}>
      {/* Painel de chat */}
      {step !== "idle" && (
        <div style={{
          width: 320, background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
          animation: "bug-slide-up 0.2s ease",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0.75rem 1rem",
            background: "var(--surface-alt)",
            borderBottom: "1px solid var(--border)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
              <Bug size={14} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text)" }}>
                Reportar problema
              </span>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ padding: "2px 4px" }}
              onClick={close}
            ><ChevronDown size={14} /></button>
          </div>

          {/* Body */}
          <div style={{ padding: "0.875rem 1rem" }}>
            {step === "sent" ? (
              <div style={{ textAlign: "center", padding: "1rem 0" }}>
                <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>✓</div>
                <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--ok-text)", marginBottom: "0.4rem" }}>
                  Report recebido!
                </div>
                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Iremos agir nisso o mais rápido possível.
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: "1rem", fontSize: "0.75rem" }}
                  onClick={() => setStep("open")}
                >
                  Reportar outro
                </button>
              </div>
            ) : (
              <>
                <div style={{
                  fontSize: "0.72rem", color: "var(--text-muted)",
                  marginBottom: "0.6rem",
                  display: "flex", alignItems: "center", gap: "0.3rem",
                }}>
                  <span style={{
                    background: "var(--elevated)", borderRadius: "var(--r-sm)",
                    padding: "0.15rem 0.45rem", fontSize: "0.68rem",
                    color: "var(--accent)", fontWeight: 600,
                  }}>
                    {pageLabel}
                  </span>
                  <span>será registrado junto ao report.</span>
                </div>
                <textarea
                  ref={textareaRef}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Descreva o que aconteceu, o que esperava ver e o que viu…"
                  rows={4}
                  style={{
                    width: "100%", resize: "none",
                    background: "var(--elevated)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-sm)",
                    color: "var(--text)", fontSize: "0.82rem",
                    padding: "0.5rem 0.6rem", lineHeight: 1.5,
                    outline: "none", fontFamily: "inherit",
                    transition: "border-color 0.14s",
                  }}
                  onFocus={e => (e.target.style.borderColor = "var(--border-focus)")}
                  onBlur={e => (e.target.style.borderColor = "var(--border)")}
                  onKeyDown={e => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.5rem", gap: "0.4rem" }}>
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: "0.75rem" }} onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ fontSize: "0.75rem", gap: "0.35rem" }}
                    onClick={() => void submit()}
                    disabled={!description.trim() || sending}
                  >
                    <Send size={11} />
                    {sending ? "Enviando…" : "Enviar"}
                  </button>
                </div>
                <div style={{ fontSize: "0.67rem", color: "var(--text-disabled)", marginTop: "0.4rem", textAlign: "right" }}>
                  Ctrl+Enter para enviar
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Botão flutuante */}
      <button
        onClick={() => setStep(s => s === "idle" ? "open" : "idle")}
        title="Reportar um problema"
        style={{
          width: 44, height: 44, borderRadius: "50%",
          background: step !== "idle"
            ? "var(--accent-hover)"
            : "linear-gradient(135deg, var(--accent), #6d28d9)",
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 16px rgba(124,58,237,0.45), 0 2px 6px rgba(0,0,0,0.5)",
          transition: "transform 0.15s, box-shadow 0.15s",
          color: "#fff",
        }}
        onMouseEnter={e => {
          e.currentTarget.style.transform = "scale(1.1)";
          e.currentTarget.style.boxShadow = "0 6px 24px rgba(124,58,237,0.6), 0 2px 8px rgba(0,0,0,0.5)";
        }}
        onMouseLeave={e => {
          e.currentTarget.style.transform = "scale(1)";
          e.currentTarget.style.boxShadow = "0 4px 16px rgba(124,58,237,0.45), 0 2px 6px rgba(0,0,0,0.5)";
        }}
      >
        {step !== "idle" ? <X size={18} /> : <Bug size={18} />}
      </button>
    </div>
  );
}
