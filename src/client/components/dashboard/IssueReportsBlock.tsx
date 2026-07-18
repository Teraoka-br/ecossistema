import { useState } from "react";
import type { IssueSummary, IssueReport } from "./types.js";
import { IssueModal } from "./IssueModal.js";

const SEV_LABEL: Record<string, string> = {
  LOW: "Baixa", MEDIUM: "Media", HIGH: "Alta", CRITICAL: "Critica",
};
const SEV_CLASS: Record<string, string> = {
  LOW: "badge-muted", MEDIUM: "badge-info", HIGH: "badge-warn", CRITICAL: "badge-err",
};
const STATUS_LABEL: Record<string, string> = {
  OPEN: "Aberto", IN_ANALYSIS: "Em analise", RESOLVED: "Resolvido", DISMISSED: "Descartado",
};

function IssueRow({ issue }: { issue: IssueReport }) {
  return (
    <tr>
      <td style={{ maxWidth: 220 }}>
        <div style={{ fontWeight: 500, fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</div>
        <div className="muted" style={{ fontSize: "0.75rem" }}>{issue.module}</div>
      </td>
      <td>
        <span className={`badge ${SEV_CLASS[issue.severity] ?? "badge-muted"}`} style={{ fontSize: "0.72rem" }}>
          {SEV_LABEL[issue.severity] ?? issue.severity}
        </span>
      </td>
      <td className="muted" style={{ fontSize: "0.78rem" }}>{STATUS_LABEL[issue.status] ?? issue.status}</td>
      <td className="muted" style={{ fontSize: "0.78rem" }}>{issue.created_at.slice(0, 10)}</td>
    </tr>
  );
}

interface Props {
  issues: IssueSummary;
  onRefresh: () => void;
}

export function IssueReportsBlock({ issues, onRefresh }: Props) {
  const [showModal, setShowModal] = useState(false);

  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
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
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>
          + Novo problema
        </button>
      </div>

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
              {issues.recent.map((i) => <IssueRow key={i.id} issue={i} />)}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <IssueModal
          onClose={() => setShowModal(false)}
          onCreated={onRefresh}
        />
      )}
    </div>
  );
}
