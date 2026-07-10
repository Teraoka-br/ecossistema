import { useState, useCallback } from "react";
import { Search, Plus, Save, CheckCircle, X, AlertTriangle, Info } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FieldSource = "SH" | "SERIAIS" | "HIS" | "PEACS" | "MANUAL";

interface PrefillResult {
  imei: string | null;
  os: string | null;
  marca: string | null;
  modelo: string | null;
  cor: string | null;
  problema: string | null;
  observacaoServico: string | null;
  codigoComercial: string | null;
  deposito: string | null;
  idade: number | null;
  custo: number;
  vendaEstimada: number;
  sources: Partial<Record<string, FieldSource>>;
  warnings: string[];
}

interface PartDraft {
  key: string;
  pecaNome: string;
  incluirCor: boolean;
  /** Quando true, pecaNome já é o CHAVEPECA completo — não concatenar modelo */
  isChavePecaExistente?: boolean;
  // cor é sempre a do aparelho — não editável por peça
}

interface PartSuggestion {
  text: string;
  type: "nome" | "chave";
}

interface SavedCase {
  id: number;
  analysisStatus: string;
  workflowStatus: string;
}

const SOURCE_COLOR: Record<FieldSource, string> = {
  SH:      "var(--color-info)",
  SERIAIS: "var(--color-accent, #6366f1)",
  HIS:     "var(--color-warning)",
  PEACS:   "var(--color-success)",
  MANUAL:  "var(--color-text-muted)",
};

