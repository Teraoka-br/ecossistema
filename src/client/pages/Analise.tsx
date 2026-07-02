import { useState } from "react";
import { Search, Plus, Save, CheckCircle, X, AlertTriangle } from "lucide-react";

interface DatasysRecord {
  id: number;
  imei: string | null;
  os: string | null;
  brand: string | null;
  model: string | null;
  ageDays: number | null;
  cost: number | null;
  entryDate: string | null;
}

interface RepairCase {
  id: number;
  imei: string | null;
  os: string | null;
  brand: string | null;
  model: string | null;
  ageDays: number | null;
  cost: number | null;
  estimatedSale: number | null;
  margin: number | null;
  entryDate: string | null;
  notes: string | null;
  analysisStatus: string;
  workflowStatus: string;
}

interface PartDraft {
  key: string;
  description: string;
  chavePeca: string;
  status: string;
}

const STATUS_OPTIONS = [
  "PEDIR_PECA", "AGUARDANDO_RECEBIMENTO", "INDICADA", "VERIFICAR",
];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "EM ANÁLISE",
  COMPLETED: "ANÁLISE FINALIZADA",
  EM_ANALISE: "EM ANÁLISE",
  PEDIR_PECA: "PEDIR PEÇA",
  MATCH: "MATCH",
  MATCH_PARCIAL: "MATCH PARCIAL",
  CONCLUIDO: "CONCLUÍDO",
  CANCELADO: "CANCELADO",
  VERIFICAR: "VERIFICAR",
};

type DataSource = "DATASYS" | "MANUAL" | "LEGADO";

