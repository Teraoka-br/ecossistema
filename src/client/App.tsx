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

const links = [
  { to: "/importar", label: "Importar" },
  { to: "/diagnostico", label: "Diagnóstico" },
  { to: "/pedidos", label: "Pedidos" },
  { to: "/compras", label: "Compras" },
  { to: "/bipagem", label: "Bipagem" },
  { to: "/estoque", label: "Estoque" },
  { to: "/cotacoes", label: "Cotações" },
  { to: "/match", label: "MATCH" },
];

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
          <Route path="/" element={<Navigate to="/importar" replace />} />
          <Route path="/importar" element={<Importar />} />
          <Route path="/diagnostico" element={<Diagnostico />} />
          <Route path="/pedidos" element={<Pedidos />} />
          <Route path="/compras" element={<Compras />} />
          <Route path="/bipagem" element={<Bipagem />} />
          <Route path="/estoque" element={<Estoque />} />
          <Route path="/estoque/movimentacoes" element={<Movimentacoes />} />
          <Route path="/cotacoes" element={<Cotacoes />} />
          <Route path="/match" element={<Match />} />
          <Route path="*" element={<Navigate to="/importar" replace />} />
        </Routes>
      </main>
    </div>
  );
}
