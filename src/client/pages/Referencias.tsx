import { useEffect, useState, useRef, useCallback } from "react";
import { Plus, Pencil, Trash2, Search, History, X, Check, RefreshCw, Wand2, Info, RotateCcw } from "lucide-react";
import { useAuth } from "../auth.js";
import {
  FORNECEDORES, MARCAS, MODELOS, CORES, PECAS,
  generateReference, decodeReference,
} from "../../shared/part-ref-tables.js";

interface PartKey {
  id: number | null;
  chave_peca: string;
  chave_peca_norm: string;
  descricao: string | null;
  source: "IMPORTADA" | "MANUAL";
  created_by: string | null;
  created_at: string | null;
  isOverride: boolean;
  originalChavePeca: string | null;
  originalDescricao: string | null;
}

interface EditRow {
  id: number;
  chave_peca_norm: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  edited_by: string | null;
  edited_at: string;
  notes: string | null;
}

interface EditModal {
  key: PartKey;
  chavePeca: string;
  descricao: string;
  notes: string;
  history: EditRow[];
  historyLoading: boolean;
  saving: boolean;
}

// Listas ordenadas para dropdowns
const FORNECEDOR_OPTS = Object.keys(FORNECEDORES).sort();
const MARCA_OPTS = Object.keys(MARCAS).sort();
const MODELO_OPTS = Object.keys(MODELOS).sort((a, b) => a.localeCompare(b, "pt-BR"));
const COR_OPTS = Object.entries(CORES).sort((a, b) => a[1] - b[1]).map(([n]) => n);
const PECA_OPTS = Object.entries(PECAS).sort((a, b) => a[1] - b[1]).map(([n]) => n);

function GeneratorForm({ onGenerate }: { onGenerate: (chave: string, desc: string) => void }) {
  const [fornecedor, setFornecedor] = useState("");
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [cor, setCor] = useState("");
  const [peca, setPeca] = useState("");

  const preview = fornecedor && marca && modelo && cor && peca
    ? generateReference({ fornecedor, marca, modelo, cor, peca })
    : null;

  const descricao = [peca, marca, modelo, cor].filter(Boolean).join(" ").toUpperCase();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Fornecedor</label>
          <select value={fornecedor} onChange={e => setFornecedor(e.target.value)}>
            <option value="">— selecione —</option>
            {FORNECEDOR_OPTS.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Marca</label>
          <select value={marca} onChange={e => setMarca(e.target.value)}>
            <option value="">— selecione —</option>
            {MARCA_OPTS.map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0, gridColumn: "1 / -1" }}>
          <label>Modelo</label>
          <select value={modelo} onChange={e => setModelo(e.target.value)}>
            <option value="">— selecione —</option>
            {MODELO_OPTS.map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Cor</label>
          <select value={cor} onChange={e => setCor(e.target.value)}>
            <option value="">— selecione —</option>
            {COR_OPTS.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Peça</label>
          <select value={peca} onChange={e => setPeca(e.target.value)}>
            <option value="">— selecione —</option>
            {PECA_OPTS.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {preview ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0.85rem", borderRadius: "var(--r)", background: "var(--surface-2, rgba(255,255,255,0.04))", border: "1px solid var(--ok-border, rgba(74,222,128,0.25))" }}>
          <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "1rem", color: "var(--ok-text, #4ade80)" }}>{preview}</span>
          <span className="muted" style={{ fontSize: "0.78rem", flex: 1 }}>{descricao}</span>
          <button className="btn btn-primary btn-sm" onClick={() => onGenerate(preview, descricao)}>
            <Check size={12} /> Usar esta chave
          </button>
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>Preencha todos os campos para gerar a referência.</p>
      )}
    </div>
  );
}

