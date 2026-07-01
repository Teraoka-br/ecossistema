import { useCallback, useEffect, useRef, useState } from "react";
import type { CountSession, FinalizeSummary, PendingReferenceGroup, StockSnapshot } from "../../shared/types.js";
import {
  cancelCountSession,
  cancelPendingScans,
  cancelScan,
  createCountSession,
  getActiveSession,
  getDiagnostico,
  getLatestSnapshot,
  getSessionCatalogKeys,
  getSessionState,
  getSummary,
  finalizeSession,
  registerScan,
  resolveReference,
  type SessionState,
} from "../api.js";
import { ErrorBanner, Loading, fmtInt } from "../ui.js";

export function Bipagem() {
  const [session, setSession] = useState<CountSession | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSession(await getActiveSession());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (session === undefined) return <Loading what="bipagem" />;

  return (
    <div>
      <h1>Bipagem de estoque</h1>
      <p className="subtitle">
        Contagem física diária: cada beep registra uma unidade. Beeps repetidos são intencionais.
      </p>
      {error && <ErrorBanner message={error} />}
      {!session && <NoSessionView onStarted={refresh} />}
      {session && <ActiveSessionView session={session} onChanged={refresh} />}
    </div>
  );
}

function NoSessionView({ onStarted }: { onStarted: () => void }) {
  const [responsibleName, setResponsibleName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchInfo, setBatchInfo] = useState<{ id: number; ordersFileName: string; analysisFileName: string } | null>(null);
  const [latestSnapshot, setLatestSnapshot] = useState<StockSnapshot | null>(null);

  useEffect(() => {
    void getDiagnostico().then((d) => {
      if (d.batch) setBatchInfo({ id: d.batch.id, ordersFileName: d.batch.ordersFileName, analysisFileName: d.batch.analysisFileName });
    });
    void getLatestSnapshot().then(setLatestSnapshot);
  }, []);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      await createCountSession(responsibleName);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Nenhuma sessão de contagem aberta</h2>

      {error && <ErrorBanner message={error} />}

      {!batchInfo && (
        <div className="banner warn">
          Nenhum lote de importação concluído disponível. Importe os arquivos em
          <strong> Importar</strong> antes de iniciar a contagem.
        </div>
      )}
      {batchInfo && (
        <p className="hint">
          Lote que será usado como catálogo: <strong>#{batchInfo.id}</strong> ({batchInfo.ordersFileName} +{" "}
          {batchInfo.analysisFileName}).
        </p>
      )}
      {latestSnapshot && (
        <p className="hint">
          Último snapshot oficial: #{latestSnapshot.id}, {fmtInt(latestSnapshot.totalUnits)} unidades, criado em{" "}
          {latestSnapshot.createdAt} por {latestSnapshot.createdBy ?? "—"}.
        </p>
      )}

      <div className="row" style={{ marginTop: "1rem" }}>
        <div className="field">
          <label>Responsável pela contagem</label>
          <input
            type="text"
            value={responsibleName}
            onChange={(e) => setResponsibleName(e.target.value)}
            placeholder="ex.: João"
            autoFocus
          />
        </div>
        <button onClick={start} disabled={busy || !batchInfo || responsibleName.trim() === ""}>
          {busy ? "Iniciando…" : "Iniciar contagem"}
        </button>
      </div>
    </div>
  );
}

