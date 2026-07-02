import { useState } from "react";
import { UserPlus } from "lucide-react";
import { useAuth } from "../auth.js";

export function Setup() {
  const { refetch } = useAuth();
  const [form, setForm] = useState({ username: "", displayName: "", pin: "", pin2: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{4,8}$/.test(form.pin)) { setError("PIN deve ter 4–8 dígitos numéricos."); return; }
    if (form.pin !== form.pin2) { setError("PINs não conferem."); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.username, displayName: form.displayName, pin: form.pin }),
      });
      if (r.ok) {
        refetch();
      } else {
        const d = await r.json();
        setError(d.error ?? "Erro ao criar usuário.");
      }
    } catch {
      setError("Erro de conexão.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Primeiro acesso</h1>
        <p className="subtitle">Crie o administrador do sistema</p>
        {error && <div className="alert alert-err">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Nome de exibição</label>
            <input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Ex.: João Silva" autoFocus />
          </div>
          <div className="form-group">
            <label>Nome de usuário</label>
            <input value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="joao" autoComplete="username" />
          </div>
          <div className="form-group">
            <label>PIN (4–8 dígitos)</label>
            <input type="password" value={form.pin} onChange={(e) => set("pin", e.target.value)} inputMode="numeric" placeholder="••••" autoComplete="new-password" />
          </div>
          <div className="form-group">
            <label>Confirmar PIN</label>
            <input type="password" value={form.pin2} onChange={(e) => set("pin2", e.target.value)} inputMode="numeric" placeholder="••••" autoComplete="new-password" />
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={loading}>
            <UserPlus size={15} />
            {loading ? "Criando…" : "Criar administrador"}
          </button>
        </form>
      </div>
    </div>
  );
}