function DecodedBadge({ chave }: { chave: string }) {
  const decoded = decodeReference(chave);
  if (!decoded) return null;
  return (
    <div style={{
      display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center",
      padding: "0.45rem 0.65rem", borderRadius: "var(--r)",
      background: "rgba(124,58,237,0.08)", border: "1px solid rgba(124,58,237,0.2)",
      fontSize: "0.78rem",
    }}>
      <Info size={11} style={{ color: "rgba(124,58,237,0.8)", flexShrink: 0 }} />
      <span style={{ color: "var(--muted)" }}>Decodificado:</span>
      <span><strong>{decoded.fornecedores.join(" / ")}</strong></span>
      <span className="muted">·</span>
      <span><strong>{decoded.marcas.join(" / ")}</strong></span>
      <span className="muted">·</span>
      <span>{decoded.modelos.join(" / ")}</span>
      <span className="muted">·</span>
      <span>{decoded.cor}</span>
      <span className="muted">·</span>
      <span>{decoded.peca}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compatibilidade manual de referências (part_key_aliases)
// ---------------------------------------------------------------------------

interface AliasRow {
  id: number;
  requested_chave_peca: string;
  requested_chave_peca_norm: string;
  stock_chave_peca: string;
  stock_chave_peca_norm: string;
  reason: string | null;
  active: number;
  created_at: string;
}

interface ComboOption { label: string; sub?: string }

/**
 * Campo de busca com dropdown — busca via API conforme o usuário digita,
 * permite selecionar uma opção existente ou confirmar texto livre.
 */
function ChaveCombobox({
  value,
  onChange,
  placeholder,
  fetchOptions,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  fetchOptions: (q: string) => Promise<ComboOption[]>;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<ComboOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || value.trim().length < 1) { setOptions([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void fetchOptions(value.trim()).then(opts => { if (!cancelled) { setOptions(opts); setHighlighted(0); } });
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [value, open, fetchOptions]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const trimmed = value.trim().toUpperCase();
  const exactMatch = options.some(o => o.label.toUpperCase() === trimmed);
  const showFree = trimmed.length >= 2 && !exactMatch;
  const allOpts: ComboOption[] = showFree
    ? [...options, { label: trimmed, sub: "usar este texto (novo)" }]
    : options;

  function select(opt: ComboOption) {
    onChange(opt.label);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || allOpts.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, allOpts.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (allOpts[highlighted]) select(allOpts[highlighted]); }
    else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        style={{ width: "100%", boxSizing: "border-box" }}
        autoComplete="off"
      />
      {open && allOpts.length > 0 && (
        <div style={{
          position: "absolute", zIndex: 200, left: 0, right: 0, top: "calc(100% + 2px)",
          background: "var(--surface)", border: "1px solid var(--border-2)",
          borderRadius: "var(--r-sm)", boxShadow: "var(--shadow-lg)",
          maxHeight: 220, overflowY: "auto",
        }}>
          {allOpts.map((opt, i) => {
            const isNew = opt.sub === "usar este texto (novo)";
            return (
              <div
                key={opt.label + i}
                onMouseDown={e => { e.preventDefault(); select(opt); }}
                onMouseEnter={() => setHighlighted(i)}
                style={{
                  padding: "0.45rem 0.75rem",
                  cursor: "pointer",
                  background: i === highlighted ? "var(--elevated)" : undefined,
                  borderBottom: i < allOpts.length - 1 ? "1px solid var(--border)" : undefined,
                  display: "flex", flexDirection: "column", gap: "0.1rem",
                }}
              >
                <span style={{ fontSize: "0.83rem", fontWeight: 600, color: isNew ? "var(--accent)" : "var(--text)" }}>
                  {isNew ? `+ "${opt.label}"` : opt.label}
                </span>
                {opt.sub && !isNew && (
                  <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{opt.sub}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CompatSection({ allKeys, isAdmin }: { allKeys: PartKey[]; isAdmin: boolean }) {
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [reqChave, setReqChave] = useState("");
  const [stockChave, setStockChave] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  // Busca chaves pedidas pelos casos (part_requests)
  const fetchRequestedKeys = useCallback(async (q: string): Promise<ComboOption[]> => {
    if (q.length < 1) return [];
    const r = await fetch(`/api/analise/part-suggestions?q=${encodeURIComponent(q)}`).catch(() => null);
    if (!r?.ok) return [];
    const d = await r.json() as { suggestions: Array<{ text: string }> };
    return d.suggestions.map(s => ({ label: s.text }));
  }, []);

  // Busca chaves e referências no estoque (allKeys + PC-... refs)
  const fetchStockKeys = useCallback(async (q: string): Promise<ComboOption[]> => {
    const upper = q.toUpperCase();
    const fromKeys = allKeys
      .filter(k => k.chave_peca.includes(upper))
      .slice(0, 10)
      .map(k => ({ label: k.chave_peca, sub: k.descricao ?? undefined }));
    // Busca referências PC-... no estoque operacional
    const r = await fetch(`/api/referencias/stock-keys?q=${encodeURIComponent(q)}`).catch(() => null);
    const fromStock: ComboOption[] = [];
    if (r?.ok) {
      const d = await r.json() as { items: Array<{ reference: string; chave_peca: string }> };
      for (const item of d.items) {
        if (!fromKeys.some(k => k.label === item.chave_peca)) {
          fromStock.push({ label: item.reference, sub: item.chave_peca });
        }
      }
    }
    return [...fromKeys, ...fromStock];
  }, [allKeys]);

  async function load(query?: string) {
    setLoading(true);
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    const r = await fetch(`/api/part-key-aliases${qs}`);
    if (r.ok) setAliases(((await r.json()) as { aliases: AliasRow[] }).aliases);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const t = setTimeout(() => { void load(q || undefined); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function create() {
    if (!reqChave.trim() || !stockChave.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/part-key-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedChavePeca: reqChave.trim(), stockChavePeca: stockChave.trim(), reason: reason.trim() || null }),
      });
      const d = await r.json() as { error?: string; recompute?: { casesChanged?: number } | null };
      if (r.ok) {
        setMsg(`Compatibilidade criada. Motor recalculado${d.recompute?.casesChanged != null ? ` — ${d.recompute.casesChanged} card(s) mudaram` : ""}.`);
        setReqChave(""); setStockChave(""); setReason(""); setShowForm(false);
        void load(q || undefined);
      } else {
        setErr(d.error ?? "Erro ao criar vínculo.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(id: number) {
    if (removingId !== id) { setRemovingId(id); return; }
    setRemovingId(null);
    setErr(null);
    const r = await fetch(`/api/part-key-aliases/${id}`, { method: "DELETE" });
    const d = await r.json() as { error?: string; recompute?: { casesChanged?: number } | null };
    if (r.ok) {
      setMsg(`Vínculo desativado. Motor recalculado${d.recompute?.casesChanged != null ? ` — ${d.recompute.casesChanged} card(s) mudaram` : ""}.`);
      void load(q || undefined);
    } else {
      setErr(d.error ?? "Erro ao desativar.");
    }
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Compatibilidades entre referências</h2>
        <span className="spacer" />
        {isAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(v => !v)}>
            <Plus size={13} /> Novo vínculo
          </button>
        )}
      </div>
      <p className="subtitle" style={{ marginTop: 0 }}>
        Vincula uma chave solicitada nos pedidos a uma chave compatível existente no estoque
        (ex.: BATERIA IPHONE 12 → BATERIA IPHONE 12/12 PRO). O motor de match usa o vínculo com
        prioridade e nunca presume compatibilidade por semelhança de texto. O saldo físico nunca
        é duplicado. Criar ou desativar um vínculo recalcula o motor imediatamente.
      </p>

      {msg && <div className="alert alert-ok" onClick={() => setMsg(null)} style={{ cursor: "pointer" }}>{msg}</div>}
      {err && <div className="alert alert-err">{err}</div>}

      {showForm && (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "0.875rem 1rem", marginBottom: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: "0.75rem", alignItems: "end" }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Chave pedida pelos casos
              </label>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                Como aparece nos pedidos de peça (ex: BATERIA IPHONE 12)
              </div>
              <ChaveCombobox
                value={reqChave}
                onChange={setReqChave}
                placeholder="Buscar ou digitar chave dos casos…"
                fetchOptions={fetchRequestedKeys}
                disabled={saving}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", fontWeight: 700, fontSize: "1.1rem", paddingBottom: "0.1rem" }}>
              →
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Chave ou referência no estoque
              </label>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                Chave do estoque ou código PC-… (ex: BATERIA IPHONE 12/12 PRO ou PC-QA15247)
              </div>
              <ChaveCombobox
                value={stockChave}
                onChange={setStockChave}
                placeholder="Buscar chave do estoque ou ref PC-…"
                fetchOptions={fetchStockKeys}
                disabled={saving}
              />
            </div>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label>Justificativa (opcional)</label>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="ex: mesma peça física, embalagem 12/12 Pro" />
          </div>

          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={saving || !reqChave.trim() || !stockChave.trim()}>
              {saving ? "Salvando…" : "Criar vínculo"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowForm(false); setReqChave(""); setStockChave(""); setReason(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <Search size={14} style={{ color: "var(--muted)" }} />
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por chave…" style={{ flex: 1, fontSize: "0.9rem" }} />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Chave solicitada</th>
              <th></th>
              <th>Chave no estoque</th>
              <th>Justificativa</th>
              <th>Situação</th>
              <th>Criado em</th>
              {isAdmin && <th>Ações</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="muted">Carregando…</td></tr>}
            {!loading && aliases.length === 0 && <tr><td colSpan={7} className="muted">Nenhuma compatibilidade cadastrada.</td></tr>}
            {aliases.map(a => (
              <tr key={a.id} style={a.active === 0 ? { opacity: 0.55 } : undefined}>
                <td className="mono" style={{ fontWeight: 600 }}>{a.requested_chave_peca}</td>
                <td className="muted">→</td>
                <td className="mono">{a.stock_chave_peca}</td>
                <td className="small muted">{a.reason ?? "—"}</td>
                <td>{a.active === 1 ? <span className="badge badge-ok">Ativo</span> : <span className="badge badge-muted">Desativado</span>}</td>
                <td className="small muted">{a.created_at?.slice(0, 10)}</td>
                {isAdmin && (
                  <td>
                    {a.active === 1 && (
                      <button
                        className={`btn btn-sm ${removingId === a.id ? "btn-primary" : "btn-ghost"}`}
                        style={removingId !== a.id ? { color: "var(--err-text, #f87171)" } : {}}
                        onClick={() => void deactivate(a.id)}
                        title={removingId === a.id ? "Confirmar desativação" : "Desativar vínculo"}
                      >
                        {removingId === a.id ? <Check size={12} /> : <Trash2 size={12} />}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Referencias() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<PartKey[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Criação — modo manual ou gerador
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<"manual" | "generator">("manual");
  const [newChave, setNewChave] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);

  // Modal de edição universal
  const [editModal, setEditModal] = useState<EditModal | null>(null);

  // Deleção com confirmação
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function load(q?: string) {
    setLoading(true);
    const qs = q ? `?search=${encodeURIComponent(q)}` : "";
    const r = await fetch(`/api/part-keys/all${qs}`);
    if (r.ok) { const d = await r.json() as { keys: PartKey[] }; setKeys(d.keys); }
    else setError("Erro ao carregar.");
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const t = setTimeout(() => { void load(search || undefined); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (showCreate && createMode === "manual") setTimeout(() => newInputRef.current?.focus(), 50);
  }, [showCreate, createMode]);

  async function create() {
    if (!newChave.trim()) return;
    setError(null);
    const r = await fetch("/api/part-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chavePeca: newChave.trim(), descricao: newDesc.trim() || undefined }),
    });
    if (r.ok) {
      setMsg("Chave criada.");
      setNewChave(""); setNewDesc(""); setShowCreate(false);
      void load(search || undefined);
    } else {
      const d = await r.json() as { error?: string };
      setError(d.error ?? "Erro ao criar.");
    }
  }

  async function openEdit(k: PartKey) {
    const modal: EditModal = {
      key: k, chavePeca: k.chave_peca, descricao: k.descricao ?? "",
      notes: "", history: [], historyLoading: true, saving: false,
    };
    setEditModal(modal);
    const r = await fetch(`/api/part-keys/history/${encodeURIComponent(k.chave_peca_norm)}`);
    if (r.ok) {
      const d = await r.json() as { history: EditRow[] };
      setEditModal(prev => prev ? { ...prev, history: d.history, historyLoading: false } : null);
    } else {
      setEditModal(prev => prev ? { ...prev, historyLoading: false } : null);
    }
  }

  async function saveEdit() {
    if (!editModal) return;
    setEditModal(prev => prev ? { ...prev, saving: true } : null);
    setError(null);
    const k = editModal.key;
    const body = {
      chavePeca: editModal.chavePeca.trim(),
      descricao: editModal.descricao.trim() || null,
      editedBy: user?.displayName ?? user?.username ?? "sistema",
      notes: editModal.notes.trim() || undefined,
    };
    const url = k.source === "MANUAL" && k.id !== null && !k.isOverride
      ? `/api/part-keys/${k.id}`
      : `/api/part-keys/imported/${encodeURIComponent(k.chave_peca_norm)}`;
    const r = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) {
      setMsg(editModal.chavePeca.trim() !== k.chave_peca
        ? "Chave atualizada. Motor de match reagendado para reavaliação."
        : "Chave atualizada.");
      setEditModal(null);
      void load(search || undefined);
    } else {
      const d = await r.json() as { error?: string };
      setError(d.error ?? "Erro ao salvar.");
      setEditModal(prev => prev ? { ...prev, saving: false } : null);
    }
  }

  async function restoreKey() {
    if (!editModal) return;
    const k = editModal.key;
    if (!k.isOverride) return;
    setEditModal(prev => prev ? { ...prev, saving: true } : null);
    setError(null);
    const r = await fetch(`/api/part-keys/imported/${encodeURIComponent(k.chave_peca_norm)}/override`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: editModal.notes.trim() || undefined }),
    });
    if (r.ok) {
      setMsg("Valor original restaurado.");
      setEditModal(null);
      void load(search || undefined);
    } else {
      const d = await r.json() as { error?: string };
      setError(d.error ?? "Erro ao restaurar.");
      setEditModal(prev => prev ? { ...prev, saving: false } : null);
    }
  }

  async function remove(id: number) {
    if (deletingId === id) {
      setError(null); setDeletingId(null);
      const r = await fetch(`/api/part-keys/${id}`, { method: "DELETE" });
      if (r.ok) { setMsg("Chave removida."); void load(search || undefined); }
      else { const d = await r.json() as { error?: string }; setError(d.error ?? "Erro ao remover."); }
    } else {
      setDeletingId(id);
    }
  }

  const total = keys.length;
  const totalManual = keys.filter(k => k.source === "MANUAL").length;
  const totalImport = keys.filter(k => k.source === "IMPORTADA").length;
  const fieldLabel = (f: string) => f === "chave_peca" ? "CHAVEPECA" : "Descrição";

  return (
    <div>
      <div className="page-header">
        <h1>Referências de peças</h1>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(v => !v)}>
          <Plus size={13} /> Nova chave
        </button>
      </div>
      <p className="subtitle">
        Todas as CHAVEPECAs do sistema — importadas do legado e criadas manualmente.
        Edições acionam reavaliação automática do motor de match.
      </p>

      {msg && <div className="alert alert-ok" onClick={() => setMsg(null)} style={{ cursor: "pointer" }}>{msg}</div>}
      {error && <div className="alert alert-err">{error}</div>}

      {showCreate && (
        <div className="card" style={{ maxWidth: 560, marginBottom: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
            <h2 style={{ margin: 0 }}>Nova CHAVEPECA</h2>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button
                className={`btn btn-sm ${createMode === "manual" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setCreateMode("manual")}
              >Manual</button>
              <button
                className={`btn btn-sm ${createMode === "generator" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setCreateMode("generator")}
              >
                <Wand2 size={12} /> Gerador
              </button>
            </div>
          </div>

          {createMode === "generator" ? (
            <>
              <GeneratorForm onGenerate={(chave, desc) => {
                setNewChave(chave);
                setNewDesc(desc);
                setCreateMode("manual");
              }} />
            </>
          ) : (
            <>
              <div className="form-group">
                <label>CHAVEPECA</label>
                <input
                  ref={newInputRef}
                  value={newChave}
                  onChange={e => setNewChave(e.target.value.toUpperCase())}
                  placeholder="ex: PC-PA7347  ou  TELA-IPHONE-12"
                  onKeyDown={e => { if (e.key === "Enter") void create(); }}
                />
              </div>
              {newChave && <DecodedBadge chave={newChave} />}
              <div className="form-group" style={{ marginTop: "0.5rem" }}>
                <label>Descrição (opcional)</label>
                <input
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="ex: Bateria iPhone 11 Parcell"
                  onKeyDown={e => { if (e.key === "Enter") void create(); }}
                />
              </div>
              <div className="gap-row" style={{ marginTop: "0.25rem" }}>
                <button className="btn btn-primary btn-sm" onClick={create} disabled={!newChave.trim()}>Criar</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowCreate(false); setNewChave(""); setNewDesc(""); }}>Cancelar</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1, minWidth: 200 }}>
            <Search size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por chave ou descrição…" style={{ flex: 1, fontSize: "0.9rem" }} />
          </div>
          {!loading && (
            <div style={{ display: "flex", gap: "0.5rem", fontSize: "0.8rem", color: "var(--muted)", whiteSpace: "nowrap" }}>
              <span>{total} total</span><span>·</span>
              <span className="badge badge-info">{totalImport} importadas</span>
              <span className="badge badge-ok">{totalManual} manuais</span>
            </div>
          )}
        </div>
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>CHAVEPECA</th>
                <th>Descrição / Referência</th>
                <th>Origem</th>
                <th>Criado por</th>
                <th>Data</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="muted">Carregando…</td></tr>}
              {!loading && keys.length === 0 && <tr><td colSpan={6} className="muted">Nenhuma chave encontrada.</td></tr>}
              {keys.map((k, i) => (
                <tr key={k.id ?? `imp-${i}`}>
                  <td className="mono" style={{ fontWeight: 600 }}>{k.chave_peca}</td>
                  <td style={{ fontSize: "0.85rem", color: (k.descricao || decodeReference(k.chave_peca)) ? undefined : "var(--muted)" }}>
                    {k.descricao ?? (() => {
                      const d = decodeReference(k.chave_peca);
                      if (!d) return "—";
                      return [d.peca, ...d.marcas, ...d.modelos, d.cor].filter(Boolean).join(" · ");
                    })()}
                  </td>
                  <td>
                    {k.source === "MANUAL"
                      ? <span className="badge badge-ok">Manual</span>
                      : k.isOverride
                        ? <span className="badge badge-info">Importada (editada)</span>
                        : <span className="badge badge-muted">Importada</span>}
                  </td>
                  <td className="muted small">{k.created_by ?? "—"}</td>
                  <td className="small muted">{k.created_at?.slice(0, 10) ?? "—"}</td>
                  <td>
                    <div className="gap-row">
                      <button className="btn btn-ghost btn-sm" onClick={() => void openEdit(k)} title="Editar"><Pencil size={12} /></button>
                      {k.source === "MANUAL" && k.id !== null && !k.isOverride && (
                        <button
                          className={`btn btn-sm ${deletingId === k.id ? "btn-primary" : "btn-ghost"}`}
                          style={deletingId !== k.id ? { color: "var(--err-text, #f87171)" } : {}}
                          onClick={() => void remove(k.id!)}
                          title={deletingId === k.id ? "Confirmar remoção" : "Remover do catálogo manual"}
                        >
                          {deletingId === k.id ? <Check size={12} /> : <Trash2 size={12} />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CompatSection allKeys={keys} isAdmin={user?.role === "ADMIN"} />

      {/* Modal de edição */}
      {editModal && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
          onClick={e => { if (e.target === e.currentTarget) setEditModal(null); }}
        >
          <div className="card" style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Editar referência</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditModal(null)}><X size={14} /></button>
            </div>

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.82rem", flexWrap: "wrap" }}>
              {editModal.key.source === "MANUAL" && !editModal.key.isOverride
                ? <span className="badge badge-ok">Manual</span>
                : editModal.key.isOverride
                  ? <span className="badge badge-info">Importada (editada)</span>
                  : <span className="badge badge-muted" style={{ fontSize: "0.75rem" }}>Importada — override local preserva valor original</span>}
            </div>

            {editModal.key.isOverride && (editModal.key.originalChavePeca || editModal.key.originalDescricao) && (
              <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "0.6rem 0.85rem", fontSize: "0.82rem" }}>
                <span className="muted">Valor original importado: </span>
                {editModal.key.originalChavePeca && editModal.key.originalChavePeca !== editModal.key.chave_peca && (
                  <span style={{ fontFamily: "monospace", fontWeight: 600, marginRight: "0.5rem" }}>{editModal.key.originalChavePeca}</span>
                )}
                {editModal.key.originalDescricao && (
                  <span className="muted">{editModal.key.originalDescricao}</span>
                )}
              </div>
            )}

            <div className="form-group">
              <label>CHAVEPECA</label>
              <input
                value={editModal.chavePeca}
                onChange={e => setEditModal(prev => prev ? { ...prev, chavePeca: e.target.value.toUpperCase() } : null)}
                autoFocus
              />
              {editModal.chavePeca.trim() !== editModal.key.chave_peca && (
                <p style={{ fontSize: "0.8rem", color: "var(--warn-text)", marginTop: "0.25rem" }}>
                  <RefreshCw size={11} style={{ display: "inline", marginRight: "0.3rem" }} />
                  Renomear acionará reavaliação do motor de match.
                </p>
              )}
            </div>

            {editModal.chavePeca && <DecodedBadge chave={editModal.chavePeca} />}

            <div className="form-group">
              <label>Descrição</label>
              <input
                value={editModal.descricao}
                onChange={e => setEditModal(prev => prev ? { ...prev, descricao: e.target.value } : null)}
                placeholder="Descrição da peça (opcional)"
              />
            </div>

            <div className="form-group">
              <label>Observação / justificativa (opcional)</label>
              <input
                value={editModal.notes}
                onChange={e => setEditModal(prev => prev ? { ...prev, notes: e.target.value } : null)}
                placeholder="Ex: Corrigido nome errado no legado"
              />
            </div>

            <div className="gap-row">
              <button className="btn btn-primary btn-sm" onClick={() => void saveEdit()} disabled={editModal.saving || !editModal.chavePeca.trim()}>
                {editModal.saving ? "Salvando…" : "Salvar"}
              </button>
              {editModal.key.isOverride && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: "var(--warn-text, #fbbf24)" }}
                  onClick={() => void restoreKey()}
                  disabled={editModal.saving}
                  title="Remove o override e volta a exibir o valor importado original"
                >
                  <RotateCcw size={11} /> Restaurar valor importado
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setEditModal(null)}>Cancelar</button>
            </div>

            {/* Histórico */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem", fontSize: "0.85rem", fontWeight: 600 }}>
                <History size={13} /> Histórico de edições
              </div>
              {editModal.historyLoading && <p className="muted small">Carregando…</p>}
              {!editModal.historyLoading && editModal.history.length === 0 && <p className="muted small">Nenhuma edição registrada.</p>}
              {!editModal.historyLoading && editModal.history.map(h => (
                <div key={h.id} style={{ borderLeft: "2px solid var(--border)", paddingLeft: "0.75rem", marginBottom: "0.5rem", fontSize: "0.82rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>{fieldLabel(h.field_changed)}</span>
                    <span className="muted">·</span>
                    <span style={{ color: "var(--err-text, #f87171)", textDecoration: "line-through" }}>{h.old_value ?? "—"}</span>
                    <span className="muted">→</span>
                    <span style={{ color: "var(--ok-text, #4ade80)" }}>{h.new_value ?? "—"}</span>
                  </div>
                  <div className="muted" style={{ marginTop: "0.15rem" }}>
                    {h.edited_at.slice(0, 16).replace("T", " ")}
                    {h.edited_by ? ` · ${h.edited_by}` : ""}
                    {h.notes ? ` — ${h.notes}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
