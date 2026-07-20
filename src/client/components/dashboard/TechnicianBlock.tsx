import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import type { TechnicianCases } from "./types.js";

function fmt(n: number) { return n.toLocaleString("pt-BR"); }
function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

interface CaseRow {
  id: number; imei: string; brand: string|null; model: string|null;
  os_number: string|null; workflow_status: string; repair_date: string|null;
  cost: number|null; estimated_sale: number|null; margin: number|null;
}

const STATUS_LABEL: Record<string, string> = {
  DIRECIONADO_TECNICO: "Direcionado", EM_REPARO: "Em reparo",
  REPARO_EXECUTADO: "Reparo executado", TRIAGEM_FINAL: "Triagem final",
  RETORNO_TECNICO: "Retorno técnico", VERIFICAR: "Verificar",
};

interface Props {
  technicians: TechnicianCases[];
}

export function TechnicianBlock({ technicians }: Props) {
  const [modal, setModal] = useState<{ name: string; id: number } | null>(null);
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function openTech(t: TechnicianCases) {
    if (t.technicianId === null) return;
    setModal({ name: t.technicianName, id: t.technicianId });
    setCases(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/dashboards/technician/${t.technicianId}/cases`);
      if (r.ok) { const d = await r.json() as { cases: CaseRow[] }; setCases(d.cases); }
    } finally { setLoading(false); }
  }

  return (
    <>
      <div className="card" style={{ margin: 0 }}>
        <h2 style={{ margin: 0, marginBottom: "0.75rem" }}>Com os tecnicos</h2>
        {technicians.length === 0 ? (
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Nenhum aparelho atribuido aos tecnicos neste momento.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tecnico</th>
                  <th className="num">Aparelhos</th>
                  <th className="num">Em reparo</th>
                  <th>Ultima mov.</th>
                </tr>
              </thead>
              <tbody>
                {technicians.map((t) => (
                  <tr
                    key={t.technicianId ?? t.technicianName}
                    style={{ cursor: t.technicianId !== null ? "pointer" : undefined }}
                    onClick={() => openTech(t)}
                  >
                    <td style={{ fontWeight: 600, color: "var(--accent)" }}>{t.technicianName}</td>
                    <td className="num">{fmt(t.totalCases)}</td>
                    <td className="num">
                      <span className={t.inRepair > 0 ? "badge badge-ok" : "badge badge-muted"} style={{ fontSize: "0.75rem" }}>
                        {fmt(t.inRepair)}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: "0.8rem" }}>
                      {t.lastMovement ? t.lastMovement.slice(0, 16).replace("T", " ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: "1rem",
          }}
          onClick={() => setModal(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 720, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>Aparelhos — {modal.name}</div>
                {cases && <div style={{ fontSize: "0.78rem", color: "var(--text-2)", marginTop: "0.1rem" }}>{cases.length} aparelho(s) ativo(s)</div>}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setModal(null)}><X size={14} /></button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {loading && (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
                </div>
              )}
              {!loading && cases !== null && cases.length === 0 && (
                <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  Nenhum aparelho ativo com este técnico.
                </div>
              )}
              {!loading && cases !== null && cases.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                  <thead>
                    <tr style={{ background: "var(--surface-alt)" }}>
                      {["IMEI","O.S.","APARELHO","STATUS","DATA","MARGEM"].map(h => (
                        <th key={h} style={{ padding: "0.4rem 0.75rem", textAlign: h === "MARGEM" ? "right" : "left", fontWeight: 600, fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((c, i) => (
                      <tr key={c.id} style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}>
                        <td style={{ padding: "0.45rem 0.75rem", fontFamily: "monospace", fontSize: "0.75rem", color: "var(--text-2)" }}>{c.imei}</td>
                        <td style={{ padding: "0.45rem 0.75rem", fontSize: "0.75rem", color: "var(--text-2)" }}>{c.os_number ?? "—"}</td>
                        <td style={{ padding: "0.45rem 0.75rem" }}>{[c.brand, c.model].filter(Boolean).join(" ") || "—"}</td>
                        <td style={{ padding: "0.45rem 0.75rem" }}>
                          <span style={{ fontSize: "0.72rem", background: "var(--surface-alt)", padding: "0.1rem 0.4rem", borderRadius: 4 }}>
                            {STATUS_LABEL[c.workflow_status] ?? c.workflow_status}
                          </span>
                        </td>
                        <td style={{ padding: "0.45rem 0.75rem", fontSize: "0.78rem", color: "var(--text-2)" }}>{c.repair_date?.slice(0,10) ?? "—"}</td>
                        <td style={{ padding: "0.45rem 0.75rem", textAlign: "right", fontVariantNumeric: "tabular-nums",
                          color: c.margin != null && c.margin >= 0 ? "var(--ok-text)" : c.margin != null ? "var(--err-text)" : "var(--muted)" }}>
                          {fmtMoney(c.margin)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
