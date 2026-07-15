import { useEffect, useState, useRef } from "react";
import { Plus, Pencil, Trash2, Search, History, X, Check, RefreshCw, Wand2, Info } from "lucide-react";
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
    const url = k.source === "MANUAL" && k.id !== null
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
        <div className="table-wrap">
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
                      : <span className="badge badge-muted">Importada</span>}
                  </td>
                  <td className="muted small">{k.created_by ?? "—"}</td>
                  <td className="small muted">{k.created_at?.slice(0, 10) ?? "—"}</td>
                  <td>
                    <div className="gap-row">
                      <button className="btn btn-ghost btn-sm" onClick={() => void openEdit(k)} title="Editar"><Pencil size={12} /></button>
                      {k.source === "MANUAL" && k.id !== null && (
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

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.82rem" }}>
              {editModal.key.source === "MANUAL"
                ? <span className="badge badge-ok">Manual</span>
                : <span className="badge badge-muted" style={{ fontSize: "0.75rem" }}>Importada → será promovida a Manual ao salvar</span>}
            </div>

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