export function Analise() {
  const [step, setStep] = useState<"search" | "form">("search");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const [existingCase, setExistingCase] = useState<RepairCase | null>(null);
  const [datasysRecords, setDatasysRecords] = useState<DatasysRecord[]>([]);
  const [source, setSource] = useState<DataSource>("MANUAL");

  // Formulário
  const [form, setForm] = useState({
    imei: "", os: "", brand: "", model: "",
    ageDays: "", cost: "", estimatedSale: "",
    entryDate: "", notes: "",
  });
  const [parts, setParts] = useState<PartDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCase, setSavedCase] = useState<RepairCase | null>(null);

  function setF(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setExistingCase(null);
    setDatasysRecords([]);
    setSavedCase(null);
    setSaveError(null);

    const q = encodeURIComponent(query.trim());
    const isImei = /^\d{10,}/.test(query.trim());

    const [repRes, dsRes] = await Promise.allSettled([
      fetch(`/api/repair-cases?limit=5`),
      fetch(`/api/datasys/search?${isImei ? `imei=${q}` : `os=${q}`}`),
    ]);

    // Busca case ativo por imei/os (filtragem local simplificada)
    let existCase: RepairCase | null = null;
    if (repRes.status === "fulfilled" && repRes.value.ok) {
      const d = await repRes.value.json();
      const q2 = query.trim().toLowerCase();
      existCase = (d.cases as RepairCase[]).find(
        (c) => (c.imei ?? "").toLowerCase() === q2 || (c.os ?? "").toLowerCase() === q2,
      ) ?? null;
    }

    let ds: DatasysRecord[] = [];
    if (dsRes.status === "fulfilled" && dsRes.value.ok) {
      const d = await dsRes.value.json();
      ds = d.records ?? [];
    }

    setExistingCase(existCase);
    setDatasysRecords(ds);

    // Pré-preenche formulário
    if (existCase) {
      setForm({
        imei: existCase.imei ?? "",
        os: existCase.os ?? "",
        brand: existCase.brand ?? "",
        model: existCase.model ?? "",
        ageDays: existCase.ageDays != null ? String(existCase.ageDays) : "",
        cost: existCase.cost != null ? String(existCase.cost) : "",
        estimatedSale: existCase.estimatedSale != null ? String(existCase.estimatedSale) : "",
        entryDate: existCase.entryDate ?? "",
        notes: existCase.notes ?? "",
      });
      setSource("LEGADO");
    } else if (ds.length > 0) {
      const rec = ds[0];
      setForm({
        imei: rec.imei ?? "",
        os: rec.os ?? "",
        brand: rec.brand ?? "",
        model: rec.model ?? "",
        ageDays: rec.ageDays != null ? String(rec.ageDays) : "",
        cost: rec.cost != null ? String(rec.cost) : "",
        estimatedSale: "",
        entryDate: rec.entryDate ?? "",
        notes: "",
      });
      setSource("DATASYS");
    } else {
      setForm((f) => ({
        ...f,
        imei: isImei ? query.trim() : "",
        os: !isImei ? query.trim() : "",
      }));
      setSource("MANUAL");
    }

    setSearching(false);
    setStep("form");
  }

  function applyDatasys(rec: DatasysRecord) {
    setForm((f) => ({
      ...f,
      imei: rec.imei ?? f.imei,
      os: rec.os ?? f.os,
      brand: rec.brand ?? f.brand,
      model: rec.model ?? f.model,
      ageDays: rec.ageDays != null ? String(rec.ageDays) : f.ageDays,
      cost: rec.cost != null ? String(rec.cost) : f.cost,
      entryDate: rec.entryDate ?? f.entryDate,
    }));
    setSource("DATASYS");
  }

  function addPart() {
    setParts((p) => [...p, { key: String(Date.now()), description: "", chavePeca: "", status: "PEDIR_PECA" }]);
  }

  function removePart(key: string) {
    setParts((p) => p.filter((x) => x.key !== key));
  }

  function setPart(key: string, field: keyof PartDraft, value: string) {
    setParts((p) => p.map((x) => (x.key === key ? { ...x, [field]: value } : x)));
  }

  async function handleSave(finalize: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        imei: form.imei || null,
        os: form.os || null,
        brand: form.brand || null,
        model: form.model || null,
        ageDays: form.ageDays ? Number(form.ageDays) : null,
        cost: form.cost ? Number(form.cost) : null,
        estimatedSale: form.estimatedSale ? Number(form.estimatedSale) : null,
        entryDate: form.entryDate || null,
        notes: form.notes || null,
      };

      let caseId: number;

      if (existingCase) {
        const r = await fetch(`/api/repair-cases/${existingCase.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(d.error ?? "Erro ao atualizar."); }
        const d = await r.json();
        caseId = d.repairCase.id;
      } else {
        const r = await fetch("/api/repair-cases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(d.error ?? "Erro ao criar."); }
        const d = await r.json();
        caseId = d.repairCase.id;
      }

      // Adiciona peças
      for (const part of parts) {
        await fetch(`/api/repair-cases/${caseId}/parts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: part.description || null, chavePeca: part.chavePeca || null, status: part.status }),
        });
      }

      // Finaliza análise se pedido
      if (finalize) {
        const r = await fetch(`/api/repair-cases/${caseId}/complete-analysis`, { method: "POST" });
        if (!r.ok) {
          const d = await r.json();
          throw new Error(d.error ?? "Erro ao finalizar análise.");
        }
      }

      // Recarrega caso
      const r2 = await fetch(`/api/repair-cases/${caseId}`);
      const d2 = await r2.json();
      setSavedCase(d2.repairCase);
      setParts([]);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setStep("search");
    setQuery("");
    setExistingCase(null);
    setDatasysRecords([]);
    setSavedCase(null);
    setSaveError(null);
    setParts([]);
  }

  const margin =
    form.cost && form.estimatedSale
      ? (Number(form.estimatedSale) - Number(form.cost)).toFixed(2)
      : null;

  return (
    <div>
      <div className="page-header">
        <h1>Analisar aparelho</h1>
        {step === "form" && (
          <button className="btn btn-ghost btn-sm" onClick={resetForm}>
            <X size={13} /> Nova busca
          </button>
        )}
      </div>

      {/* Etapa 1: Busca */}
      {step === "search" && (
        <div className="card" style={{ maxWidth: 480 }}>
          <form onSubmit={handleSearch}>
            <div className="form-group">
              <label>IMEI ou Número de OS</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Digite o IMEI ou OS do aparelho…"
                autoFocus
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={searching || !query.trim()}>
              <Search size={14} />
              {searching ? "Buscando…" : "Buscar"}
            </button>
          </form>
        </div>
      )}

      {/* Etapa 2: Formulário */}
      {step === "form" && (
        <div>
          {savedCase && (
            <div className="alert alert-ok">
              <CheckCircle size={14} /> Caso {savedCase.id} salvo — status: {STATUS_LABEL[savedCase.analysisStatus] ?? savedCase.analysisStatus}
            </div>
          )}
          {saveError && <div className="alert alert-err">{saveError}</div>}

          {existingCase && (
            <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
              Caso existente #{existingCase.id} encontrado — status: <strong>{STATUS_LABEL[existingCase.workflowStatus]}</strong>. Editando.
            </div>
          )}

          {datasysRecords.length > 0 && !existingCase && (
            <div className="card" style={{ marginBottom: "1rem" }}>
              <div className="gap-row" style={{ marginBottom: "0.5rem" }}>
                <span className="badge badge-info">DATASYS</span>
                <span className="muted text-sm">{datasysRecords.length} registro(s) encontrado(s)</span>
              </div>
              {datasysRecords.slice(0, 3).map((rec) => (
                <div key={rec.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <span className="text-sm">{rec.brand} {rec.model} — {rec.ageDays}d — IMEI: {rec.imei} — OS: {rec.os}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => applyDatasys(rec)}>Aplicar</button>
                </div>
              ))}
            </div>
          )}

          {/* Origem */}
          <div className="gap-row" style={{ marginBottom: "1rem" }}>
            <span className="text-sm muted">Origem dos dados:</span>
            <span className={`badge badge-${source === "DATASYS" ? "info" : source === "LEGADO" ? "muted" : "accent"}`}>{source}</span>
            {datasysRecords.length > 0 && source !== "DATASYS" && (
              <span className="text-xs muted" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <AlertTriangle size={12} /> Divergência com Datasys — use "Aplicar" para substituir.
              </span>
            )}
          </div>

          {/* Dados do aparelho */}
          <div className="card">
            <h2>Dados do aparelho</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <div className="form-group">
                <label>IMEI *</label>
                <input value={form.imei} onChange={(e) => setF("imei", e.target.value)} />
              </div>
              <div className="form-group">
                <label>OS *</label>
                <input value={form.os} onChange={(e) => setF("os", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Marca</label>
                <input value={form.brand} onChange={(e) => setF("brand", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Modelo *</label>
                <input value={form.model} onChange={(e) => setF("model", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Idade (dias) *</label>
                <input type="number" value={form.ageDays} onChange={(e) => setF("ageDays", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Data de entrada</label>
                <input type="date" value={form.entryDate} onChange={(e) => setF("entryDate", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Custo (R$) *</label>
                <input type="number" step="0.01" value={form.cost} onChange={(e) => setF("cost", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Venda estimada (R$) *</label>
                <input type="number" step="0.01" value={form.estimatedSale} onChange={(e) => setF("estimatedSale", e.target.value)} />
              </div>
            </div>
            {margin && (
              <div className="text-sm" style={{ color: Number(margin) >= 0 ? "var(--ok-text)" : "var(--err-text)" }}>
                Margem calculada: R$ {margin}
              </div>
            )}
            <div className="form-group" style={{ marginTop: "0.75rem" }}>
              <label>Observações</label>
              <textarea value={form.notes} onChange={(e) => setF("notes", e.target.value)} rows={2} style={{ resize: "vertical" }} />
            </div>
          </div>

          {/* Peças */}
          <div className="card">
            <div className="gap-row" style={{ marginBottom: "0.75rem" }}>
              <h2 style={{ margin: 0 }}>Peças necessárias *</h2>
              <span className="spacer" />
              <button className="btn btn-secondary btn-sm" onClick={addPart}>
                <Plus size={13} /> Adicionar peça
              </button>
            </div>
            {parts.length === 0 && (
              <p className="muted text-sm">Nenhuma peça adicionada. Adicione pelo menos uma peça para finalizar a análise.</p>
            )}
            {parts.map((part) => (
              <div key={part.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "end" }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Descrição</label>
                  <input value={part.description} onChange={(e) => setPart(part.key, "description", e.target.value)} placeholder="Ex.: Tela LCD" />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>CHAVE PEÇA</label>
                  <input value={part.chavePeca} onChange={(e) => setPart(part.key, "chavePeca", e.target.value)} placeholder="Ex.: TEL-A12" />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Status</label>
                  <select value={part.status} onChange={(e) => setPart(part.key, "status", e.target.value)}>
                    {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                  </select>
                </div>
                <button className="btn btn-ghost btn-sm" style={{ alignSelf: "end" }} onClick={() => removePart(part.key)} title="Remover">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>

          {/* Aviso motor */}
          <div className="motor-notice">
            O processamento automático das novas análises será ativado na próxima atualização do motor.
          </div>

          {/* Ações */}
          <div className="gap-row" style={{ marginTop: "1rem" }}>
            <button className="btn btn-secondary" onClick={() => handleSave(false)} disabled={saving}>
              <Save size={14} />
              {saving ? "Salvando…" : "Salvar em análise"}
            </button>
            <button className="btn btn-primary" onClick={() => handleSave(true)} disabled={saving}>
              <CheckCircle size={14} />
              {saving ? "Salvando…" : "Finalizar análise"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
