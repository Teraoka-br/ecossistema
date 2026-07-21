import { useState } from "react";
import type { IssueSummary, IssueReport } from "./types.js";
import { IssueModal } from "./IssueModal.js";
import { IssueDetailModal } from "./IssueDetailModal.js";

const SEV_LABEL: Record<string, string> = {
  LOW: "Baixa", MEDIUM: "Media", HIGH: "Alta", CRITICAL: "Critica",
};
const SEV_CLASS: Record<string, string> = {
  LOW: "badge-muted", MEDIUM: "badge-info", HIGH: "badge-warn", CRITICAL: "badge-err",
};
const STATUS_LABEL: Record<string, string> = {
  OPEN: "Aberto", IN_ANALYSIS: "Em analise", AWAITING_TEST: "Aguard. validacao",
  RESOLVED: "Resolvido", DISMISSED: "Descartado",
};

interface RowProps {
  issue: IssueReport;
  dimmed?: boolean;
  onOpen: (i: IssueReport) => void;
}

function IssueRow({ issue, dimmed, onOpen }: RowProps) {
  return (
    <tr
      style={{ opacity: dimmed ? 0.55 : 1, cursor: "pointer" }}
      onClick={() => onOpen(issue)}
    >
      <td style={{ maxWidth: 220 }}>
        <div style={{ fontWeight: 500, fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</div>
        <div className="muted" style={{ fontSize: "0.72rem" }}>{issue.module}{issue.created_by_name ? ` · ${issue.created_by_name}` : ""}</div>
      </td>
      <td>
        <span className={`badge ${SEV_CLASS[issue.severity] ?? "badge-muted"}`} style={{ fontSize: "0.72rem" }}>
          {SEV_LABEL[issue.severity] ?? issue.severity}
        </span>
      </td>
      <td className="muted" style={{ fontSize: "0.78rem" }}>{STATUS_LABEL[issue.status] ?? issue.status}</td>
      <td className="muted" style={{ fontSize: "0.78rem" }}>
        {dimmed && issue.resolved_at ? issue.resolved_at.slice(0, 10) : issue.created_at.slice(0, 10)}
      </td>
    </tr>
  );
}

interface Props {
  issues: IssueSummary;
  isAdmin?: boolean;
  onRefresh: () => void;
}

export function IssueReportsBlock({ issues, isAdmin = false, onRefresh }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [detail, setDetail] = useState<IssueReport | null>(null);

  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Problemas reportados</h2>
          {issues.openCount > 0 && (
            <span className="badge badge-warn" style={{ fontSize: "0.75rem" }}>
              {issues.openCount} aberto{issues.openCount > 1 ? "s" : ""}
            </span>
          )}
          {issues.criticalCount > 0 && (
            <span className="badge badge-err" style={{ fontSize: "0.75rem" }}>
              {issues.criticalCount} critico{issues.criticalCount > 1 ? "s" : ""}
            </span>
          )}
          {issues.awaitingTestCount > 0 && (
            <span className="badge badge-info" style={{ fontSize: "0.75rem" }}>
              {issues.awaitingTestCount} aguard. validacao
            </span>
          )}
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>
          + Novo problema
        </button>
      </div>

      {/* Em aberto / em analise */}
      {issues.recent.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Nenhum problema em aberto.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Titulo</th>
                <th>Gravidade</th>
                <th>Status</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {issues.recent.map((i) => <IssueRow key={i.id} issue={i} onOpen={setDetail} />)}
            </tbody>
          </table>
        </div>
      )}

      {/* Aguardando validacao em producao */}
      {issues.awaitingTest.length > 0 && (
        <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "0.5rem" }}>
          <div className="muted" style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.4rem" }}>
            Aguardando validacao em producao
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Titulo</th>
                  <th>Gravidade</th>
                  <th>Status</th>
                  <th>Atualizado</th>
                </tr>
              </thead>
              <tbody>
                {issues.awaitingTest.map((i) => <IssueRow key={i.id} issue={i} onOpen={setDetail} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Resolvidos */}
      {issues.resolved.length > 0 && (
        <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "0.5rem" }}>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "0.78rem", marginBottom: showResolved ? "0.5rem" : 0 }}
            onClick={() => setShowResolved(v => !v)}
          >
            {showResolved ? "▲" : "▼"} {issues.resolved.length} resolvido{issues.resolved.length !== 1 ? "s" : ""}
          </button>
          {showResolved && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Titulo</th>
                    <th>Gravidade</th>
                    <th>Status</th>
                    <th>Resolvido em</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.resolved.map((i) => <IssueRow key={i.id} issue={i} dimmed onOpen={setDetail} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showModal && (
        <IssueModal
          onClose={() => setShowModal(false)}
          onCreated={onRefresh}
        />
      )}

      {detail && (
        <IssueDetailModal
          issue={detail}
          isAdmin={isAdmin}
          onClose={() => setDetail(null)}
          onUpdated={() => { setDetail(null); onRefresh(); }}
        />
      )}
    </div>
  );
}
