import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Importar } from "./pages/Importar.js";
import { Diagnostico } from "./pages/Diagnostico.js";
import { Pedidos } from "./pages/Pedidos.js";
import { Estoque } from "./pages/Estoque.js";
import { Cotacoes } from "./pages/Cotacoes.js";
import { Bipagem } from "./pages/Bipagem.js";
import { Compras } from "./pages/Compras.js";
import { Movimentacoes } from "./pages/Movimentacoes.js";
import { Match } from "./pages/Match.js";
import { Separacao } from "./pages/Separacao.js";

const links = [
  { to: "/importar", label: "Importar" },
  { to: "/diagnostico", label: "Diagnóstico" },
  { to: "/pedidos", label: "Pedidos" },
  { to: "/compras", label: "Compras" },
  { to: "/bipagem", label: "Bipagem" },
  { to: "/estoque", label: "Estoque" },
  { to: "/cotacoes", label: "Cotações" },
  { to: "/match", label: "MATCH" },
  { to: "/separacao", label: "SEPARAÇÃO" },
];

function RootRedirect() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/separation-batches?status=OPEN&limit=1")
      .then((r) => r.json())
      .then((d: { total?: number }) => {
        setTarget(d.total && d.total > 0 ? "/separacao" : "/match");
      })
      .catch(() => setTarget("/match"));
  }, []);

  if (!target) return null;
  return <Navigate to={target} replace />;
}

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">📱 Sistema de Peças</span>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {l.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/importar" element={<Importar />} />
          <Route path="/diagnostico" element={<Diagnostico />} />
          <Route path="/pedidos" element={<Pedidos />} />
          <Route path="/compras" element={<Compras />} />
          <Route path="/bipagem" element={<Bipagem />} />
          <Route path="/estoque" element={<Estoque />} />
          <Route path="/estoque/movimentacoes" element={<Movimentacoes />} />
          <Route path="/cotacoes" element={<Cotacoes />} />
          <Route path="/match" element={<Match />} />
          <Route path="/separacao" element={<Separacao />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
