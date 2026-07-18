import type { TechnicianCases } from "./types.js";

function fmt(n: number) { return n.toLocaleString("pt-BR"); }

interface Props {
  technicians: TechnicianCases[];
}

export function TechnicianBlock({ technicians }: Props) {
  return (
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
                <th className="num">Casos</th>
                <th className="num">IMEIs</th>
                <th className="num">Em reparo</th>
                <th>Ultima mov.</th>
              </tr>
            </thead>
            <tbody>
              {technicians.map((t) => (
                <tr key={t.technicianId ?? t.technicianName}>
                  <td style={{ fontWeight: 600 }}>{t.technicianName}</td>
                  <td className="num">{fmt(t.totalCases)}</td>
                  <td className="num">{fmt(t.uniqueImeis)}</td>
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
  );
}
