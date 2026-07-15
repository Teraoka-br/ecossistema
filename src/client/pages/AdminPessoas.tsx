import { useEffect, useState } from "react";
import { Plus, RotateCcw, UserCheck, UserX, Trash2, Pencil } from "lucide-react";

type UserRole = "ADMIN" | "OPERATOR" | "TECHNICIAN";

interface User {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  active: number;
}

interface StaffMember {
  id: number;
  userId: number | null;
  datasysDeposito: string | null;
}

const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: "Admin",
  OPERATOR: "Operador",
  TECHNICIAN: "Técnico",
};

const ROLE_BADGE: Record<UserRole, string> = {
  ADMIN: "badge-warn",
  OPERATOR: "badge-muted",
  TECHNICIAN: "badge-info",
};

const emptyForm = { username: "", displayName: "", pin: "", role: "OPERATOR" as UserRole };

export function AdminPessoas() {
  const [users, setUsers] = useState<User[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [resetPinUser, setResetPinUser] = useState<User | null>(null);
  const [newPin, setNewPin] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);
  const [editingDeposito, setEditingDeposito] = useState<User | null>(null);
  const [depositoValue, setDepositoValue] = useState("");

  async function load() {
    setLoading(true);
    const [ru, rs] = await Promise.all([fetch("/api/auth/users"), fetch("/api/staff")]);
    if (ru.ok) { const d = await ru.json(); setUsers(d.users); }
    if (rs.ok) { const d = await rs.json(); setStaff(d.staff); }
    setLoading(false);
  }

  function staffFor(userId: number): StaffMember | undefined {
    return staff.find(s => s.userId === userId);
  }

  useEffect(() => { load(); }, []);

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(null), 4000); }

  async function createUser() {
    setError(null);
    const r = await fetch("/api/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (r.ok) {
      flash(`Usuário "${form.displayName}" criado.`);
      setShowCreate(false);
      setForm(emptyForm);
      load();
    } else {
      const d = await r.json();
      setError(d.error);
    }
  }

  async function toggleActive(u: User) {
    setError(null);
    const r = await fetch(`/api/auth/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !u.active }),
    });
    if (r.ok) load();
    else { const d = await r.json(); setError(d.error); }
  }

  async function doResetPin() {
    if (!resetPinUser || !newPin) return;
    setError(null);
    const r = await fetch(`/api/auth/users/${resetPinUser.id}/reset-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: newPin }),
    });
    if (r.ok) { flash("PIN redefinido."); setResetPinUser(null); setNewPin(""); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function saveDeposito() {
    if (!editingDeposito) return;
    setError(null);
    const sm = staffFor(editingDeposito.id);
    if (!sm) { setError("Registro de técnico não encontrado."); return; }
    const r = await fetch(`/api/staff/${sm.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasysDeposito: depositoValue.trim() || null }),
    });
    if (r.ok) { flash("Depósito atualizado."); setEditingDeposito(null); setDepositoValue(""); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setError(null);
    const r = await fetch(`/api/auth/users/${confirmDelete.id}`, { method: "DELETE" });
    if (r.ok) { flash(`Usuário "${confirmDelete.displayName}" excluído.`); setConfirmDelete(null); load(); }
    else { const d = await r.json(); setError(d.error); setConfirmDelete(null); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Pessoas</h1>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => { setShowCreate((v) => !v); setError(null); }}>
          <Plus size={13} /> Novo usuário
        </button>
      </div>

      {msg && <div className="alert alert-ok">{msg}</div>}
      {error && <div className="alert alert-err">{error}</div>}

      {showCreate && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Criar usuário</h2>
          <div className="form-group">
            <label>Nome de exibição</label>
            <input value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} autoFocus />
          </div>
          <div className="form-group">
            <label>Usuário (login)</label>
            <input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
          </div>
          <div className="form-group">
            <label>PIN (4–8 dígitos)</label>
            <input type="password" inputMode="numeric" value={form.pin} onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))} />
          </div>
          <div className="form-group">
            <label>Papel</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))}>
              <option value="OPERATOR">Operador</option>
              <option value="TECHNICIAN">Técnico</option>
              <option value="ADMIN">Administrador</option>
            </select>
          </div>
          {form.role === "TECHNICIAN" && (
            <div className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.75rem" }}>
              O técnico será automaticamente adicionado à lista de despacho de reparos.
            </div>
          )}
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={createUser}>Criar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowCreate(false); setForm(emptyForm); }}>Cancelar</button>
          </div>
        </div>
      )}

      {editingDeposito && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Depósito Datasys — {editingDeposito.displayName}</h2>
          <div className="form-group">
            <label>Nome do depósito no Datasys</label>
            <input
              value={depositoValue}
              onChange={e => setDepositoValue(e.target.value)}
              placeholder="ex: TECNICO 1"
              autoFocus
            />
            <span className="muted" style={{ fontSize: "0.78rem" }}>
              Exatamente como aparece no campo "Depósito Atual" do Rel. Estoque de Seriais. Deixe em branco para remover.
            </span>
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={saveDeposito}>Salvar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditingDeposito(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {resetPinUser && (
        <div className="card" style={{ maxWidth: 340, marginBottom: "1rem" }}>
          <h2>Redefinir PIN — {resetPinUser.displayName}</h2>
          <div className="form-group">
            <label>Novo PIN (4–8 dígitos)</label>
            <input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} autoFocus />
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={doResetPin}>Confirmar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setResetPinUser(null); setNewPin(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="card" style={{ maxWidth: 380, marginBottom: "1rem", border: "1px solid var(--err-border)" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Excluir "{confirmDelete.displayName}"?</div>
          <div className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.75rem" }}>
            Esta ação é permanente. Sessões ativas serão encerradas.
          </div>
          <div className="gap-row">
            <button className="btn btn-sm" style={{ background: "var(--err-dim)", color: "var(--err-text)", border: "1px solid var(--err-border)" }} onClick={doDelete}>Excluir</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Usuário</th>
                <th>Papel</th>
                <th>Depósito Datasys</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="muted">Carregando…</td></tr>}
              {!loading && users.length === 0 && <tr><td colSpan={6} className="muted">Nenhum usuário.</td></tr>}
              {users.map((u) => {
                const sm = staffFor(u.id);
                return (
                <tr key={u.id}>
                  <td style={{ fontWeight: 500 }}>{u.displayName}</td>
                  <td className="mono" style={{ fontSize: "0.85rem" }}>{u.username}</td>
                  <td>
                    <span className={`badge ${ROLE_BADGE[u.role]}`}>{ROLE_LABEL[u.role]}</span>
                  </td>
                  <td>
                    {u.role === "TECHNICIAN"
                      ? sm?.datasysDeposito
                        ? <code style={{ fontSize: "0.8rem" }}>{sm.datasysDeposito}</code>
                        : <span className="muted" style={{ fontSize: "0.78rem", fontStyle: "italic" }}>Não configurado</span>
                      : <span className="muted">—</span>
                    }
                  </td>
                  <td>
                    <span className={`badge ${u.active ? "badge-ok" : "badge-err"}`}>
                      {u.active ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td>
                    <div className="gap-row">
                      {u.role === "TECHNICIAN" && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => { setEditingDeposito(u); setDepositoValue(sm?.datasysDeposito ?? ""); }}
                          title="Configurar depósito Datasys"
                        >
                          <Pencil size={12} /> Depósito
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setResetPinUser(u); setNewPin(""); }}
                        title="Redefinir PIN"
                      >
                        <RotateCcw size={12} />
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => toggleActive(u)}
                        title={u.active ? "Desativar" : "Ativar"}
                      >
                        {u.active ? <UserX size={12} /> : <UserCheck size={12} />}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setConfirmDelete(u)}
                        title="Excluir usuário"
                        style={{ color: "var(--err-text)" }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
