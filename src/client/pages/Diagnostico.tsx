import { useEffect, useState } from "react";
import type { DiagnosticReport } from "../../shared/types.js";
import { getDiagnostico } from "../api.js";
import { ErrorBanner, Loading, NoBatchBanner, SeverityBadge, fmtInt } from "../ui.js";

export function Diagnostico() {
  const [data, setData] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await getDiagnostico());
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <h1>Diagnóstico da importação</h1>
      <p className="subtitle">Último lote importado: arquivos, hashes, contagens e ocorrências.</p>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading what="diagnóstico" />}
      {!loading && data && !data.batch && <NoBatchBanner />}

      {!loading && data?.batch && (
        <>
          <div className="card">
            <h2>Lote #{data.batch.id} — {data.batch.status}</h2>
            <table className="small">
              <tbody>
                <tr><th>Arquivo de pedidos</th><td>{data.batch.ordersFileName}</td></tr>
                <tr><th>Hash (pedidos)</th><td className="mono">{data.batch.ordersFileHash}</td></tr>
                <tr><th>Arquivo de análise</th><td>{data.batch.analysisFileName}</td></tr>
                <tr><th>Hash (análise)</th><td className="mono">{data.batch.analysisFileHash}</td></tr>
                <tr><th>Início</th><td>{data.batch.startedAt}</td></tr>
                <tr><th>Fim</th><td>{data.batch.finishedAt ?? "—"}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Contagens</h2>
            <div className="metrics">
              <Metric label="Pedidos encontrados" value={data.batch.ordersFound} />
              <Metric label="Pedidos importados" value={data.batch.ordersImported} />
              <Metric label="Estoque encontrado" value={data.batch.inventoryFound} />
              <Metric label="Estoque importado" value={data.batch.inventoryImported} />
              <Metric label="Cotações encontradas" value={data.batch.quotationsFound} />
              <Metric label="Cotações importadas" value={data.batch.quotationsImported} />
              <Metric label="Análise encontrada" value={data.batch.analysisFound} />
              <Metric label="Análise importada" value={data.batch.analysisImported} />
              <Metric label="Avisos" value={data.batch.warningsCount} />
              <Metric label="Erros" value={data.batch.errorsCount} />
              <Metric label="Conflitos" value={data.batch.conflictsCount} />
            </div>
          </div>

          <div className="card">
            <h2>Resumo das ocorrências</h2>
            {Object.keys(data.issueSummary).length === 0 ? (
              <p className="muted">Nenhuma ocorrência registrada.</p>
            ) : (
              <table className="small" style={{ maxWidth: 480 }}>
                <thead><tr><th>Tipo</th><th className="num">Qtde</th></tr></thead>
                <tbody>
                  {Object.entries(data.issueSummary).map(([k, v]) => (
                    <tr key={k}><td className="mono">{k}</td><td className="num">{fmtInt(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data.issues.length > 0 && (
            <div className="card">
              <h2>Ocorrências detalhadas ({fmtInt(data.issues.length)})</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Severidade</th>
                      <th>Código</th>
                      <th>Arquivo / aba</th>
                      <th>Linha</th>
                      <th>Chave</th>
                      <th>Mensagem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.issues.slice(0, 1000).map((i, idx) => (
                      <tr key={idx}>
                        <td><SeverityBadge severity={i.severity} /></td>
                        <td className="mono">{i.code}</td>
                        <td className="small">{i.fileName}{i.sheetName ? ` / ${i.sheetName}` : ""}</td>
                        <td className="num">{i.rowNumber ?? "—"}</td>
                        <td className="mono small">{i.entityKey ?? "—"}</td>
                        <td className="small">{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{fmtInt(value)}</div>
    </div>
  );
}