function ActiveSessionView({ session, onChanged }: { session: CountSession; onChanged: () => void }) {
  const [reference, setReference] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<{ reference: string; total: number; status: string } | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // O backend é a autoridade: todo total/consolidação/pendência vem do /state.
  // Recarregamos o estado consolidado depois de cada mutação (beep, cancelamento,
  // resolução, cancelamento em massa) — nada é reconstruído só no estado React.
  const reloadState = useCallback(async () => {
    try {
      setState(await getSessionState(session.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session.id]);

  useEffect(() => {
    void reloadState();
    inputRef.current?.focus();
  }, [reloadState]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return; // impede 2º envio causado pelo mesmo Enter
    const ref = reference.trim();
    if (ref === "") return;
    setSending(true);
    setError(null);
    try {
      const result = await registerScan(session.id, ref);
      setLastScan({ reference: ref, total: result.totalForReference, status: result.scan.mappingStatus });
      await reloadState();
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setReference("");
      setSending(false);
      // devolve o foco imediatamente — não impede beeps repetidos após a resposta.
      inputRef.current?.focus();
    }
  }

  async function onCancelScan(scanId: number) {
    const cancelReason = window.prompt("Motivo do cancelamento deste beep:");
    if (!cancelReason || cancelReason.trim() === "") return;
    try {
      await cancelScan(scanId, session.responsibleName, cancelReason.trim());
      await reloadState();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onCancelSession() {
    const cancelReason = window.prompt("Motivo do cancelamento da sessão:");
    if (!cancelReason || cancelReason.trim() === "") return;
    try {
      await cancelCountSession(session.id, session.responsibleName, cancelReason.trim());
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const summary = state?.summary;
  const totalsByReference = state?.totalsByReference ?? [];
  const recent = state?.recentScans ?? [];
  const pending = state?.pending ?? [];

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <div className="card">
        <div className="row" style={{ gap: "1.2rem", alignItems: "baseline" }}>
          <span><strong>Responsável:</strong> {session.responsibleName}</span>
          <span className="muted small"><strong>Início:</strong> {session.startedAt}</span>
          <span className="muted small"><strong>Lote:</strong> #{session.importBatchId}</span>
          <button className="secondary right" onClick={onCancelSession}>Cancelar sessão</button>
        </div>
      </div>

      <div className="card">
        <form onSubmit={onSubmit}>
          <div className="field">
            <label>Referência (bipe ou digite e Enter)</label>
            <input
              ref={inputRef}
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={sending}
              autoFocus
              style={{ fontSize: "1.4rem", padding: "0.7rem" }}
              placeholder="bipe aqui…"
            />
          </div>
        </form>
        {lastScan && (
          <p className="hint">
            Último beep: <strong>{lastScan.reference}</strong> — total desta referência: <strong>{lastScan.total}</strong>
            {" "}<StatusTag status={lastScan.status} />
          </p>
        )}
        <div className="metrics" style={{ marginTop: "0.6rem" }}>
          <div className="metric"><div className="label">Total geral</div><div className="value">{fmtInt(summary?.activeScans ?? 0)}</div></div>
          <div className="metric"><div className="label">Referências distintas</div><div className="value">{fmtInt(summary?.distinctReferences ?? 0)}</div></div>
          <div className="metric"><div className="label">Cancelados</div><div className="value">{fmtInt(summary?.cancelledScans ?? 0)}</div></div>
          <div className="metric"><div className="label">Pendências</div><div className="value">{fmtInt(pending.length)}</div></div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card">
          <h2>Pendências</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Referência</th><th>Motivo</th><th className="num">Qtde</th>
                  <th>Primeiro</th><th>Último</th><th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <PendingRow
                    key={p.referenceNorm}
                    sessionId={session.id}
                    responsibleName={session.responsibleName}
                    pending={p}
                    onResolved={() => { void reloadState(); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Consolidação por referência</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Referência</th><th className="num">Total</th></tr></thead>
            <tbody>
              {totalsByReference.map((t) => (
                <tr key={t.referenceNorm}><td className="mono">{t.reference}</td><td className="num">{fmtInt(t.total)}</td></tr>
              ))}
              {totalsByReference.length === 0 && <tr><td colSpan={2} className="muted">Nenhum beep ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Últimos scans</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Referência</th><th>Status</th><th>Horário</th><th></th></tr></thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id} style={s.cancelledAt ? { opacity: 0.5 } : undefined}>
                  <td className="mono">{s.reference}</td>
                  <td><StatusTag status={s.mappingStatus} /></td>
                  <td className="small">{s.scannedAt}</td>
                  <td>
                    {!s.cancelledAt && (
                      <button className="secondary" onClick={() => onCancelScan(s.id)}>Cancelar</button>
                    )}
                    {s.cancelledAt && <span className="muted small">cancelado</span>}
                  </td>
                </tr>
              ))}
              {recent.length === 0 && <tr><td colSpan={4} className="muted">Nenhum beep ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row">
        <button onClick={() => setReviewOpen(true)}>Revisar finalização</button>
      </div>

      {reviewOpen && (
        <ReviewFinalize
          session={session}
          onClose={() => setReviewOpen(false)}
          onFinalized={() => {
            setReviewOpen(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  const cls = status === "RECOGNIZED" ? "ok" : status === "CONFLICT" ? "err" : "warn";
  return <span className={`badge ${cls}`}>{status}</span>;
}

function PendingRow({
  sessionId,
  responsibleName,
  pending,
  onResolved,
}: {
  sessionId: number;
  responsibleName: string;
  pending: PendingReferenceGroup;
  onResolved: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link(chavePeca: string) {
    setBusy(true);
    setError(null);
    try {
      await resolveReference(sessionId, pending.referenceNorm, chavePeca, responsibleName);
      setLinking(false);
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelAll() {
    const reason = window.prompt(`Motivo para cancelar os ${pending.activeCount} beep(s) de "${pending.reference}":`);
    if (!reason || reason.trim() === "") return;
    setBusy(true);
    try {
      await cancelPendingScans(sessionId, pending.referenceNorm, responsibleName, reason.trim());
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="mono">{pending.reference}</td>
      <td><span className="badge warn">{pending.mappingStatus}</span>{pending.conflictKeys.length > 0 && <div className="small muted">{pending.conflictKeys.join(" | ")}</div>}</td>
      <td className="num">{pending.activeCount}</td>
      <td className="small">{pending.firstScannedAt}</td>
      <td className="small">{pending.lastScannedAt}</td>
      <td>
        {error && <div className="small" style={{ color: "var(--err)" }}>{error}</div>}
        {!linking && (
          <div className="row" style={{ gap: "0.3rem" }}>
            <button onClick={() => setLinking(true)} disabled={busy}>Vincular CHAVEPECA</button>
            <button className="secondary" onClick={cancelAll} disabled={busy}>Cancelar beeps</button>
          </div>
        )}
        {linking && (
          <KeyAutocomplete
            sessionId={sessionId}
            disabled={busy}
            onSelect={(k) => void link(k)}
            onCancel={() => setLinking(false)}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * Autocomplete de CHAVEPECA: busca no backend (catálogo da SESSÃO) e só
 * permite confirmar uma chave selecionada da lista — nunca texto livre. O
 * backend revalida a chave de qualquer forma.
 */
function KeyAutocomplete({
  sessionId,
  disabled,
  onSelect,
  onCancel,
}: {
  sessionId: number;
  disabled: boolean;
  onSelect: (chavePeca: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<{ chavePeca: string; referencia: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void getSessionCatalogKeys(sessionId, query.trim() || undefined)
        .then((keys) => { if (!cancelled) setOptions(keys); })
        .catch(() => { if (!cancelled) setOptions([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [sessionId, query]);

  return (
    <div className="field" style={{ minWidth: 280 }}>
      <input
        type="search"
        autoFocus
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
        placeholder="buscar CHAVEPECA do catálogo…"
      />
      <div className="table-wrap" style={{ maxHeight: 160, marginTop: "0.3rem" }}>
        <table>
          <tbody>
            {options.map((o) => (
              <tr
                key={o.chavePeca}
                onClick={() => setSelected(o.chavePeca)}
                style={{ cursor: "pointer", background: selected === o.chavePeca ? "var(--accent-soft, #e0e7ff)" : undefined }}
              >
                <td className="small"><strong>{o.chavePeca}</strong></td>
                <td className="small muted">{o.referencia}</td>
              </tr>
            ))}
            {options.length === 0 && <tr><td className="muted small">Nenhuma chave encontrada.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ gap: "0.3rem", marginTop: "0.3rem" }}>
        <button onClick={() => selected && onSelect(selected)} disabled={disabled || !selected}>
          Confirmar {selected ? `"${selected}"` : ""}
        </button>
        <button className="secondary" onClick={onCancel} disabled={disabled}>Cancelar</button>
      </div>
    </div>
  );
}

function ReviewFinalize({
  session,
  onClose,
  onFinalized,
}: {
  session: CountSession;
  onClose: () => void;
  onFinalized: () => void;
}) {
  const [summary, setSummary] = useState<FinalizeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceReason, setForceReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSummary(session.id).then(setSummary).catch((e) => setError((e as Error).message));
  }, [session.id]);

  const belowThreshold = summary?.warnings.includes("COUNT_BELOW_BASELINE_THRESHOLD") ?? false;
  const onlyThresholdBlocks =
    belowThreshold && summary && summary.blockers.every((b) => b.startsWith("COUNT_BELOW_BASELINE_THRESHOLD"));

  async function doFinalize(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      await finalizeSession(session.id, {
        finalizedBy: session.responsibleName,
        forceIncomplete: force,
        forceReason: force ? forceReason.trim() : undefined,
      });
      onFinalized();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ border: "2px solid var(--accent)" }}>
      <h2>Revisão de finalização</h2>
      {error && <ErrorBanner message={error} />}
      {!summary && <Loading what="resumo" />}
      {summary && (
        <>
          <div className="metrics">
            <div className="metric"><div className="label">Beeps ativos</div><div className="value">{fmtInt(summary.activeScans)}</div></div>
            <div className="metric"><div className="label">Beeps cancelados</div><div className="value">{fmtInt(summary.cancelledScans)}</div></div>
            <div className="metric"><div className="label">Reconhecidas</div><div className="value">{fmtInt(summary.recognizedUnits)}</div></div>
            <div className="metric"><div className="label">Desconhecidas</div><div className="value">{fmtInt(summary.unknownUnits)}</div></div>
            <div className="metric"><div className="label">Sem chave</div><div className="value">{fmtInt(summary.missingKeyUnits)}</div></div>
            <div className="metric"><div className="label">Conflito</div><div className="value">{fmtInt(summary.conflictUnits)}</div></div>
            <div className="metric"><div className="label">Legado do lote</div><div className="value">{fmtInt(summary.legacyTotalUnits)}</div></div>
            <div className="metric"><div className="label">Diferença</div><div className="value">{summary.totalDifference > 0 ? "+" : ""}{fmtInt(summary.totalDifference)}</div></div>
          </div>

          {summary.blockers.length > 0 && (
            <div className="banner err">
              <strong>Bloqueadores:</strong>
              <ul>{summary.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
          {summary.warnings.length > 0 && (
            <div className="banner warn">
              <strong>Avisos:</strong> {summary.warnings.join(", ")}
            </div>
          )}

          {summary.differencesByReference.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 260 }}>
              <table>
                <thead><tr><th>Referência</th><th className="num">Contado</th><th className="num">Legado</th><th className="num">Dif.</th></tr></thead>
                <tbody>
                  {summary.differencesByReference.slice(0, 100).map((d) => (
                    <tr key={d.referenceNorm}>
                      <td className="mono">{d.reference}</td>
                      <td className="num">{fmtInt(d.countedQuantity)}</td>
                      <td className="num">{fmtInt(d.legacyQuantity)}</td>
                      <td className="num">{d.difference > 0 ? "+" : ""}{fmtInt(d.difference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row" style={{ marginTop: "1rem" }}>
            {summary.canFinalize && (
              <button onClick={() => doFinalize(false)} disabled={busy}>
                {busy ? "Finalizando…" : "Confirmar finalização"}
              </button>
            )}
            <button className="secondary" onClick={onClose} disabled={busy}>Fechar</button>
          </div>

          {!summary.canFinalize && onlyThresholdBlocks && (
            <div className="card" style={{ marginTop: "0.8rem" }}>
              <p className="hint">
                Contagem abaixo do limite mínimo. Finalize mesmo assim informando uma justificativa
                (mínimo 10 caracteres).
              </p>
              <div className="field">
                <label>Justificativa</label>
                <input type="text" value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
              </div>
              <button onClick={() => doFinalize(true)} disabled={busy || forceReason.trim().length < 10}>
                Forçar finalização incompleta
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
