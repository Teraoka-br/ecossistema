import { useEffect, useState } from "react";
import { Plus, RotateCcw, UserCheck, UserX } from "lucide-react";

interface User {
  id: number;
  username: string;
  displayName: string;
  role: "ADMIN" | "OPERATOR" | "TECHNICIAN";
  active: number;
}

export function AdminUsuarios() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", pin: "", role: "OPERATOR" as "ADMIN" | "OPERATOR" | "TECHNICIAN" });
  const [resetPinUser, setResetPinUser] = useState<number | null>(null);
  const [newPin, setNewPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/auth/users");
    if (r.ok) { const d = await r.json(); setUsers(d.users); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

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
    if (r.ok) { load(); }
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
          <div className="form-group"><label>Usuário</label><input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></div>
          <div className="form-group"><label>PIN (4–8 dígitos)</label><input type="password" inputMode="numeric" value={form.pin} onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))} /></div>
          <div className="form-group">
            <label>Papel</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as any }))}>
              <option value="OPERATOR">Operador</option>
              <option value="ADMIN">Administrador</option>
              <option value="TECHNICIAN">Técnico</option>
            </select>
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
          <div className="form-group"><label>Novo PIN (4–8 dígitos)</label><input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} /></div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={doResetPin}>Confirmar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setResetPinUser(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Usuário</th><th>Papel</th><th>Status</th><th>Ações</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">Carregando…</td></tr>}
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td className="mono">{u.username}</td>
                  <td><span className={`badge ${u.role === "ADMIN" ? "badge-warn" : u.role === "TECHNICIAN" ? "badge-info" : "badge-muted"}`}>{u.role === "TECHNICIAN" ? "TÉCNICO" : u.role}</span></td>
                  <td><span className={`badge ${u.active ? "badge-ok" : "badge-err"}`}>{u.active ? "Ativo" : "Inativo"}</span></td>
                  <td>
                    <div className="gap-row">
                      <button className="btn btn-ghost btn-sm" onClick={() => { setResetPinUser(u.id); setNewPin(""); }} title="Redefinir PIN"><RotateCcw size={12} /></button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(u)} title={u.active ? "Desativar" : "Ativar"}>
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
    </div>
  );
}
