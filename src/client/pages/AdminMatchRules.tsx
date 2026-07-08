import { useState, useEffect } from "react";
import { Plus, Check, ChevronDown, ChevronUp, Loader2, AlertTriangle } from "lucide-react";

interface MatchRuleSet {
  id: number;
  version: number;
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

function RuleCard({ rule, onActivate }: { rule: MatchRuleSet; onActivate: (id: number, casesEvaluated: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [activating, setActivating] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);

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
        const d = await r.json() as { casesEvaluated?: number };
        onActivate(rule.id, d.casesEvaluated ?? 0);
      }
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className={`rule-card ${rule.active ? "active" : ""}`}>
      <div className="rule-card-header" onClick={() => setExpanded(e => !e)}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="rule-version">v{rule.version}</span>
          {rule.active && (
            <span className="rule-badge active"><Check size={11} /> Ativa</span>
          )}
          {!rule.active && <span className="rule-badge draft">Rascunho</span>}
          <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{rule.reason ?? "Sem justificativa"}</span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </div>

      {expanded && (
        <div className="rule-details">
          <div className="rule-params">
            <div className="param-row">
              <span>Margem / ponto</span>
              <span>R$ {rule.marginAmountPerPoint.toFixed(0)}</span>
            </div>
            <div className="param-row">
              <span>Dias / ponto de idade</span>
              <span>{rule.ageDaysPerPoint}d</span>
            </div>
            <div className="param-row">
              <span>Máx. pontos de idade</span>
              <span>{rule.ageMaxPoints}</span>
            </div>
            <div className="param-row">
              <span>Margem negativa pune</span>
              <span>{rule.allowNegativeMarginScore ? "Sim" : "Não"}</span>
            </div>
            <div className="param-row">
              <span>Peso margem / idade</span>
              <span>{rule.marginWeight} / {rule.ageWeight}</span>
            </div>
          </div>

          <div className="rule-formula">
            <code>
              score = floor(margem / {rule.marginAmountPerPoint}) × {rule.marginWeight}
              {" + "}min(floor(idade / {rule.ageDaysPerPoint}), {rule.ageMaxPoints}) × {rule.ageWeight}
            </code>
          </div>

          {!rule.active && (
            <div className="rule-activate">
              {!confirm ? (
                <button className="btn-primary" onClick={() => setConfirm(true)}>
                  Ativar esta versão
                </button>
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
                      onClick={handleActivate}
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

function NewRuleForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    marginAmountPerPoint: 150,
    ageDaysPerPoint: 30,
    ageMaxPoints: 15,
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
        <button className="btn-primary" onClick={handleCreate} disabled={saving}>
          {saving ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          Criar rascunho
        </button>
      </div>
    </div>
  );
}

export function AdminMatchRules() {
  const [rules, setRules] = useState<MatchRuleSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [activateMsg, setActivateMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/match-rules");
      if (r.ok) {
        const d = await r.json() as { rules: MatchRuleSet[] };
        setRules(d.rules);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

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
            <RuleCard key={r.id} rule={r} onActivate={(_, cases) => {
              void load();
              setActivateMsg(`Regras aplicadas. ${cases} caso${cases !== 1 ? "s" : ""} reavaliado${cases !== 1 ? "s" : ""}.`);
              setTimeout(() => setActivateMsg(null), 5000);
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
