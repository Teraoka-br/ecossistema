import { useEffect, useState } from "react";
import { Plus, UserCheck, UserX } from "lucide-react";

interface Staff {
  id: number;
  name: string;
  type: string;
  active: boolean;
}

export function AdminTecnicos() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/staff");
    if (r.ok) { const d = await r.json(); setStaff(d.staff); }
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
    if (r.ok) { setMsg("Técnico criado."); setShowCreate(false); setName(""); load(); }
    else { const d = await r.json(); setError(d.error); }
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
        <div className="card" style={{ maxWidth: 380 }}>
          <div className="form-group"><label>Nome</label><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="gap-row">
            <button className="btn btn-primary btn-sm" onClick={create}>Criar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Tipo</th><th>Status</th><th>Ação</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="muted">Carregando…</td></tr>}
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td><span className="badge badge-muted">{s.type}</span></td>
                  <td><span className={`badge ${s.active ? "badge-ok" : "badge-err"}`}>{s.active ? "Ativo" : "Inativo"}</span></td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggle(s)} title={s.active ? "Desativar" : "Ativar"}>
                      {s.active ? <UserX size={12} /> : <UserCheck size={12} />}
                      {s.active ? "Desativar" : "Ativar"}
                    </button>
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
