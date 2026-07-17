import { useState, useEffect, useCallback } from "react";
import { Plus, Check, ChevronDown, ChevronUp, Loader2, AlertTriangle, Play, RefreshCw } from "lucide-react";

interface MatchRuleSet {
  id: number;
  version: number;
  name: string | null;
  marginAmountPerPoint: number;
  ageDaysPerPoint: number;
  ageMaxPoints: number;
  allowNegativeMarginScore: boolean;
  marginWeight: number;
  ageWeight: number;
  active: boolean;
  reason: string | null;
  createdAt: string;
  activatedAt: string | null;
}

interface BackfillResponse {
  backfillResult: {
    casesEligible: number;
    ageDaysUpdated: number;
    costUpdated: number;
    estimatedSaleUpdated: number;
    marginUpdated: number;
    skipped: number;
  };
  recomputeResult: {
    runId: number;
    casesEvaluated: number;
    fullKitsFound: number;
    partialKitsFound: number;
    casesChanged: number;
    durationMs: number;
  } | null;
}

interface PriorityCoverage {
  totalCompleted: number;
  withAgeDays: number;
  withCost: number;
  withEstimatedSale: number;
  withMargin: number;
  pctAgeDays: number;
  pctMargin: number;
  lowCoverageAlert: boolean;
}

interface SimulateResult {
  ruleId: number;
  ruleVersion: number;
  casesEvaluated: number;
  fullKitsFound: number;
  partialKitsFound: number;
  pedirPecaCount: number;
  aguardandoCount: number;
  verificarCount: number;
  changedComparedToActive: number | null;
  changedFullMatchMembership: number | null;
  changedPartialMembership: number | null;
  enteringMatch: number[];
  leavingMatch: number[];
  positionChanges: number;
  topChangedCases: Array<{
    caseId: number;
    prevStatusActive: string;
    newStatusSimulated: string;
    scoreActive: number | null;
    scoreSimulated: number | null;
  }>;
  disputedKeys: Array<{ stockChaveNorm: string; demanded: number; available: number }>;
}

