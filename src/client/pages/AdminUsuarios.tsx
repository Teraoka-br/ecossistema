import { useEffect, useState } from "react";
import { Plus, RotateCcw, UserCheck, UserX, Pencil, ShieldCheck, ShieldOff, Link, Unlink } from "lucide-react";

type Role = "ADMIN" | "OPERATOR" | "TECHNICIAN";

interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: number;
  permissions?: string[];
}

interface Staff {
  id: number;
  name: string;
  type: string;
  active: boolean;
  userId: number | null;
  datasysDeposito: string | null;
}

const ROLE_LABEL: Record<Role, string> = { ADMIN: "Admin", OPERATOR: "Operador", TECHNICIAN: "Técnico" };
const ROLE_BADGE: Record<Role, string> = { ADMIN: "badge-warn", OPERATOR: "badge-muted", TECHNICIAN: "badge-info" };
const PERM_LABELS: Record<string, string> = {
  OVERRIDE_REPAIR_STATUS: "Alterar fase",
  MANAGE_PART_REFERENCES: "Editar referências",
};

export function AdminUsuarios() {
  const [users, setUsers] = useState<User[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // — criar usuário
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [userForm, setUserForm] = useState({ username: "", displayName: "", pin: "", role: "OPERATOR" as Role });

  // — editar usuário
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ displayName: "", role: "OPERATOR" as Role });

  // — reset PIN
  const [resetPinUserId, setResetPinUserId] = useState<number | null>(null);
  const [newPin, setNewPin] = useState("");

  // — criar técnico
  const [showCreateStaff, setShowCreateStaff] = useState(false);
  const [staffName, setStaffName] = useState("");
  const [staffWithUser, setStaffWithUser] = useState(false);
  const [staffUsername, setStaffUsername] = useState("");
  const [staffPin, setStaffPin] = useState("");

  // — vincular conta ao técnico
  const [linkingStaff, setLinkingStaff] = useState<Staff | null>(null);
  const [linkUserId, setLinkUserId] = useState("");

  // — depósito Datasys
  const [editingDeposito, setEditingDeposito] = useState<Staff | null>(null);
  const [depositoValue, setDepositoValue] = useState("");

  async function load() {
    setLoading(true);
    const [ru, rs] = await Promise.all([fetch("/api/auth/users"), fetch("/api/staff")]);
    if (rs.ok) { const d = await rs.json(); setStaff(d.staff); }
    if (ru.ok) {
      const d = await ru.json() as { users: User[] };
      const withPerms = await Promise.all(
        d.users.map(async (u) => {
          const rp = await fetch(`/api/auth/users/${u.id}/permissions`);
          const pd = rp.ok ? await rp.json() as { permissions: string[] } : { permissions: [] };
          return { ...u, permissions: pd.permissions };
        })
      );
      setUsers(withPerms);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // ─── Usuários ───────────────────────────────────────────────────────────────

  async function createUser() {
    setError(null);
    const r = await fetch("/api/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userForm),
    });
    if (r.ok) {
      setMsg("Usuário criado.");
      setShowCreateUser(false);
      setUserForm({ username: "", displayName: "", pin: "", role: "OPERATOR" });
      load();
    } else { const d = await r.json(); setError(d.error); }
  }

  async function saveEditUser() {
    if (!editingUser) return;
    setError(null);
    const r = await fetch(`/api/auth/users/${editingUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm),
    });
    if (r.ok) { setMsg("Usuário atualizado."); setEditingUser(null); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function toggleUserActive(u: User) {
    const r = await fetch(`/api/auth/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !u.active }),
    });
    if (r.ok) load();
    else { const d = await r.json(); setError(d.error); }
  }

  async function doResetPin() {
    if (!resetPinUserId || !newPin) return;
    const r = await fetch(`/api/auth/users/${resetPinUserId}/reset-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: newPin }),
    });
    if (r.ok) { setMsg("PIN redefinido."); setResetPinUserId(null); setNewPin(""); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function togglePermission(u: User, perm: string) {
    const has = u.permissions?.includes(perm) ?? false;
    const r = await fetch(`/api/auth/users/${u.id}/permissions/${perm}`, { method: has ? "DELETE" : "POST" });
    if (r.ok) load();
    else { const d = await r.json(); setError(d.error); }
  }

  // ─── Técnicos ───────────────────────────────────────────────────────────────

  async function createStaff() {
    setError(null);
    const r = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: staffName }),
    });
    if (!r.ok) { const d = await r.json(); setError(d.error); return; }
    const sd = await r.json();

    if (staffWithUser && staffUsername && staffPin) {
      const ru = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: staffUsername, displayName: staffName, pin: staffPin, role: "TECHNICIAN" }),
      });
      if (!ru.ok) { const d = await ru.json(); setError("Técnico criado, mas erro na conta: " + d.error); load(); return; }
      const ud = await ru.json();
      await fetch(`/api/staff/${sd.staff.id}/link-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: ud.user.id }),
      });
    }

    setMsg("Técnico criado.");
    setShowCreateStaff(false); setStaffName(""); setStaffUsername(""); setStaffPin(""); setStaffWithUser(false);
    load();
  }

  async function toggleStaffActive(s: Staff) {
    const r = await fetch(`/api/staff/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !s.active }),
    });
    if (r.ok) load();
    else { const d = await r.json(); setError(d.error); }
  }

  async function doLink() {
    if (!linkingStaff) return;
    setError(null);
    const userId = linkUserId === "" ? null : Number(linkUserId);
    const r = await fetch(`/api/staff/${linkingStaff.id}/link-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (r.ok) { setMsg("Vínculo atualizado."); setLinkingStaff(null); setLinkUserId(""); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function saveDeposito() {
    if (!editingDeposito) return;
    setError(null);
    const r = await fetch(`/api/staff/${editingDeposito.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasysDeposito: depositoValue.trim() || null }),
    });
    if (r.ok) { setMsg("Depósito atualizado."); setEditingDeposito(null); setDepositoValue(""); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  const techUsers = users.filter(u => u.role === "TECHNICIAN");
  const linkedUserIds = new Set(staff.map(s => s.userId).filter(Boolean));
  const getUserLabel = (id: number | null) => {
    if (!id) return null;
    const u = users.find(u => u.id === id);
    return u ? `${u.displayName} (@${u.username})` : `#${id}`;
  };

  return (
    <div>
      <div className="page-header">
        <h1>Pessoas e Usuários</h1>
      </div>

      {msg && <div className="alert alert-ok">{msg}<button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setMsg(null)}>×</button></div>}
      {error && <div className="alert alert-err">{error}<button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setError(null)}>×</button></div>}

      {/* ── Formulários inline ─────────────────────────────────────────── */}

      {showCreateUser && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Criar conta de usuário</h2>
          <div className="form-group"><label>Nome de exibição</label><input value={userForm.displayName} onChange={(e) => setUserForm(f => ({ ...f, displayName: e.target.value }))} autoFocus /></div>
          <div className="form-group"><label>Usuário (login)</label><input value={userForm.username} onChange={(e) => setUserForm(f => ({ ...f, username: e.target.value }))} /></div>
          <div className="form-group"><label>PIN (4–8 dígitos)</label><input type="password" inputMode="numeric" value={userForm.pin} onChange={(e) => setUserForm(f => ({ ...f, pin: e.target.value }))} /></div>
          <div className="form-group">
            <label>Papel</label>
            <select value={userForm.role} onChange={(e) => setUserForm(f => ({ ...f, role: e.target.value as Role }))}>
              <option value="OPERATOR">Operador</option>
              <option value="ADMIN">Administrador</option>
              <option value="TECHNICIAN">Técnico</option>
            </select>
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={createUser}>Criar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowCreateUser(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {editingUser && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Editar — {editingUser.displayName}</h2>
          <div className="form-group"><label>Nome de exibição</label><input value={editForm.displayName} onChange={(e) => setEditForm(f => ({ ...f, displayName: e.target.value }))} autoFocus /></div>
          <div className="form-group">
            <label>Papel</label>
            <select value={editForm.role} onChange={(e) => setEditForm(f => ({ ...f, role: e.target.value as Role }))}>
              <option value="OPERATOR">Operador</option>
              <option value="ADMIN">Administrador</option>
              <option value="TECHNICIAN">Técnico</option>
            </select>
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={saveEditUser}>Salvar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditingUser(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {resetPinUserId && (
        <div className="card" style={{ maxWidth: 320, marginBottom: "1rem" }}>
          <h2>Redefinir PIN</h2>
          <div className="form-group"><label>Novo PIN (4–8 dígitos)</label><input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} autoFocus /></div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={doResetPin}>Confirmar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setResetPinUserId(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {showCreateStaff && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Novo técnico</h2>
          <div className="form-group"><label>Nome do técnico</label><input value={staffName} onChange={(e) => setStaffName(e.target.value)} autoFocus /></div>
          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
              <input type="checkbox" checked={staffWithUser} onChange={e => setStaffWithUser(e.target.checked)} />
              Criar conta de acesso ao sistema
            </label>
          </div>
          {staffWithUser && (
            <>
              <div className="form-group"><label>Usuário (login)</label><input value={staffUsername} onChange={(e) => setStaffUsername(e.target.value)} /></div>
              <div className="form-group"><label>PIN (4–8 dígitos)</label><input type="password" value={staffPin} onChange={(e) => setStaffPin(e.target.value)} maxLength={8} /></div>
            </>
          )}
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={createStaff}>Criar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowCreateStaff(false); setStaffWithUser(false); }}>Cancelar</button>
          </div>
        </div>
      )}

      {linkingStaff && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Vincular conta — {linkingStaff.name}</h2>
          <div className="form-group">
            <label>Conta de usuário (papel Técnico)</label>
            <select value={linkUserId} onChange={e => setLinkUserId(e.target.value)}>
              <option value="">— Remover vínculo —</option>
              {techUsers
                .filter(u => !linkedUserIds.has(u.id) || u.id === linkingStaff.userId)
                .map(u => (
                  <option key={u.id} value={u.id}>{u.displayName} (@{u.username}){!u.active ? " [inativo]" : ""}</option>
                ))}
            </select>
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={doLink}>Salvar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setLinkingStaff(null); setLinkUserId(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {editingDeposito && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Depósito Datasys — {editingDeposito.name}</h2>
          <div className="form-group">
            <label>Nome do depósito no Datasys</label>
            <input value={depositoValue} onChange={e => setDepositoValue(e.target.value)} placeholder="ex: TECNICO 1" autoFocus />
            <span className="muted" style={{ fontSize: "0.78rem" }}>Exatamente como aparece em "Depósito Atual" no Rel. Estoque de Seriais. Deixe em branco para remover.</span>
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={saveDeposito}>Salvar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setEditingDeposito(null); setDepositoValue(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* ── Seção 1: Contas do sistema ─────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Contas do sistema</h2>
        <button className="btn btn-primary btn-sm" onClick={() => { setShowCreateUser(v => !v); setShowCreateStaff(false); }}>
          <Plus size={13} /> Nova conta
        </button>
      </div>

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Usuário</th>
                <th>Papel</th>
                <th>Permissões</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="muted">Carregando…</td></tr>}
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 500 }}>{u.displayName}</td>
                  <td className="mono" style={{ fontSize: "0.85rem" }}>{u.username}</td>
                  <td><span className={`badge ${ROLE_BADGE[u.role] ?? "badge-muted"}`}>{ROLE_LABEL[u.role] ?? u.role}</span></td>
                  <td>
                    {u.role === "ADMIN" ? (
                      <span className="badge badge-warn" title="Admins têm todas as permissões">Todas (Admin)</span>
                    ) : (
                      <div className="gap-row" style={{ flexWrap: "wrap", gap: "4px" }}>
                        {(["OVERRIDE_REPAIR_STATUS", "MANAGE_PART_REFERENCES"] as const).map((perm) => {
                          const has = u.permissions?.includes(perm) ?? false;
                          return (
                            <button
                              key={perm}
                              className={`btn btn-sm ${has ? "btn-primary" : "btn-ghost"}`}
                              onClick={() => togglePermission(u, perm)}
                              title={`${PERM_LABELS[perm]}: ${has ? "clique para revogar" : "clique para conceder"}`}
                              style={{ fontSize: "0.72rem", gap: "3px", padding: "2px 7px" }}
                            >
                              {has ? <ShieldCheck size={11} /> : <ShieldOff size={11} />}
                              {PERM_LABELS[perm]}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td><span className={`badge ${u.active ? "badge-ok" : "badge-err"}`}>{u.active ? "Ativo" : "Inativo"}</span></td>
                  <td>
                    <div className="gap-row">
                      <button className="btn btn-ghost btn-sm" onClick={() => { setEditingUser(u); setEditForm({ displayName: u.displayName, role: u.role }); }} title="Editar"><Pencil size={12} /></button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setResetPinUserId(u.id); setNewPin(""); }} title="Redefinir PIN"><RotateCcw size={12} /></button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleUserActive(u)} title={u.active ? "Desativar" : "Ativar"}>
                        {u.active ? <UserX size={12} /> : <UserCheck size={12} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Seção 2: Técnicos de campo ─────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Técnicos de campo</h2>
        <button className="btn btn-primary btn-sm" onClick={() => { setShowCreateStaff(v => !v); setShowCreateUser(false); }}>
          <Plus size={13} /> Novo técnico
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Status</th>
                <th>Depósito Datasys</th>
                <th>Conta vinculada</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">Carregando…</td></tr>}
              {staff.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td><span className={`badge ${s.active ? "badge-ok" : "badge-err"}`}>{s.active ? "Ativo" : "Inativo"}</span></td>
                  <td>
                    {s.datasysDeposito
                      ? <code style={{ fontSize: "0.8rem" }}>{s.datasysDeposito}</code>
                      : <span className="muted" style={{ fontSize: "0.78rem", fontStyle: "italic" }}>Não configurado</span>}
                  </td>
                  <td>
                    {s.userId
                      ? <span style={{ fontSize: "0.82rem" }}>{getUserLabel(s.userId)}</span>
                      : <span className="muted" style={{ fontSize: "0.78rem", fontStyle: "italic" }}>Sem conta vinculada</span>}
                  </td>
                  <td>
                    <div className="gap-row">
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleStaffActive(s)} title={s.active ? "Desativar" : "Ativar"}>
                        {s.active ? <UserX size={12} /> : <UserCheck size={12} />}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setLinkingStaff(s); setLinkUserId(s.userId ? String(s.userId) : ""); }} title={s.userId ? "Trocar conta" : "Vincular conta"}>
                        {s.userId ? <Unlink size={12} /> : <Link size={12} />}
                        {s.userId ? "Trocar" : "Vincular"}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setEditingDeposito(s); setDepositoValue(s.datasysDeposito ?? ""); }} title="Depósito Datasys">
                        <Pencil size={12} /> Dep.
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