function SourceBadge({ src }: { src: FieldSource | undefined }) {
  if (!src) return null;
  return (
    <span style={{
      fontSize: "0.68rem", padding: "1px 5px", borderRadius: 4,
      background: SOURCE_COLOR[src] + "22",
      color: SOURCE_COLOR[src], marginLeft: 4, verticalAlign: "middle",
    }}>{src}</span>
  );
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

interface Blockers {
  imei?: string;
  model?: string;
  cost?: string;
  estimatedSale?: string;
  parts?: string;
  partCor?: string;
}

function computeBlockers(form: FormState, parts: PartDraft[]): Blockers {
  const b: Blockers = {};
  if (!form.imei) b.imei = "IMEI obrigatório.";
  if (!form.model) b.model = "Modelo obrigatório.";
  if (!form.cost || Number(form.cost) <= 0) b.cost = "Custo deve ser maior que zero.";
  if (!form.estimatedSale || Number(form.estimatedSale) <= 0) b.estimatedSale = "Venda estimada deve ser maior que zero.";
  // Linhas vazias (sem nome) são ignoradas; só as preenchidas contam
  const validParts = parts.filter((p) => p.pecaNome.trim() !== "");
  if (validParts.length === 0) b.parts = "Ao menos uma peça obrigatória.";
  const missingCor = validParts.find((p) => p.incluirCor && !form.color.trim());
  if (missingCor) b.partCor = `Cor do aparelho obrigatória para "${missingCor.pecaNome}" (checkbox marcada).`;
  return b;
}

// ---------------------------------------------------------------------------
// CHAVEPECA preview
// ---------------------------------------------------------------------------

function buildChavePeca(pecaNome: string, modelo: string, incluirCor: boolean, corUsada: string): string {
  const parts = [pecaNome.trim(), modelo.trim()];
  if (incluirCor && corUsada.trim()) parts.push(corUsada.trim());
  return parts.filter(Boolean).join(" ").toUpperCase();
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  imei: string;
  os: string;
  brand: string;
  model: string;
  color: string;
  ageDays: string;
  cost: string;
  estimatedSale: string;
  problema: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  imei: "", os: "", brand: "", model: "", color: "",
  ageDays: "", cost: "", estimatedSale: "", problema: "", notes: "",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Analise() {
  const [step, setStep] = useState<"search" | "form">("search");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [prefill, setPrefill] = useState<PrefillResult | null>(null);
  const [existingCaseId, setExistingCaseId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldOrigins, setFieldOrigins] = useState<Partial<Record<string, FieldSource>>>({});

  const [parts, setParts] = useState<PartDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCase, setSavedCase] = useState<SavedCase | null>(null);

  // Part suggestions
  const [partSuggestions, setPartSuggestions] = useState<PartSuggestion[]>([]);
  const [activeSuggestKey, setActiveSuggestKey] = useState<string | null>(null);
  const [highlightedSuggIdx, setHighlightedSuggIdx] = useState(-1);

  // ---------------------------------------------------------------------------
  // Search → prefill
  // ---------------------------------------------------------------------------

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setPrefill(null);
    setSavedCase(null);
    setSaveError(null);

    try {
      const isImei = /^\d{10,}/.test(query.trim());
      const qEnc = encodeURIComponent(query.trim());

      // 1. Fetch prefill (fontes oficiais — SH vence)
      const pRes = await fetch(`/api/analise/prefill?q=${qEnc}`);
      if (!pRes.ok) {
        const err = await pRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Erro ${pRes.status}`);
      }
      const p = await pRes.json() as PrefillResult;
      setPrefill(p);

      // 2. Aplicar prefill ao formulário (SH/HIS/PEACS têm precedência)
      applyPrefillToForm(p, isImei ? query.trim() : null, !isImei ? query.trim() : null);

      // 3. Busca exata de caso existente (sem sobrescrever os campos do formulário)
      const searchParam = isImei ? `imei=${qEnc}` : `os=${qEnc}`;
      const caseRes = await fetch(`/api/repair-cases/search?${searchParam}`);
      if (caseRes.ok) {
        const cd = await caseRes.json() as { cases: Array<{ id: number; parts?: unknown[] }> };
        const found = cd.cases[0] ?? null;
        if (found) {
          setExistingCaseId(found.id);
          // Carregar peças existentes do caso (mas NÃO sobrescrever os campos do form)
          const rcRes = await fetch(`/api/repair-cases/${found.id}`);
          if (rcRes.ok) {
            const rcData = await rcRes.json() as { repairCase: { parts?: Array<{ description: string | null; chavePeca: string | null }> } };
            const existingParts = rcData.repairCase.parts ?? [];
            if (existingParts.length > 0) {
              setParts(existingParts.map((ep) => ({
                key: String(Date.now() + Math.random()),
                pecaNome: ep.description ?? ep.chavePeca ?? "",
                incluirCor: false,
                isChavePecaExistente: true,
              })));
            }
          }
        } else {
          setExistingCaseId(null);
        }
      }
      setStep("form");
    } catch (err) {
      const msg = (err as Error).message;
      setSearchError(
        msg === "Failed to fetch"
          ? "API indisponível. Verifique se o servidor está em execução."
          : msg,
      );
    } finally {
      setSearching(false);
    }
  }

  function applyPrefillToForm(p: PrefillResult, queryImei: string | null, queryOs: string | null) {
    setForm({
      imei: p.imei ?? queryImei ?? "",
      os: p.os ?? queryOs ?? "",
      brand: p.marca ?? "",
      model: p.modelo ?? "",
      color: p.cor ?? "",
      ageDays: p.idade != null ? String(p.idade) : "",
      cost: p.custo != null && p.custo > 0 ? String(p.custo) : "",
      estimatedSale: p.vendaEstimada > 0 ? String(p.vendaEstimada) : "",
      problema: p.problema ?? "",
      notes: p.observacaoServico ?? "",
    });
    setFieldOrigins(p.sources as Partial<Record<string, FieldSource>>);
  }

  // ---------------------------------------------------------------------------
  // Form helpers
  // ---------------------------------------------------------------------------

  function setF(k: keyof FormState, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldOrigins((o) => ({ ...o, [k]: "MANUAL" }));
  }

  // ---------------------------------------------------------------------------
  // Parts helpers
  // ---------------------------------------------------------------------------

  function addPart() {
    setParts((p) => [...p, { key: String(Date.now()), pecaNome: "", incluirCor: false }]);
  }

  function removePart(key: string) {
    setParts((p) => p.filter((x) => x.key !== key));
  }

  function setPart<K extends keyof PartDraft>(key: string, field: K, value: PartDraft[K]) {
    setParts((p) => p.map((x) => (x.key === key ? { ...x, [field]: value } : x)));
  }

  const fetchSuggestions = useCallback(async (pecaNome: string, partKey: string) => {
    if (pecaNome.length < 2) {
      setPartSuggestions([]);
      setActiveSuggestKey(null);
      setHighlightedSuggIdx(-1);
      return;
    }
    const r = await fetch(`/api/analise/part-suggestions?q=${encodeURIComponent(pecaNome)}`).catch(() => null);
    if (!r?.ok) return;
    const d = await r.json() as { suggestions: PartSuggestion[] };
    setPartSuggestions(d.suggestions);
    setActiveSuggestKey(partKey);
    setHighlightedSuggIdx(-1);
  }, []);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async function handleSave(finalize: boolean) {
    if (finalize) {
      const blockers = computeBlockers(form, parts);
      if (Object.keys(blockers).length > 0) {
        setSaveError("Pendências: " + Object.values(blockers).join(" | "));
        return;
      }
    }

    setSaving(true);
    setSaveError(null);

    try {
      // modelo sempre vem dos dados do aparelho — nunca da peça individualmente
      // se isChavePecaExistente, pecaNome já é o CHAVEPECA completo (não concatenar modelo)
      // linhas sem nome são ignoradas (não enviadas ao backend)
      const partsPayload = parts.filter((p) => p.pecaNome.trim() !== "").map((p) => {
        const corTrim = form.color.trim();
        let chavePeca: string;
        if (p.isChavePecaExistente) {
          chavePeca = (p.incluirCor && corTrim)
            ? (p.pecaNome.trim() + " " + corTrim).toUpperCase()
            : p.pecaNome.trim().toUpperCase();
        } else {
          chavePeca = buildChavePeca(p.pecaNome, form.model, p.incluirCor, form.color);
        }
        return {
          pecaNome: p.pecaNome,
          incluirCor: p.incluirCor,
          corUsada: (p.incluirCor && corTrim) ? corTrim : "",
          chavePeca,
        };
      });

      if (finalize) {
        // Full atomic save via new endpoint
        const r = await fetch("/api/analise/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            existingCaseId,
            imei: form.imei || null,
            os: form.os || null,
            brand: form.brand || null,
            model: form.model || null,
            color: form.color || null,
            ageDays: form.ageDays ? Number(form.ageDays) : null,
            cost: form.cost ? Number(form.cost) : null,
            estimatedSale: form.estimatedSale ? Number(form.estimatedSale) : null,
            problema: form.problema || null,
            notes: form.notes || null,
            fieldOrigins,
            parts: partsPayload,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error((d as { error?: string }).error ?? "Erro ao finalizar.");
        const rc = (d as { repairCase: Record<string, unknown> }).repairCase;
        setSavedCase({
          id: rc["id"] as number,
          analysisStatus: rc["analysisStatus"] as string,
          workflowStatus: rc["workflowStatus"] as string,
        });
        setParts([]);
      } else {
        // Draft save: transactional via /api/analise/save-draft
        const r = await fetch("/api/analise/save-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            existingCaseId,
            imei: form.imei || null,
            os: form.os || null,
            brand: form.brand || null,
            model: form.model || null,
            color: form.color || null,
            ageDays: form.ageDays ? Number(form.ageDays) : null,
            cost: form.cost ? Number(form.cost) : null,
            estimatedSale: form.estimatedSale ? Number(form.estimatedSale) : null,
            problema: form.problema || null,
            notes: form.notes || null,
            fieldOrigins,
            parts: partsPayload,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error((d as { error?: string }).error ?? "Erro ao salvar.");
        const rc = (d as { repairCase: Record<string, unknown> }).repairCase;
        const caseId = rc["id"] as number;
        if (!existingCaseId) setExistingCaseId(caseId);
        setParts([]);
        setSavedCase({ id: caseId, analysisStatus: "DRAFT", workflowStatus: "EM_ANALISE" });
      }
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setStep("search");
    setQuery("");
    setPrefill(null);
    setExistingCaseId(null);
    setForm(EMPTY_FORM);
    setFieldOrigins({});
    setParts([]);
    setSavedCase(null);
    setSaveError(null);
  }

  // margem calculada internamente (não exibida — usada pelo motor)
  const blockers = computeBlockers(form, parts);
  const hasBlockers = Object.keys(blockers).length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Analisar aparelho</h1>
        {step === "form" && (
          <button className="btn btn-ghost btn-sm" onClick={resetForm}>
            <X size={13} /> Nova busca
          </button>
        )}
      </div>

      {/* ── Busca ── */}
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
            {searchError && <div className="alert alert-err" style={{ marginBottom: 8 }}>{searchError}</div>}
            <button type="submit" className="btn btn-primary" disabled={searching || !query.trim()}>
              <Search size={14} />
              {searching ? "Buscando…" : "Buscar"}
            </button>
          </form>
        </div>
      )}

      {/* ── Formulário ── */}
      {step === "form" && (
        <div>
          {savedCase && (
            <div className="alert alert-ok" style={{ marginBottom: "1rem" }}>
              <CheckCircle size={14} />
              {" "}Caso #{savedCase.id} salvo —{" "}
              {savedCase.analysisStatus === "COMPLETED" ? "análise finalizada, na fila" : "em análise"}
            </div>
          )}
          {saveError && <div className="alert alert-err" style={{ marginBottom: "1rem" }}>{saveError}</div>}

          {existingCaseId && (
            <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
              Editando caso existente #{existingCaseId}. Dados atualizados pelas fontes oficiais.
            </div>
          )}

          {/* Avisos do prefill */}
          {prefill?.warnings && prefill.warnings.length > 0 && (
            <div style={{ background: "var(--color-surface-alt)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "8px 12px", marginBottom: "1rem", fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, color: "var(--color-warning)" }}>
                <AlertTriangle size={13} /> <strong>Avisos do pré-preenchimento</strong>
              </div>
              {prefill.warnings.map((w, i) => <div key={i} style={{ color: "var(--color-text-muted)", marginLeft: 19 }}>{w}</div>)}
            </div>
          )}

          {/* Dados do aparelho */}
          <div className="card">
            <h2>Dados do aparelho</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <div className="form-group">
                <label>IMEI * <SourceBadge src={fieldOrigins["imei"]} /></label>
                <input value={form.imei} onChange={(e) => setF("imei", e.target.value)} />
                {blockers.imei && <span style={{ color: "var(--color-danger)", fontSize: 11 }}>{blockers.imei}</span>}
              </div>
              <div className="form-group">
                <label>OS <SourceBadge src={fieldOrigins["os"]} /></label>
                <input value={form.os} onChange={(e) => setF("os", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Marca <SourceBadge src={fieldOrigins["marca"]} /></label>
                <input value={form.brand} onChange={(e) => setF("brand", e.target.value)} />
              </div>
              <div className="form-group">
                <label>Modelo * <SourceBadge src={fieldOrigins["modelo"]} /></label>
                <input value={form.model} onChange={(e) => setF("model", e.target.value)} />
                {blockers.model && <span style={{ color: "var(--color-danger)", fontSize: 11 }}>{blockers.model}</span>}
              </div>
              <div className="form-group">
                <label>Cor <SourceBadge src={fieldOrigins["cor"]} /></label>
                <input value={form.color} onChange={(e) => setF("color", e.target.value)} placeholder="Ex.: PRETO" />
              </div>
              <div className="form-group">
                <label>Idade (dias) <SourceBadge src={fieldOrigins["ageDays"] ?? fieldOrigins["idade"]} /></label>
                <input type="number" value={form.ageDays} onChange={(e) => setF("ageDays", e.target.value)} placeholder="0 é válido" />
              </div>
              <div className="form-group">
                <label>Custo (R$) * <SourceBadge src={fieldOrigins["custo"] ?? fieldOrigins["cost"]} /></label>
                <input type="number" step="0.01" value={form.cost} onChange={(e) => setF("cost", e.target.value)} />
                {blockers.cost && <span style={{ color: "var(--color-danger)", fontSize: 11 }}>{blockers.cost}</span>}
              </div>
              <div className="form-group">
                <label>Venda estimada (R$) * <SourceBadge src={fieldOrigins["vendaEstimada"]} /></label>
                <input type="number" step="0.01" value={form.estimatedSale} onChange={(e) => setF("estimatedSale", e.target.value)} />
                {blockers.estimatedSale && <span style={{ color: "var(--color-danger)", fontSize: 11 }}>{blockers.estimatedSale}</span>}
              </div>
            </div>
            {form.problema && (
              <div className="form-group" style={{ marginTop: "0.75rem" }}>
                <label>Problema (SH) <SourceBadge src={fieldOrigins["problema"]} /></label>
                <input value={form.problema} onChange={(e) => setF("problema", e.target.value)} />
              </div>
            )}
            <div className="form-group" style={{ marginTop: "0.75rem" }}>
              <label>Observações <SourceBadge src={fieldOrigins["notes"] ?? fieldOrigins["observacaoServico"]} /></label>
              <textarea value={form.notes} onChange={(e) => setF("notes", e.target.value)} rows={2} style={{ resize: "vertical" }} />
            </div>
            {prefill?.codigoComercial && (
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>
                <Info size={10} style={{ verticalAlign: "middle", marginRight: 3 }} />
                Código comercial: <strong>{prefill.codigoComercial}</strong>
                {prefill.deposito && ` · Depósito: ${prefill.deposito}`}
              </div>
            )}
          </div>

          {/* Peças necessárias */}
          <div className="card" style={{ marginTop: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <h2 style={{ margin: 0 }}>Peças necessárias *</h2>
              <span style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" onClick={addPart}>
                <Plus size={13} /> Adicionar peça
              </button>
            </div>
            {blockers.parts && <p style={{ color: "var(--color-danger)", fontSize: 12, margin: "0 0 8px" }}>{blockers.parts}</p>}
            {blockers.partCor && <p style={{ color: "var(--color-danger)", fontSize: 12, margin: "0 0 8px" }}>{blockers.partCor}</p>}
            {parts.length === 0 && (
              <p className="muted text-sm">Nenhuma peça adicionada. Adicione ao menos uma para finalizar a análise.</p>
            )}
            {parts.map((part) => {
              const preview = part.isChavePecaExistente
                ? (part.incluirCor && form.color.trim()
                    ? (part.pecaNome.trim() + " " + form.color.trim()).toUpperCase()
                    : part.pecaNome.trim().toUpperCase())
                : buildChavePeca(part.pecaNome, form.model, part.incluirCor, form.color);
              return (
                <div key={part.key} style={{ borderBottom: "1px solid var(--color-border)", paddingBottom: "0.75rem", marginBottom: "0.75rem" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.5rem", alignItems: "end" }}>
                    <div className="form-group" style={{ margin: 0, position: "relative" }}>
                      <label>Nome da peça</label>
                      <input
                        value={part.pecaNome}
                        onChange={(e) => {
                          setPart(part.key, "pecaNome", e.target.value);
                          setPart(part.key, "isChavePecaExistente", false);
                          fetchSuggestions(e.target.value, part.key);
                        }}
                        onBlur={() => setTimeout(() => {
                          if (activeSuggestKey === part.key) {
                            setActiveSuggestKey(null);
                            setHighlightedSuggIdx(-1);
                          }
                        }, 150)}
                        onKeyDown={(e) => {
                          if (activeSuggestKey !== part.key || partSuggestions.length === 0) return;
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setHighlightedSuggIdx((i) => Math.min(i + 1, partSuggestions.length - 1));
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setHighlightedSuggIdx((i) => Math.max(i - 1, 0));
                          } else if (e.key === "Enter" && highlightedSuggIdx >= 0) {
                            e.preventDefault();
                            const s = partSuggestions[highlightedSuggIdx];
                            setPart(part.key, "pecaNome", s.text);
                            setPart(part.key, "isChavePecaExistente", s.type === "chave");
                            setActiveSuggestKey(null);
                            setPartSuggestions([]);
                            setHighlightedSuggIdx(-1);
                          } else if (e.key === "Escape") {
                            setActiveSuggestKey(null);
                            setPartSuggestions([]);
                            setHighlightedSuggIdx(-1);
                          }
                        }}
                        placeholder="Ex.: TELA, BATERIA, TAMPA TRASEIRA"
                      />
                      {activeSuggestKey === part.key && partSuggestions.length > 0 && (
                        <div style={{
                          position: "absolute", zIndex: 10, top: "100%", left: 0, right: 0,
                          background: "var(--color-surface)", border: "1px solid var(--color-border)",
                          borderRadius: 4, maxHeight: 150, overflowY: "auto",
                        }}>
                          {partSuggestions.map((s, idx) => (
                            <div key={s.text + s.type}
                              style={{
                                padding: "4px 8px", cursor: "pointer", fontSize: 12,
                                display: "flex", justifyContent: "space-between", alignItems: "center",
                                background: idx === highlightedSuggIdx ? "var(--elevated)" : "transparent",
                              }}
                              onMouseEnter={() => setHighlightedSuggIdx(idx)}
                              onMouseDown={() => {
                                setPart(part.key, "pecaNome", s.text);
                                setPart(part.key, "isChavePecaExistente", s.type === "chave");
                                setActiveSuggestKey(null);
                                setPartSuggestions([]);
                                setHighlightedSuggIdx(-1);
                              }}>
                              <span>{s.text}</span>
                              {s.type === "chave" && (
                                <span style={{ fontSize: 10, color: "var(--color-text-muted)", marginLeft: 6, flexShrink: 0 }}>chave</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className="btn btn-ghost btn-sm" style={{ alignSelf: "end" }} onClick={() => removePart(part.key)} title="Remover">
                      <X size={13} />
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "0.4rem" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={part.incluirCor}
                        onChange={(e) => setPart(part.key, "incluirCor", e.target.checked)}
                      />
                      Incluir cor do aparelho
                    </label>
                    {part.incluirCor && !form.color.trim() && (
                      <span style={{ color: "var(--color-danger)", fontSize: 11 }}>
                        Preencha a cor do aparelho acima
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-muted)", fontFamily: "monospace" }}>
                      → {preview || "(preencha o nome)"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pendências */}
          {hasBlockers && (
            <div style={{ background: "var(--color-warning-subtle, rgba(234,179,8,0.08))", border: "1px solid var(--color-warning)", borderRadius: 6, padding: "8px 12px", marginTop: "1rem", fontSize: 12 }}>
              <strong style={{ color: "var(--color-warning)" }}>Pendências para finalizar:</strong>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {Object.values(blockers).map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}

          {/* Ações */}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button className="btn btn-secondary" onClick={() => handleSave(false)} disabled={saving}>
              <Save size={14} />
              {saving ? "Salvando…" : "Salvar em análise"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => handleSave(true)}
              disabled={saving || hasBlockers}
              title={hasBlockers ? Object.values(blockers).join(" | ") : undefined}
            >
              <CheckCircle size={14} />
              {saving ? "Salvando…" : "Finalizar análise"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
