import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ImportPreview, ImportResult } from "../../shared/types.js";
import { confirmImport, getImportState, previewImport, type SystemState } from "../api.js";
import { ErrorBanner, SeverityBadge } from "../ui.js";

export function Importar() {
  const ordersRef = useRef<HTMLInputElement>(null);
  const analysisRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [systemState, setSystemState] = useState<{ state: SystemState; allowLegacyReimport: boolean } | null>(null);
  const [loadingState, setLoadingState] = useState(true);

  useEffect(() => {
    getImportState()
      .then(setSystemState)
      .catch(() => setSystemState(null))
      .finally(() => setLoadingState(false));
  }, []);

  async function onPreview() {
    setError(null);
    setResult(null);
    setPreview(null);
    const orders = ordersRef.current?.files?.[0];
    const analysis = analysisRef.current?.files?.[0];
    if (!orders || !analysis) {
      setError("Selecione os dois arquivos: PEDIDOS.xlsx e ANALISE MI.xlsx.");
      return;
    }
    setBusy(true);
    try {
      setPreview(await previewImport(orders, analysis));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await confirmImport(preview.previewBatchId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const readOnly = !!systemState?.state.initialized && !systemState.allowLegacyReimport;

  return (
    <div>
      <h1>Importar planilhas</h1>
      <p className="subtitle">
        Carregue os arquivos atuais para o sistema continuar de onde as planilhas pararam.
        Etapa 1: pré-visualização e validação. Etapa 2: confirmação (grava no banco).
      </p>

      {error && <ErrorBanner message={error} />}

      {!loadingState && readOnly && (
        <div className="banner warn">
          <strong>O sistema já foi inicializado.</strong> As alterações operacionais agora são
          realizadas dentro do sistema (pedidos de compra, recebimento, contagem física). Uma
          nova importação Excel não é mais o fluxo normal de trabalho.
          {systemState?.state.initialized_at && (
            <div className="small muted" style={{ marginTop: "0.3rem" }}>
              Inicializado em {systemState.state.initialized_at} (lote #{systemState.state.initial_import_batch_id}).
            </div>
          )}
        </div>
      )}

      {!loadingState && !readOnly && (
        <div className="card">
          <h2>1. Selecionar arquivos</h2>
          <div className="row">
            <div className="field">
              <label>PEDIDOS.xlsx (estado operacional)</label>
              <input ref={ordersRef} type="file" accept=".xlsx" />
            </div>
            <div className="field">
              <label>ANALISE MI.xlsx (origem analítica + cotações)</label>
              <input ref={analysisRef} type="file" accept=".xlsx" />
            </div>
            <button onClick={onPreview} disabled={busy}>
              {busy && !preview ? "Analisando…" : "Pré-visualizar"}
            </button>
          </div>
          <p className="hint">
            Os arquivos originais nunca são alterados. A leitura é feita no servidor; os
            uploads temporários são apagados após a importação. Esta importação serve apenas
            para inicializar o sistema — não haverá uma segunda vez no fluxo normal.
          </p>
        </div>
      )}

      {!readOnly && preview && <PreviewView preview={preview} onConfirm={onConfirm} busy={busy} result={result} />}

      {result && <ResultView result={result} />}
    </div>
  );
}

function PreviewView({
  preview,
  onConfirm,
  busy,
  result,
}: {
  preview: ImportPreview;
  onConfirm: () => void;
  busy: boolean;
  result: ImportResult | null;
}) {
  const FATAL_CODES = new Set([
    "MISSING_ORDERS_TABLE", "MISSING_INVENTORY_TABLE", "MISSING_REQUIRED_COLUMNS",
    "NO_VALID_ORDERS", "NO_VALID_INVENTORY", "REFERENCE_KEY_CONFLICT", "FILE_UNREADABLE",
  ]);
  const errors = preview.issues.filter((i) => i.severity === "ERROR");
  const warnings = preview.issues.filter((i) => i.severity === "WARNING");
  const conflicts = preview.issues.filter((i) => i.severity === "CONFLICT");
  const fatalIssues = preview.issues.filter((i) => FATAL_CODES.has(i.code));

  return (
    <div className="card">
      <h2>2. Pré-visualização</h2>

      {preview.alreadyImported && (
        <div className="banner warn">
          Estes mesmos arquivos já foram importados (lote #{preview.existingBatchId}). Confirmar
          novamente é uma operação segura: não duplica dados.
        </div>
      )}

      {!preview.canConfirm && (
        <div className="banner err">
          <strong>Confirmação bloqueada</strong> — {preview.fatalIssuesCount} ocorrência(s)
          estrutural(is) fatal(is). Corrija os arquivos e refaça a importação:
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
            {fatalIssues.map((i, idx) => (
              <li key={idx}>
                <span className="mono">{i.code}</span> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="metrics" style={{ marginBottom: "1rem" }}>
        <Metric label="Pedidos: encontrados" value={preview.counts.ordersFound} />
        <Metric label="Pedidos: válidos" value={preview.counts.ordersValid} />
        <Metric label="Estoque: encontrado" value={preview.counts.inventoryFound} />
        <Metric label="Estoque: válido" value={preview.counts.inventoryValid} />
        <Metric label="Cotações: encontradas" value={preview.counts.quotationsFound} />
        <Metric label="Cotações: válidas" value={preview.counts.quotationsValid} />
        <Metric label="Análise: encontrada" value={preview.counts.analysisFound} />
        <Metric label="Análise: válida" value={preview.counts.analysisValid} />
        <Metric label="Avisos" value={warnings.length} />
        <Metric label="Erros" value={errors.length} />
        <Metric label="Conflitos" value={conflicts.length} />
      </div>
      <p className="hint">Pré-visualização processada em {preview.durationMs.toLocaleString("pt-BR")} ms.</p>

      {preview.sheets.map((s) => (
        <div key={s.fileName} style={{ marginBottom: "0.75rem" }}>
          <strong>{s.fileName}</strong>{" "}
          <span className="muted small">abas: {s.sheetNames.join(", ")}</span>
          <div className="table-wrap" style={{ marginTop: "0.4rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Papel</th>
                  <th>Aba</th>
                  <th>Linha do cabeçalho</th>
                  <th>Campos casados</th>
                </tr>
              </thead>
              <tbody>
                {s.detected.length === 0 && (
                  <tr><td colSpan={4} className="muted">Nenhuma tabela reconhecida.</td></tr>
                )}
                {s.detected.map((d, i) => (
                  <tr key={i}>
                    <td><span className="badge neutral">{d.role}</span></td>
                    <td>{d.sheetName}</td>
                    <td className="num">{d.headerRow}</td>
                    <td className="small">{d.matchedHeaders.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {preview.issues.length > 0 && <IssuesTable issues={preview.issues} />}

      {!result && (
        <div className="row" style={{ marginTop: "1rem" }}>
          <button onClick={onConfirm} disabled={busy || !preview.canConfirm}>
            {busy ? "Importando…" : "Confirmar importação"}
          </button>
          {!preview.canConfirm && (
            <span className="hint">Corrija as ocorrências fatais para liberar a confirmação.</span>
          )}
          {preview.canConfirm && errors.length > 0 && (
            <span className="hint">
              Linhas com erro não são importadas, mas permanecem listadas no relatório.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ResultView({ result }: { result: ImportResult }) {
  return (
    <div className="card">
      <h2>Importação concluída</h2>
      <div className={`banner ${result.warningsCount > 0 || result.errorsCount > 0 ? "warn" : "ok"}`}>
        {result.alreadyImported
          ? `Arquivos idênticos já importados — reutilizado o lote #${result.batchId} (nada duplicado).`
          : `Lote #${result.batchId} gravado com status ${result.status}.`}
      </div>
      <div className="metrics">
        <Metric label="Pedidos importados" value={result.ordersImported} />
        <Metric label="Estoque (unidades)" value={result.inventoryImported} />
        <Metric label="Cotações" value={result.quotationsImported} />
        <Metric label="Análise" value={result.analysisImported} />
        <Metric label="Avisos" value={result.warningsCount} />
        <Metric label="Erros" value={result.errorsCount} />
        <Metric label="Conflitos" value={result.conflictsCount} />
      </div>
      <p style={{ marginTop: "1rem" }}>
        Próximos passos: <Link to="/pedidos">ver Pedidos</Link> ·{" "}
        <Link to="/estoque">ver Estoque</Link> · <Link to="/diagnostico">ver Diagnóstico</Link>
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{new Intl.NumberFormat("pt-BR").format(value)}</div>
    </div>
  );
}

function IssuesTable({ issues }: { issues: ImportPreview["issues"] }) {
  const shown = issues.slice(0, 300);
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <strong>Ocorrências ({issues.length})</strong>
      {issues.length > shown.length && (
        <span className="muted small"> — exibindo as primeiras {shown.length}</span>
      )}
      <div className="table-wrap" style={{ marginTop: "0.4rem" }}>
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
            {shown.map((i, idx) => (
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
  );
}
