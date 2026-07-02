import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  Wrench, List, PackageSearch, ShoppingCart, Boxes, ScanBarcode,
  Users, UserCog, Database, Puzzle, Stethoscope,
  Activity, FileInput, LogOut, PanelLeftClose, PanelLeftOpen,
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
import { Separacao } from "./pages/Separacao.js";
import { AdminUsuarios } from "./pages/AdminUsuarios.js";
import { AdminTecnicos } from "./pages/AdminTecnicos.js";
import { AdminDatasys } from "./pages/AdminDatasys.js";

interface SidebarGroup {
  label: string;
  items: { to: string; icon: React.ReactNode; label: string }[];
}

const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    label: "Operação",
    items: [
      { to: "/analise", icon: <Wrench size={15} />, label: "Analisar aparelho" },
      { to: "/pedidos", icon: <List size={15} />, label: "Fila de reparos" },
      { to: "/separacao", icon: <PackageSearch size={15} />, label: "Separação" },
    ],
  },
  {
    label: "Suprimentos",
    items: [
      { to: "/compras", icon: <ShoppingCart size={15} />, label: "Pedidos de peças" },
      { to: "/estoque", icon: <Boxes size={15} />, label: "Estoque" },
      { to: "/bipagem", icon: <ScanBarcode size={15} />, label: "Contagem" },
    ],
  },
  {
    label: "Administração",
    items: [
      { to: "/admin/usuarios", icon: <Users size={15} />, label: "Usuários" },
      { to: "/admin/tecnicos", icon: <UserCog size={15} />, label: "Técnicos" },
      { to: "/admin/datasys", icon: <Database size={15} />, label: "Dados do Datasys" },
      { to: "/cotacoes", icon: <Puzzle size={15} />, label: "Peças e referências" },
      { to: "/diagnostico", icon: <Stethoscope size={15} />, label: "Diagnóstico" },
      { to: "/match", icon: <Activity size={15} />, label: "Auditoria do motor" },
      { to: "/importar", icon: <FileInput size={15} />, label: "Importação inicial" },
    ],
  },
];

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="topbar-btn" onClick={() => setSidebarOpen((v) => !v)} title="Recolher menu">
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <span className="topbar-brand">Sistema de Peças</span>
        <span className="topbar-user">
          <span>{user.displayName}</span>
          <span className="topbar-role">{user.role === "ADMIN" ? "Admin" : "Operador"}</span>
          <button className="topbar-btn" onClick={logout} title="Sair">
            <LogOut size={14} />
            Sair
          </button>
        </span>
      </header>

      <div className={`layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
        <nav className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          {SIDEBAR_GROUPS.map((group) => (
            <div key={group.label} className="sidebar-section">
              <div className="sidebar-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to + item.label}
                  to={item.to}
                  className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/analise" replace />} />
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
            <Route path="/separacao" element={<Separacao />} />
            <Route path="/admin/usuarios" element={<AdminUsuarios />} />
            <Route path="/admin/tecnicos" element={<AdminTecnicos />} />
            <Route path="/admin/datasys" element={<AdminDatasys />} />
            <Route path="*" element={<Navigate to="/analise" replace />} />
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
      {/* /setup: mostra setup somente quando não há usuários; caso contrário redireciona */}
      <Route
        path="/setup"
        element={!setupDone ? <Setup /> : <Navigate to="/login" replace />}
      />
      {/* /login: mostra login quando há usuários e não há sessão; caso contrário redireciona */}
      <Route
        path="/login"
        element={
          !setupDone
            ? <Navigate to="/setup" replace />
            : user
              ? <Navigate to="/analise" replace />
              : <Login />
        }
      />
      {/* Todas as demais rotas requerem sessão válida */}
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
