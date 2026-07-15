import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Pencil, X, MapPin } from "lucide-react";
import type { DiagnosticReport } from "../../shared/types.js";
import { getDiagnostico } from "../api.js";
import { ErrorBanner, Loading, NoBatchBanner, SeverityBadge, fmtInt } from "../ui.js";

// ─── Score gaps types ─────────────────────────────────────────────────────────

interface ScoreGapCase {
  id: number;
  imei: string | null;
  brand: string | null;
  model: string | null;
  color: string | null;
  os: string | null;
  workflowStatus: string;
  ageDays: number | null;
  cost: number | null;
  estimatedSale: number | null;
  margin: number | null;
  openParts: number;
  depositoAtual: string | null;
}

interface ScoreGapResponse {
  total: number;
  cases: ScoreGapCase[];
}

// ─── Inline score editor ──────────────────────────────────────────────────────

interface EditState {
  ageDays: string;
  cost: string;
  estimatedSale: string;
  margin: string;
}

function toVal(s: string): number | null {
  const t = s.trim().replace(",", ".");
  return t === "" ? null : parseFloat(t);
}

function ScoreGapRow({
  c,
  onSaved,
  depositoMap,
}: {
  c: ScoreGapCase;
  onSaved: (updated: Partial<ScoreGapCase>) => void;
  depositoMap: Record<string, string>;
}) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function startEdit() {
    setEdit({
      ageDays: c.ageDays != null ? String(c.ageDays) : "",
      cost: c.cost != null ? String(c.cost) : "",
      estimatedSale: c.estimatedSale != null ? String(c.estimatedSale) : "",
      margin: c.margin != null ? String(c.margin) : "",
    });
    setMsg(null);
  }

  async function save() {
    if (!edit) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/fila-reparos/${c.id}/score`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ageDays: toVal(edit.ageDays),
          cost: toVal(edit.cost),
          estimatedSale: toVal(edit.estimatedSale),
          margin: toVal(edit.margin),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Erro");
      const updated = await r.json() as { ageDays: number | null; cost: number | null; estimatedSale: number | null; margin: number | null };
      setEdit(null);
      onSaved(updated);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  const missingAge = c.ageDays == null;
  const missingMargin = c.margin == null;
  const responsavel = c.depositoAtual
    ? (depositoMap[c.depositoAtual] ?? c.depositoAtual)
    : null;

  return (
    <tr>
      <td>
        <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{c.os ?? "—"}</span>
        <br />
        <span style={{ fontWeight: 500 }}>{c.brand} {c.model}</span>
        {c.color && <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}> · {c.color}</span>}
        <br />
        <span className="mono" style={{ fontSize: "0.73rem" }}>{c.imei ?? "—"}</span>
      </td>
      <td>
        <span style={{
          fontSize: "0.73rem", padding: "2px 6px", borderRadius: 4,
          background: "var(--surface-alt)", color: "var(--text-muted)",
        }}>
          {c.workflowStatus.replace(/_/g, " ")}
        </span>
      </td>
      <td className="num">{c.openParts}</td>
      <td>
        {responsavel ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", color: "var(--accent)" }}>
            <MapPin size={11} />{responsavel}
          </span>
        ) : (
          <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            {c.depositoAtual ?? "—"}
          </span>
        )}
      </td>
      <td>
        {missingAge
          ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>—</span>
          : <span>{c.ageDays} dias</span>}
      </td>
      <td>
        {missingMargin
          ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>—</span>
          : <span style={{ color: (c.margin ?? 0) >= 0 ? "var(--success)" : "var(--danger)" }}>
              R$ {c.margin!.toFixed(2)}
            </span>}
      </td>
      <td>
        {edit ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: 260 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem" }}>
              {(["ageDays", "cost", "estimatedSale", "margin"] as const).map(k => (
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <label style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                    {k === "ageDays" ? "Idade (dias)" : k === "cost" ? "Custo" : k === "estimatedSale" ? "Venda est." : "Margem"}
                  </label>
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={edit[k]}
                    onChange={e => setEdit(se => se ? { ...se, [k]: e.target.value } : se)}
                    style={{ fontSize: "0.82rem", padding: "0.25rem 0.4rem" }}
                  />
                </div>
              ))}
            </div>
            {msg && <span style={{ fontSize: "0.75rem", color: "var(--danger)" }}>{msg}</span>}
            <div style={{ display: "flex", gap: "0.35rem" }}>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ fontSize: "0.78rem" }}>
                {saving && <Loader2 size={11} className="spin" />}
                Salvar
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setEdit(null)} disabled={saving} style={{ fontSize: "0.78rem" }}>
                <X size={11} />
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" onClick={startEdit} style={{ fontSize: "0.78rem" }}>
            <Pencil size={11} /> Preencher
          </button>
        )}
      </td>
    </tr>
  );
}

// ─── Score gaps section ───────────────────────────────────────────────────────

function ScoreGaps() {
  const [data, setData] = useState<ScoreGapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [depositoMap, setDepositoMap] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/staff")
      .then(r => r.ok ? r.json() : null)
      .then((d: { depositoMap?: Record<string, string> } | null) => {
        if (d?.depositoMap) setDepositoMap(d.depositoMap);
      })
      .catch(() => {});
  }, []);

  function load() {
    setLoading(true);
    fetch("/api/diagnostico/score-gaps")
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Erro ao carregar")))
      .then((d: ScoreGapResponse) => { setData(d); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : "Erro"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function handleSaved(id: number, updated: Partial<ScoreGapCase>) {
    setData(prev => {
      if (!prev) return prev;
      const cases = prev.cases.map(c => c.id === id ? { ...c, ...updated } : c);
      // Remove da lista se agora tem ambos preenchidos
      const remaining = cases.filter(c => c.ageDays == null || c.margin == null);
      return { total: remaining.length, cases: remaining };
    });
  }

  if (loading) return <Loading what="dados do motor" />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  if (data.total === 0) {
    return (
      <div className="card" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <CheckCircle2 size={20} style={{ color: "var(--success)", flexShrink: 0 }} />
        <div>
          <strong>Tudo certo!</strong>
          <p className="muted" style={{ margin: 0 }}>
            Todos os aparelhos elegíveis têm idade e margem preenchidas — o motor de match pode pontuar corretamente.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card" style={{
        borderLeft: "4px solid var(--warning, #f59e0b)",
        display: "flex", alignItems: "flex-start", gap: "0.75rem",
      }}>
        <AlertTriangle size={20} style={{ color: "var(--warning, #f59e0b)", marginTop: 2, flexShrink: 0 }} />
        <div>
          <strong>{data.total} aparelho{data.total !== 1 ? "s" : ""} sem dados de score</strong>
          <p className="muted" style={{ margin: "0.25rem 0 0" }}>
            Esses casos têm <strong>idade</strong> ou <strong>margem</strong> ausentes.
            O motor de match vai tratá-los com score&nbsp;0 e desempatá-los só por ID de chegada —
            sem garantia de que os melhores aparelhos recebam as peças.
            Preencha manualmente abaixo.
          </p>
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0 }}>Aparelhos sem pontuação ({data.total})</h2>
          <button className="btn btn-secondary btn-sm" onClick={load}>Atualizar</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Aparelho / IMEI</th>
                <th>Status</th>
                <th className="num">Peças abertas</th>
                <th>Localização</th>
                <th>Idade</th>
                <th>Margem</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {data.cases.map(c => (
                <ScoreGapRow
                  key={c.id}
                  c={c}
                  onSaved={updated => handleSaved(c.id, updated)}
                  depositoMap={depositoMap}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type DiagTab = "importacao" | "motor";

export function Diagnostico() {
  const [data, setData] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DiagTab>("motor");
  const [gapCount, setGapCount] = useState<number | null>(null);

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

    fetch("/api/diagnostico/score-gaps")
      .then(r => r.ok ? r.json() : null)
      .then((d: ScoreGapResponse | null) => { if (d) setGapCount(d.total); })
      .catch(() => {});
  }, []);

  return (
    <div>
      <h1>Diagnóstico</h1>

      <div className="tab-bar" style={{ marginBottom: "1.25rem" }}>
        <button
          className={`tab-btn${tab === "motor" ? " active" : ""}`}
          onClick={() => setTab("motor")}
        >
          Motor de Match
          {gapCount != null && gapCount > 0 && (
            <span style={{
              marginLeft: "0.4rem", background: "var(--danger)", color: "#fff",
              borderRadius: 99, fontSize: "0.7rem", padding: "1px 6px", fontWeight: 700,
            }}>
              {gapCount}
            </span>
          )}
        </button>
        <button
          className={`tab-btn${tab === "importacao" ? " active" : ""}`}
          onClick={() => setTab("importacao")}
        >
          Importação
        </button>
      </div>

      {tab === "motor" && <ScoreGaps />}

      {tab === "importacao" && (
        <>
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
