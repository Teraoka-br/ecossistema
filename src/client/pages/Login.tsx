import { useState } from "react";
import { LogIn, Loader2 } from "lucide-react";
import { useAuth } from "../auth.js";

export function Login() {
  const { refetch } = useAuth();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, pin }),
      });
      if (r.ok) {
        refetch();
      } else {
        const d = await r.json();
        setError(d.error ?? "Erro ao autenticar.");
      }
    } catch {
      setError("Erro de conexão.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page" style={{
      background: "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(99,102,241,0.08) 0%, var(--bg) 70%)",
    }}>
      <div className="auth-card" style={{ boxShadow: "0 0 0 1px var(--border), 0 24px 64px rgba(0,0,0,0.7)" }}>
        {/* Logo area */}
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "linear-gradient(135deg, var(--accent) 0%, #818cf8 100%)",
            margin: "0 auto 1rem",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 16px rgba(99,102,241,0.4)",
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1 style={{ fontSize: "1.5rem", letterSpacing: "-0.04em", marginBottom: "0.3rem" }}>
            Sistema de Peças
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.83rem", margin: 0 }}>
            Outlet do Celular
          </p>
        </div>

        {error && (
          <div style={{
            background: "var(--err-dim)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "var(--r-md)", padding: "0.65rem 1rem", fontSize: "0.8rem",
            color: "var(--err-text)", marginBottom: "1.25rem",
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div>
            <label style={{
              display: "block", fontSize: "0.68rem", fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.08em",
              color: "var(--text-muted)", marginBottom: "0.4rem",
            }}>
              Usuário
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder="seu usuário"
              style={{ fontSize: "0.9rem" }}
            />
          </div>

          <div>
            <label style={{
              display: "block", fontSize: "0.68rem", fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.08em",
              color: "var(--text-muted)", marginBottom: "0.4rem",
            }}>
              PIN
            </label>
            <input
              id="pin"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="current-password"
              placeholder="••••"
              inputMode="numeric"
              style={{ fontSize: "1.1rem", letterSpacing: "0.2em" }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: "100%", justifyContent: "center", marginTop: "0.5rem" }}
            disabled={loading || !username.trim()}
          >
            {loading ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />}
            {loading ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