function fmtScore(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

interface ActivateStats { casesEvaluated: number; casesChanged: number; runId: number | null }

// ---------------------------------------------------------------------------
// Painel de diagnóstico de cobertura
// ---------------------------------------------------------------------------

function CoverageBanner({ coverage, onBackfill }: { coverage: PriorityCoverage; onBackfill: () => void }) {
  const [running, setRunning] = useState(false);
  const [lastBackfill, setLastBackfill] = useState<BackfillResponse | null>(null);

  async function doBackfill() {
    setRunning(true);
    setLastBackfill(null);
    try {
      const r = await fetch("/api/match-rules/backfill-priority", { method: "POST" });
      if (r.ok) setLastBackfill(await r.json() as BackfillResponse);
      onBackfill();
    } finally {
      setRunning(false);
    }
  }

  const bar = (pct: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <div style={{
        flex: 1, height: "6px", background: "var(--surface-2)", borderRadius: "3px", overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: pct >= 80 ? "var(--accent)" : pct >= 50 ? "var(--warn-text)" : "var(--err)",
          borderRadius: "3px", transition: "width 0.4s",
        }} />
      </div>
      <span style={{ fontSize: "0.75rem", fontVariantNumeric: "tabular-nums", minWidth: "2.5rem", textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );

  return (
    <div style={{
      border: `1px solid ${coverage.lowCoverageAlert ? "var(--warn-border, rgba(245,158,11,0.35))" : "var(--border)"}`,
      borderRadius: "var(--r-md)",
      padding: "1rem 1.25rem",
      background: coverage.lowCoverageAlert
        ? "rgba(245,158,11,0.07)"
        : "var(--surface-1)",
      marginBottom: "1.25rem",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", marginBottom: "0.75rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
            {coverage.lowCoverageAlert && <AlertTriangle size={14} style={{ color: "var(--warn-text)" }} />}
            <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
              Cobertura de dados de prioridade — {coverage.totalCompleted} casos analisados
            </span>
          </div>
          {coverage.lowCoverageAlert && (
            <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: 0 }}>
              As regras de match podem não ter efeito porque idade/margem estão ausentes nos casos.
              Execute o backfill para preencher a partir das fontes legadas.
            </p>
          )}
        </div>
        <button
          className="btn-ghost"
          style={{ fontSize: "0.78rem", whiteSpace: "nowrap", flexShrink: 0 }}
          onClick={() => void doBackfill()}
          disabled={running}
        >
          {running ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          Executar backfill
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem 1.5rem" }}>
        {[
          { label: "Idade (age_days)", pct: coverage.pctAgeDays, n: coverage.withAgeDays },
          { label: "Margem", pct: coverage.pctMargin, n: coverage.withMargin },
          { label: "Custo", pct: coverage.totalCompleted > 0 ? Math.round(coverage.withCost / coverage.totalCompleted * 100) : 0, n: coverage.withCost },
          { label: "Venda estimada", pct: coverage.totalCompleted > 0 ? Math.round(coverage.withEstimatedSale / coverage.totalCompleted * 100) : 0, n: coverage.withEstimatedSale },
        ].map(({ label, pct, n }) => (
          <div key={label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              <span>{label}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{n} / {coverage.totalCompleted}</span>
            </div>
            {bar(pct)}
          </div>
        ))}
      </div>

      {lastBackfill && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
          <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.4rem" }}>Resultado do backfill</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.4rem", marginBottom: lastBackfill.recomputeResult ? "0.75rem" : 0 }}>
            {[
              { label: "Idade preenchida", value: lastBackfill.backfillResult.ageDaysUpdated },
              { label: "Margem preenchida", value: lastBackfill.backfillResult.marginUpdated },
              { label: "Casos elegíveis", value: lastBackfill.backfillResult.casesEligible },
            ].map(({ label, value }) => (
              <div key={label} style={{ textAlign: "center", padding: "0.4rem", background: "var(--surface-1)", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                <div style={{ fontSize: "0.68rem", color: "var(--muted)" }}>{label}</div>
              </div>
            ))}
          </div>
          {lastBackfill.recomputeResult && (
            <>
              <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.4rem" }}>Motor executado após backfill</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.4rem" }}>
                {[
                  { label: "Avaliados", value: lastBackfill.recomputeResult.casesEvaluated },
                  { label: "Match completo", value: lastBackfill.recomputeResult.fullKitsFound },
                  { label: "Match parcial", value: lastBackfill.recomputeResult.partialKitsFound },
                  { label: "Status alterados", value: lastBackfill.recomputeResult.casesChanged },
                ].map(({ label, value }) => (
                  <div key={label} style={{ textAlign: "center", padding: "0.4rem", background: "var(--surface-1)", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: "1.1rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                    <div style={{ fontSize: "0.68rem", color: "var(--muted)" }}>{label}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {!lastBackfill.recomputeResult && (
            <p style={{ fontSize: "0.75rem", color: "var(--muted)", margin: 0 }}>Nenhum recompute pendente executado.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resultado de simulação inline
// ---------------------------------------------------------------------------

function SimResult({ result, onClose }: { result: SimulateResult; onClose: () => void }) {
  return (
    <div style={{
      border: "1px solid var(--accent-border, rgba(124,58,237,0.3))",
      borderRadius: "var(--r-md)",
      padding: "1rem 1.25rem",
      background: "rgba(124,58,237,0.05)",
      marginTop: "0.75rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Resultado da simulação (dry-run)</span>
        <button className="btn-ghost" style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem" }} onClick={onClose}>✕</button>
      </div>

      <p style={{ fontSize: "0.75rem", color: "var(--muted)", margin: "0 0 0.75rem" }}>
        A quantidade total de matches pode permanecer igual. A regra pode alterar principalmente
        <strong> quem recebe peça primeiro</strong>, não necessariamente quantos recebem.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.5rem", marginBottom: "0.75rem" }}>
        {[
          { label: "Match completo", value: result.fullKitsFound },
          { label: "Match parcial", value: result.partialKitsFound },
          { label: "Pedir peça", value: result.pedirPecaCount },
          { label: "Aguard. receb.", value: result.aguardandoCount },
          { label: "Verificar", value: result.verificarCount },
        ].map(({ label, value }) => (
          <div key={label} style={{
            textAlign: "center", padding: "0.5rem",
            background: "var(--surface-1)", borderRadius: "var(--r-sm)",
            border: "1px solid var(--border)",
          }}>
            <div style={{ fontSize: "1.25rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
            <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{label}</div>
          </div>
        ))}
      </div>

      {result.changedComparedToActive !== null && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
          <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.4rem" }}>
            Comparação com a regra ativa
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.4rem", marginBottom: "0.5rem" }}>
            {[
              { label: "Casos com status diferente", value: result.changedComparedToActive },
              { label: "Mudança em MATCH completo", value: result.changedFullMatchMembership ?? 0 },
              { label: "Mudança em MATCH parcial", value: result.changedPartialMembership ?? 0 },
              { label: "Mudança de posição na disputa", value: result.positionChanges },
            ].map(({ label, value }) => (
              <div key={label} style={{ textAlign: "center", padding: "0.4rem", background: "var(--surface-1)", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: value > 0 ? "var(--accent)" : undefined }}>{value}</div>
                <div style={{ fontSize: "0.68rem", color: "var(--muted)" }}>{label}</div>
              </div>
            ))}
          </div>

          {result.topChangedCases.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: "0.75rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Caso", "Status ativo", "Status simulado", "Score ativo", "Score simulado"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: "var(--muted)", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.topChangedCases.map(c => (
                    <tr key={c.caseId}>
                      <td style={{ padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>#{c.caseId}</td>
                      <td style={{ padding: "0.2rem 0.4rem", color: "var(--muted)" }}>{c.prevStatusActive}</td>
                      <td style={{ padding: "0.2rem 0.4rem", fontWeight: 600 }}>{c.newStatusSimulated}</td>
                      <td style={{ padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>{fmtScore(c.scoreActive)}</td>
                      <td style={{ padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>{fmtScore(c.scoreSimulated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(result.enteringMatch.length > 0 || result.leavingMatch.length > 0) && (
            <div style={{ fontSize: "0.75rem", marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
              {result.enteringMatch.length > 0 && (
                <span>Entrariam em MATCH: {result.enteringMatch.map(id => `#${id}`).join(", ")}</span>
              )}
              {result.leavingMatch.length > 0 && (
                <span>Sairiam de MATCH: {result.leavingMatch.map(id => `#${id}`).join(", ")}</span>
              )}
            </div>
          )}
        </div>
      )}

      {result.disputedKeys.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
          <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.4rem" }}>
            Referências mais disputadas (demanda &gt; disponível)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
            {result.disputedKeys.map(d => (
              <span key={d.stockChaveNorm} style={{
                fontSize: "0.72rem", padding: "0.15rem 0.5rem", borderRadius: "999px",
                border: "1px solid var(--border)", background: "var(--surface-1)",
              }}>
                {d.stockChaveNorm} — {d.demanded} pedem / {d.available} disp.
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuleCard
// ---------------------------------------------------------------------------

function RuleCard({ rule, onActivate }: { rule: MatchRuleSet; onActivate: (id: number, stats: ActivateStats) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [activating, setActivating] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState<SimulateResult | null>(null);

  async function handleActivate() {
    if (!reason || reason.trim().length < 5) return;
    setActivating(true);
    try {
      const r = await fetch(`/api/match-rules/${rule.id}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (r.ok) {
        const d = await r.json() as { casesEvaluated?: number; casesChanged?: number; runId?: number | null };
        onActivate(rule.id, {
          casesEvaluated: d.casesEvaluated ?? 0,
          casesChanged: d.casesChanged ?? 0,
          runId: d.runId ?? null,
        });
      }
    } finally {
      setActivating(false);
    }
  }

  async function handleSimulate() {
    setSimulating(true);
    setSimResult(null);
    try {
      const r = await fetch("/api/match-rules/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleSetId: rule.id, compareWithActive: true }),
      });
      if (r.ok) {
        setSimResult(await r.json() as SimulateResult);
      }
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div className={`rule-card ${rule.active ? "active" : ""}`}>
      <div className="rule-card-header" onClick={() => setExpanded(e => !e)}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="rule-version">v{rule.version}</span>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{rule.name ?? `Regra v${rule.version}`}</span>
          {rule.active && <span className="rule-badge active"><Check size={11} /> Ativa</span>}
          {!rule.active && <span className="rule-badge draft">Rascunho</span>}
          <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{rule.reason ?? "Sem justificativa"}</span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </div>

      {expanded && (
        <div className="rule-details">
          <div className="rule-params">
            <div className="param-row"><span>Margem / ponto</span><span>R$ {rule.marginAmountPerPoint.toFixed(0)}</span></div>
            <div className="param-row"><span>Dias / ponto de idade</span><span>{rule.ageDaysPerPoint}d</span></div>
            <div className="param-row"><span>Máx. pontos de idade</span><span>{rule.ageMaxPoints}</span></div>
            <div className="param-row"><span>Margem negativa pune</span><span>{rule.allowNegativeMarginScore ? "Sim" : "Não"}</span></div>
            <div className="param-row"><span>Peso margem / idade</span><span>{rule.marginWeight} / {rule.ageWeight}</span></div>
          </div>

          <div className="rule-formula">
            <code>
              score = (margem / {rule.marginAmountPerPoint}) × {rule.marginWeight}
              {" + "}min(idade / {rule.ageDaysPerPoint}, {rule.ageMaxPoints}) × {rule.ageWeight}
            </code>
            <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: "0.25rem" }}>
              Cálculo com precisão decimal completa — sem arredondamento. Ex.: margem R$ 735 → {(735 / rule.marginAmountPerPoint).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} pts.
            </div>
          </div>

          {/* Botão simular impacto */}
          <div style={{ marginTop: "0.75rem" }}>
            <button
              className="btn-ghost"
              style={{ fontSize: "0.82rem" }}
              onClick={() => void handleSimulate()}
              disabled={simulating}
            >
              {simulating ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
              Simular impacto
            </button>
          </div>

          {simResult && <SimResult result={simResult} onClose={() => setSimResult(null)} />}

          {!rule.active && (
            <div className="rule-activate">
              {!confirm ? (
                <button className="btn-primary" onClick={() => setConfirm(true)}>Ativar esta versão</button>
              ) : (
                <div className="activate-form">
                  <AlertTriangle size={14} style={{ color: "var(--warning)" }} />
                  <span style={{ fontSize: "0.85rem" }}>A regra atual será desativada. Informe o motivo:</span>
                  <input
                    className="input"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="Justificativa da ativação…"
                  />
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button className="btn-ghost" onClick={() => setConfirm(false)}>Cancelar</button>
                    <button
                      className="btn-primary"
                      onClick={() => void handleActivate()}
                      disabled={reason.trim().length < 5 || activating}
                    >
                      {activating ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                      Confirmar ativação
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {rule.activatedAt && (
            <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.5rem" }}>
              Ativada em {rule.activatedAt.slice(0, 16).replace("T", " ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewRuleForm
// ---------------------------------------------------------------------------

function NewRuleForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "",
    marginAmountPerPoint: 150,
    ageDaysPerPoint: 30,
    ageMaxPoints: 12,
    allowNegativeMarginScore: true,
    marginWeight: 1,
    ageWeight: 1,
    reason: "",
  });
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    setSaving(true);
    try {
      await fetch("/api/match-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  const f = (k: string, v: number | boolean) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div className="new-rule-form">
      <h3>Nova versão de regra</h3>
      <div className="form-grid-2">
        <label className="field">
          <span>Nome da regra</span>
          <input className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="ex: Regra 1, Foco em margem…" />
        </label>
        <label className="field">
          <span>Margem / ponto (R$)</span>
          <input className="input" type="number" value={form.marginAmountPerPoint} onChange={e => f("marginAmountPerPoint", Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Dias de idade / ponto</span>
          <input className="input" type="number" value={form.ageDaysPerPoint} onChange={e => f("ageDaysPerPoint", Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Máximo pontos de idade</span>
          <input className="input" type="number" value={form.ageMaxPoints} onChange={e => f("ageMaxPoints", Number(e.target.value))} />
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={form.allowNegativeMarginScore} onChange={e => f("allowNegativeMarginScore", e.target.checked)} />
          <span>Margem negativa pune o score</span>
        </label>
        <label className="field">
          <span>Peso margem</span>
          <input className="input" type="number" step="0.1" value={form.marginWeight} onChange={e => f("marginWeight", Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Peso idade</span>
          <input className="input" type="number" step="0.1" value={form.ageWeight} onChange={e => f("ageWeight", Number(e.target.value))} />
        </label>
      </div>
      <label className="field" style={{ marginTop: "0.5rem" }}>
        <span>Justificativa</span>
        <input className="input" value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} placeholder="Por que esta versão foi criada…" />
      </label>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1rem" }}>
        <button className="btn-primary" onClick={() => void handleCreate()} disabled={saving}>
          {saving ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          Criar rascunho
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdminMatchRules
// ---------------------------------------------------------------------------

export function AdminMatchRules() {
  const [rules, setRules] = useState<MatchRuleSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [activateMsg, setActivateMsg] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<PriorityCoverage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, cRes] = await Promise.all([
        fetch("/api/match-rules"),
        fetch("/api/match-rules/priority-coverage"),
      ]);
      if (rRes.ok) setRules((await rRes.json() as { rules: MatchRuleSet[] }).rules);
      if (cRes.ok) setCoverage(await cRes.json() as PriorityCoverage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Regras do Match</h1>
          <p className="page-subtitle">Parâmetros de priorização de aparelhos</p>
        </div>
        <button className="btn-primary" onClick={() => setShowNewForm(s => !s)}>
          <Plus size={14} />
          Nova versão
        </button>
      </div>

      {coverage && <CoverageBanner coverage={coverage} onBackfill={() => void load()} />}

      {showNewForm && (
        <NewRuleForm onCreated={() => { setShowNewForm(false); void load(); }} />
      )}

      {loading ? (
        <div className="loading-state"><Loader2 size={18} className="spin" /></div>
      ) : (
        <div className="rule-list">
          {activateMsg && (
            <div className="alert alert-ok" style={{ marginBottom: "0.75rem" }}>{activateMsg}</div>
          )}
          {rules.map(r => (
            <RuleCard key={r.id} rule={r} onActivate={(_, stats) => {
              void load();
              const { casesEvaluated, casesChanged } = stats;
              const msg = casesChanged === 0
                ? `Regras aplicadas. ${casesEvaluated} caso${casesEvaluated !== 1 ? "s" : ""} avaliado${casesEvaluated !== 1 ? "s" : ""}. Nenhum status mudou. Pesos podem alterar prioridade sem alterar quantidade de MATCH.`
                : `Regras aplicadas. ${casesEvaluated} caso${casesEvaluated !== 1 ? "s" : ""} avaliado${casesEvaluated !== 1 ? "s" : ""}, ${casesChanged} alterado${casesChanged !== 1 ? "s" : ""}.`;
              setActivateMsg(msg);
              setTimeout(() => setActivateMsg(null), 8000);
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
