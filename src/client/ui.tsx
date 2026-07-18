import { useState } from "react";
import type { IssueSeverity } from "../shared/types.js";

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("pt-BR").format(n);
}

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

export function SeverityBadge({ severity }: { severity: IssueSeverity }) {
  const cls = severity === "ERROR" ? "err" : severity === "WARNING" ? "warn" : "conflict";
  const label = severity === "ERROR" ? "ERRO" : severity === "WARNING" ? "AVISO" : "CONFLITO";
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function StatusBadge({ label }: { label: string | null }) {
  if (!label) return <span className="muted">—</span>;
  const up = label.toUpperCase();
  let cls = "neutral";
  if (up.includes("CONCLU") || up === "MATCH" || up.includes("SEPARADO")) cls = "ok";
  else if (up.includes("PARCIAL") || up.includes("VERIFICAR")) cls = "warn";
  else if (up.includes("PEDIR") || up.includes("SEM SALDO") || up.includes("CANCEL")) cls = "err";
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Loading({ what }: { what?: string }) {
  return <p className="spinner">Carregando{what ? ` ${what}` : ""}…</p>;
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="banner err">⚠ {message}</div>;
}

/** Barra de alerta dismissível — substitui os pares msg/error + botão × espalhados pelas páginas. */
export function AlertBar({ ok, err, onDismiss }: { ok?: string | null; err?: string | null; onDismiss?: () => void }) {
  if (!ok && !err) return null;
  const cls = ok ? "alert-ok" : "alert-err";
  const text = ok ?? err;
  return (
    <div className={`alert ${cls}`} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <span style={{ flex: 1 }}>{text}</span>
      {onDismiss && (
        <button className="btn btn-ghost btn-sm" style={{ padding: "0 6px", lineHeight: 1 }} onClick={onDismiss}>×</button>
      )}
    </div>
  );
}

/** Hook auxiliar para pares msg/error com auto-dismiss opcional. */
export function useAlert(autoDismissMs = 0) {
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function success(msg: string) {
    setOk(msg); setErr(null);
    if (autoDismissMs > 0) setTimeout(() => setOk(null), autoDismissMs);
  }
  function error(msg: string) { setErr(msg); setOk(null); }
  function clear() { setOk(null); setErr(null); }

  return { ok, err, success, error, clear };
}

/** Cabeçalho de página padronizado — título à esquerda, ações à direita. */
export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted" style={{ fontSize: "0.85rem", margin: "0.15rem 0 0" }}>{subtitle}</p>}
      </div>
      {children && <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>{children}</div>}
    </div>
  );
}

export function NoBatchBanner() {
  return (
    <div className="banner info">
      Nenhuma importação concluída ainda. Vá em <strong>Importar</strong> e carregue
      os arquivos <span className="mono">PEDIDOS.xlsx</span> e{" "}
      <span className="mono">ANALISE MI.xlsx</span> para começar de onde as planilhas pararam.
    </div>
  );
}
