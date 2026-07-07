import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  Wrench, List, ShoppingCart, Boxes, ScanBarcode,
  Users, Database, Activity, FileInput, LogOut,
  PanelLeftClose, PanelLeftOpen, Stethoscope, Sliders,
} from "lucide-react";
import { AuthProvider, useAuth } from "./auth.js";
import { Login } from "./pages/Login.js";
import { Setup } from "./pages/Setup.js";
import { Analise } from "./pages/Analise.js";
import { Importar } from "./pages/Importar.js";
import { Diagnostico } from "./pages/Diagnostico.js";
import { Pedidos } from "./pages/Pedidos.js";
import { Estoque } from "./pages/Estoque.js";
import { Cotacoes } from "./pages/Cotacoes.js";
import { Bipagem } from "./pages/Bipagem.js";
import { Compras } from "./pages/Compras.js";
import { Movimentacoes } from "./pages/Movimentacoes.js";
import { Match } from "./pages/Match.js";
import { AdminUsuarios } from "./pages/AdminUsuarios.js";
import { AdminTecnicos } from "./pages/AdminTecnicos.js";
import { AdminPessoas } from "./pages/AdminPessoas.js";
import { AdminDatasys } from "./pages/AdminDatasys.js";
import { FilaReparos } from "./pages/FilaReparos.js";
import { AdminMatchRules } from "./pages/AdminMatchRules.js";
import { AdminDados } from "./pages/AdminDados.js";

function LoadingScreen() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "var(--muted)", fontSize: "0.9rem" }}>
      Carregando…
    </div>
  );
}

function AuthenticatedShell() {
  const { user, refetch } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const navigate = useNavigate();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    refetch();
    navigate("/login", { replace: true });
  }

  if (!user) return null;
  const isAdmin = user.role === "ADMIN";

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="topbar-btn" onClick={() => setSidebarOpen((v) => !v)} title="Recolher menu">
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <span className="topbar-brand">
          <span className="topbar-brand-dot" />
          Sistema de Peças
        </span>
        <span className="topbar-user">
          <span>{user.displayName}</span>
          <span className="topbar-role">{isAdmin ? "Admin" : "Operador"}</span>
          <button className="topbar-btn" onClick={logout} title="Sair">
            <LogOut size={14} />
            Sair
          </button>
        </span>
      </header>

      <div className={`layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
        <nav className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          <div className="sidebar-section">
            <div className="sidebar-label">Operação</div>
            <NavLink to="/fila-reparos" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
              <List size={15} /> Fila de reparos
            </NavLink>
            <NavLink to="/analise" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
              <Wrench size={15} /> Analisar aparelho
            </NavLink>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-label">Suprimentos</div>
            <NavLink to="/compras" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
              <ShoppingCart size={15} /> Pedidos de peças
            </NavLink>
            <NavLink to="/estoque" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
              <Boxes size={15} /> Estoque
            </NavLink>
            <NavLink to="/bipagem" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
              <ScanBarcode size={15} /> Contagem
            </NavLink>
          </div>

          {isAdmin && (
            <div className="sidebar-section">
              <div className="sidebar-label">Administração</div>
              <NavLink to="/admin/dados" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <Database size={15} /> Dados
              </NavLink>
              <NavLink to="/admin/pessoas" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <Users size={15} /> Pessoas
              </NavLink>
              <NavLink to="/admin/regras-match" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <Sliders size={15} /> Regras do Match
              </NavLink>
              <NavLink to="/diagnostico" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <Stethoscope size={15} /> Diagnóstico
              </NavLink>
              <NavLink to="/match" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <Activity size={15} /> Auditoria do motor
              </NavLink>
              <NavLink to="/importar" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <FileInput size={15} /> Importação inicial
              </NavLink>
            </div>
          )}
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/fila-reparos" replace />} />
            <Route path="/fila-reparos" element={<FilaReparos />} />
            <Route path="/analise" element={<Analise />} />
            <Route path="/importar" element={<Importar />} />
            <Route path="/diagnostico" element={<Diagnostico />} />
            <Route path="/pedidos" element={<Pedidos />} />
            <Route path="/compras" element={<Compras />} />
            <Route path="/bipagem" element={<Bipagem />} />
            <Route path="/estoque" element={<Estoque />} />
            <Route path="/estoque/movimentacoes" element={<Movimentacoes />} />
            <Route path="/cotacoes" element={<Cotacoes />} />
            <Route path="/match" element={<Match />} />
            {/* Compatibilidade — /separacao redireciona para a fila */}
            <Route path="/separacao" element={<Navigate to="/fila-reparos" replace />} />
            <Route path="/admin/usuarios" element={<AdminUsuarios />} />
            <Route path="/admin/tecnicos" element={<AdminTecnicos />} />
            <Route path="/admin/pessoas" element={<AdminPessoas />} />
            <Route path="/admin/datasys" element={<AdminDatasys />} />
            <Route path="/admin/dados" element={<AdminDados />} />
            <Route path="/admin/regras-match" element={<AdminMatchRules />} />
            <Route path="*" element={<Navigate to="/fila-reparos" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function AppShell() {
  const { user, loading, setupDone } = useAuth();

  if (loading || setupDone === null) return <LoadingScreen />;

  return (
    <Routes>
      <Route
        path="/setup"
        element={!setupDone ? <Setup /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/login"
        element={
          !setupDone
            ? <Navigate to="/setup" replace />
            : user
              ? <Navigate to="/fila-reparos" replace />
              : <Login />
        }
      />
      <Route
        path="/*"
        element={
          !setupDone
            ? <Navigate to="/setup" replace />
            : !user
              ? <Navigate to="/login" replace />
              : <AuthenticatedShell />
        }
      />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
