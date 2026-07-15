import { useEffect, useState } from "react";
import { Plus, RotateCcw, UserCheck, UserX, Pencil, ShieldCheck } from "lucide-react";

interface User {
  id: number;
  username: string;
  displayName: string;
  role: "ADMIN" | "OPERATOR" | "TECHNICIAN";
  active: number;
  permissions?: string[];
}

interface StaffMember {
  id: number;
  name: string;
  userId: number | null;
  datasysDeposito: string | null;
}

const ROLE_LABEL: Record<string, string> = { ADMIN: "Admin", OPERATOR: "Operador", TECHNICIAN: "Técnico" };
const ROLE_BADGE: Record<string, string> = { ADMIN: "badge-warn", OPERATOR: "badge-muted", TECHNICIAN: "badge-info" };

export function AdminUsuarios() {
  const [users, setUsers] = useState<User[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", pin: "", role: "OPERATOR" as "ADMIN" | "OPERATOR" | "TECHNICIAN" });
  const [resetPinUser, setResetPinUser] = useState<number | null>(null);
  const [newPin, setNewPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // edição de depósito
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [depositoValue, setDepositoValue] = useState("");

  async function load() {
    setLoading(true);
    const [ru, rs] = await Promise.all([fetch("/api/auth/users"), fetch("/api/staff")]);
    if (rs.ok) { const d = await rs.json(); setStaff(d.staff); }
    if (ru.ok) {
      const d = await ru.json() as { users: User[] };
      const usersWithPerms = await Promise.all(
        d.users.map(async (u) => {
          const rp = await fetch(`/api/auth/users/${u.id}/permissions`);
          const pd = rp.ok ? await rp.json() as { permissions: string[] } : { permissions: [] };
          return { ...u, permissions: pd.permissions };
        })
      );
      setUsers(usersWithPerms);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function staffFor(userId: number): StaffMember | undefined {
    return staff.find(s => s.userId === userId);
  }

  async function createUser() {
    setError(null);
    const r = await fetch("/api/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (r.ok) { setMsg("Usuário criado."); setShowCreate(false); setForm({ username: "", displayName: "", pin: "", role: "OPERATOR" as const }); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function toggleActive(u: User) {
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
    const r = await fetch(`/api/auth/users/${resetPinUser}/reset-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: newPin }),
    });
    if (r.ok) { setMsg("PIN redefinido."); setResetPinUser(null); setNewPin(""); }
    else { const d = await r.json(); setError(d.error); }
  }

  async function togglePermission(u: User, perm: string) {
    const has = u.permissions?.includes(perm) ?? false;
    const method = has ? "DELETE" : "POST";
    const r = await fetch(`/api/auth/users/${u.id}/permissions/${perm}`, { method });
    if (r.ok) load();
    else { const d = await r.json(); setError(d.error); }
  }

  async function saveDeposito() {
    if (!editingUser) return;
    setError(null);
    const sm = staffFor(editingUser.id);
    if (!sm) { setError("Técnico não encontrado na lista de despacho. Vincule-o em Administração → Técnicos."); return; }
    const r = await fetch(`/api/staff/${sm.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasysDeposito: depositoValue.trim() || null }),
    });
    if (r.ok) { setMsg("Depósito atualizado."); setEditingUser(null); setDepositoValue(""); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Usuários</h1>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={13} /> Novo usuário
        </button>
      </div>

      {msg && <div className="alert alert-ok">{msg}</div>}
      {error && <div className="alert alert-err">{error}</div>}

      {showCreate && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Criar usuário</h2>
          <div className="form-group"><label>Nome de exibição</label><input value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} /></div>
          <div className="form-group"><label>Usuário (login)</label><input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></div>
          <div className="form-group"><label>PIN (4–8 dígitos)</label><input type="password" inputMode="numeric" value={form.pin} onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))} /></div>
          <div className="form-group">
            <label>Papel</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "ADMIN" | "OPERATOR" | "TECHNICIAN" }))}>
              <option value="OPERATOR">Operador</option>
              <option value="ADMIN">Administrador</option>
              <option value="TECHNICIAN">Técnico</option>
            </select>
            {form.role === "TECHNICIAN" && (
              <span className="muted" style={{ fontSize: "0.78rem" }}>O técnico será automaticamente adicionado à lista de despacho de reparos.</span>
            )}
          </div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={createUser}>Criar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {resetPinUser && (
        <div className="card" style={{ maxWidth: 320, marginBottom: "1rem" }}>
          <h2>Redefinir PIN — usuário #{resetPinUser}</h2>
          <div className="form-group"><label>Novo PIN (4–8 dígitos)</label><input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} autoFocus /></div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={doResetPin}>Confirmar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setResetPinUser(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {editingUser && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <h2>Depósito Datasys — {editingUser.displayName}</h2>
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
            <button className="btn btn-ghost btn-sm" onClick={() => setEditingUser(null)}>Cancelar</button>
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
                <th>Alterar fase</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="muted">Carregando…</td></tr>}
              {users.map((u) => {
                const sm = staffFor(u.id);
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 500 }}>{u.displayName}</td>
                    <td className="mono" style={{ fontSize: "0.85rem" }}>{u.username}</td>
                    <td><span className={`badge ${ROLE_BADGE[u.role] ?? "badge-muted"}`}>{ROLE_LABEL[u.role] ?? u.role}</span></td>
                    <td>
                      {u.role === "TECHNICIAN" ? (
                        sm?.datasysDeposito
                          ? <code style={{ fontSize: "0.8rem" }}>{sm.datasysDeposito}</code>
                          : <span className="muted" style={{ fontSize: "0.78rem", fontStyle: "italic" }}>Não configurado</span>
                      ) : (
                        <span className="muted" style={{ fontSize: "0.78rem" }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {u.role === "ADMIN" ? (
                        <span className="badge badge-warn" title="Admins têm todas as permissões">Admin</span>
                      ) : (
                        <button
                          className={`btn btn-sm ${u.permissions?.includes("OVERRIDE_REPAIR_STATUS") ? "btn-primary" : "btn-ghost"}`}
                          onClick={() => togglePermission(u, "OVERRIDE_REPAIR_STATUS")}
                          title={u.permissions?.includes("OVERRIDE_REPAIR_STATUS") ? "Clique para revogar" : "Clique para conceder"}
                          style={{ fontSize: "0.75rem", gap: "4px" }}
                        >
                          <ShieldCheck size={12} />
                          {u.permissions?.includes("OVERRIDE_REPAIR_STATUS") ? "Sim" : "Não"}
                        </button>
                      )}
                    </td>
                    <td><span className={`badge ${u.active ? "badge-ok" : "badge-err"}`}>{u.active ? "Ativo" : "Inativo"}</span></td>
                    <td>
                      <div className="gap-row">
                        {u.role === "TECHNICIAN" && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => { setEditingUser(u); setDepositoValue(sm?.datasysDeposito ?? ""); }}
                            title="Configurar depósito Datasys"
                          >
                            <Pencil size={12} /> Depósito
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => { setResetPinUser(u.id); setNewPin(""); }} title="Redefinir PIN"><RotateCcw size={12} /></button>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(u)} title={u.active ? "Desativar" : "Ativar"}>
                          {u.active ? <UserX size={12} /> : <UserCheck size={12} />}
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
