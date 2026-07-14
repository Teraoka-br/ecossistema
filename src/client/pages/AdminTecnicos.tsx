import { useEffect, useState } from "react";
import { Plus, UserCheck, UserX, Link, Unlink } from "lucide-react";

interface Staff {
  id: number;
  name: string;
  type: string;
  active: boolean;
  userId: number | null;
}

interface User {
  id: number;
  username: string;
  displayName: string;
  role: string;
  active: number;
}

export function AdminTecnicos() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<Staff | null>(null);
  const [linkUserId, setLinkUserId] = useState<string>("");
  const [createWithUser, setCreateWithUser] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPin, setNewPin] = useState("");

  async function load() {
    setLoading(true);
    const [rs, ru] = await Promise.all([fetch("/api/staff"), fetch("/api/auth/users")]);
    if (rs.ok) { const d = await rs.json(); setStaff(d.staff); }
    if (ru.ok) { const d = await ru.json(); setUsers(d.users); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function create() {
    setError(null);
    const r = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) { const d = await r.json(); setError(d.error); return; }
    const staffData = await r.json();

    if (createWithUser && newUsername && newPin) {
      const ru = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername, displayName: name, pin: newPin, role: "TECHNICIAN" }),
      });
      if (!ru.ok) { const d = await ru.json(); setError("Técnico criado, mas erro ao criar usuário: " + d.error); load(); return; }
      const userData = await ru.json();
      await fetch(`/api/staff/${staffData.staff.id}/link-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: userData.user.id }),
      });
    }

    setMsg("Técnico criado com sucesso.");
    setShowCreate(false); setName(""); setNewUsername(""); setNewPin(""); setCreateWithUser(false);
    load();
  }

  async function toggle(s: Staff) {
    const r = await fetch(`/api/staff/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !s.active }),
    });
    if (r.ok) load();
    else { const d = await r.json(); setError(d.error); }
  }

  async function doLink() {
    if (!linking) return;
    setError(null);
    const userId = linkUserId === "" ? null : Number(linkUserId);
    const r = await fetch(`/api/staff/${linking.id}/link-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (r.ok) { setMsg("Vínculo atualizado."); setLinking(null); setLinkUserId(""); load(); }
    else { const d = await r.json(); setError(d.error); }
  }

  const techUsers = users.filter(u => u.role === "TECHNICIAN");
  const linkedUserIds = new Set(staff.map(s => s.userId).filter(Boolean));

  const getUserName = (id: number | null) => {
    if (!id) return null;
    const u = users.find(u => u.id === id);
    return u ? `${u.displayName} (@${u.username})` : `#${id}`;
  };

  return (
    <div>
      <div className="page-header">
        <h1>Técnicos</h1>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={13} /> Novo técnico
        </button>
      </div>

      {msg && <div className="alert alert-ok">{msg}</div>}
      {error && <div className="alert alert-err">{error}</div>}

      {showCreate && (
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="form-group"><label>Nome do técnico</label><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>

          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
              <input type="checkbox" checked={createWithUser} onChange={e => setCreateWithUser(e.target.checked)} />
              Criar conta de acesso ao sistema
            </label>
          </div>

          {createWithUser && (
            <>
              <div className="form-group"><label>Usuário (login)</label><input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="ex: joao.silva" /></div>
              <div className="form-group"><label>PIN (4–8 dígitos)</label><input type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)} placeholder="ex: 1234" maxLength={8} /></div>
            </>
          )}

          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={create}>Criar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowCreate(false); setCreateWithUser(false); }}>Cancelar</button>
          </div>
        </div>
      )}

      {linking && (
        <div className="card" style={{ maxWidth: 420, marginBottom: "1rem" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.75rem" }}>Vincular conta — {linking.name}</div>
          <div className="form-group">
            <label>Conta de usuário (role Técnico)</label>
            <select value={linkUserId} onChange={e => setLinkUserId(e.target.value)}>
              <option value="">— Remover vínculo —</option>
              {techUsers
                .filter(u => !linkedUserIds.has(u.id) || u.id === linking.userId)
                .map(u => (
                  <option key={u.id} value={u.id}>{u.displayName} (@{u.username}){!u.active ? " [inativo]" : ""}</option>
                ))
              }
            </select>
          </div>
          {techUsers.filter(u => !linkedUserIds.has(u.id) || u.id === linking.userId).length === 0 && (
            <div className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.75rem" }}>
              Não há usuários com role Técnico disponíveis. Crie um em Usuários primeiro, ou use "Novo técnico" com a opção de criar conta.
            </div>
          )}
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={doLink}>Salvar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setLinking(null); setLinkUserId(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Status</th><th>Conta de acesso</th><th>Ações</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="muted">Carregando…</td></tr>}
              {staff.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td><span className={`badge ${s.active ? "badge-ok" : "badge-err"}`}>{s.active ? "Ativo" : "Inativo"}</span></td>
                  <td>
                    {s.userId
                      ? <span className="muted" style={{ fontSize: "0.82rem" }}>{getUserName(s.userId)}</span>
                      : <span className="muted" style={{ fontSize: "0.78rem", fontStyle: "italic" }}>Sem conta vinculada</span>
                    }
                  </td>
                  <td>
                    <div className="gap-row">
                      <button className="btn btn-ghost btn-sm" onClick={() => toggle(s)} title={s.active ? "Desativar" : "Ativar"}>
                        {s.active ? <UserX size={12} /> : <UserCheck size={12} />}
                        {s.active ? "Desativar" : "Ativar"}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setLinking(s); setLinkUserId(s.userId ? String(s.userId) : ""); }} title="Vincular conta">
                        {s.userId ? <Unlink size={12} /> : <Link size={12} />}
                        {s.userId ? "Trocar conta" : "Vincular conta"}
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
