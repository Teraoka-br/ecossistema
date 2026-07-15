import { useState, useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  Wrench, List, ShoppingCart, Boxes, ScanBarcode,
  Users, Database, Activity, FileInput, LogOut,
  PanelLeftClose, PanelLeftOpen, Stethoscope, Sliders, LayoutDashboard,
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
import { TecnicoFila } from "./pages/TecnicoFila.js";
import { TecnicoHome } from "./pages/TecnicoHome.js";
import { AdminDashboards } from "./pages/AdminDashboards.js";
import { Referencias } from "./pages/Referencias.js";

function LoadingScreen() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "var(--muted)", fontSize: "0.9rem" }}>
      Carregando…
    </div>
  );
}

interface RuntimeInfo { mode: string; databaseFile: string; apiPort: number }

function BetaBanner() {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  useEffect(() => {
    fetch("/api/runtime-info")
      .then((r) => r.ok ? r.json() as Promise<RuntimeInfo> : Promise.reject())
      .then(setInfo)
      .catch(() => { /* silencioso — endpoint pode não existir em versões antigas */ });
  }, []);
  if (!info || info.mode !== "BETA") return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "0.35rem",
      fontSize: "0.7rem", fontWeight: 800, letterSpacing: "0.07em",
      background: "linear-gradient(135deg, rgba(245,158,11,0.2), rgba(245,158,11,0.12))",
      color: "var(--warn-text)",
      border: "1px solid rgba(245,158,11,0.4)",
      borderRadius: "var(--r-sm)", padding: "0.2rem 0.65rem",
      userSelect: "none",
      boxShadow: "0 0 8px rgba(245,158,11,0.15)",
    }}>
      BETA · {info.databaseFile} · :{info.apiPort}
    </span>
  );
}

function UIVersionMarker() {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  useEffect(() => {
    fetch("/api/runtime-info")
      .then((r) => r.ok ? r.json() as Promise<RuntimeInfo> : Promise.reject())
      .then(setInfo)
      .catch(() => {});
  }, []);
  if (!info || info.mode !== "BETA") return null;
  return (
    <div style={{
      position: "fixed", bottom: "1rem", right: "1rem", zIndex: 9999,
      fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.08em",
      color: "rgba(124,58,237,0.5)",
      background: "rgba(124,58,237,0.06)",
      border: "1px solid rgba(124,58,237,0.18)",
      borderRadius: "var(--r-sm)", padding: "0.2rem 0.5rem",
      userSelect: "none", pointerEvents: "none",
    }}>
      UI premium v1
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
  const isTechnician = user.role === "TECHNICIAN";
  const roleLabel = isAdmin ? "Admin" : isTechnician ? "Técnico" : "Operador";

  return (
    <div className="app-shell">
      <UIVersionMarker />
      <header className="topbar">
        <button className="topbar-btn" onClick={() => setSidebarOpen((v) => !v)} title="Recolher menu">
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <span className="topbar-brand">
          <span className="topbar-brand-dot" />
          Sistema de Peças
        </span>
        <BetaBanner />
        <span className="topbar-user">
          <span>{user.displayName}</span>
          <span className="topbar-role">{roleLabel}</span>
          <button className="topbar-btn" onClick={logout} title="Sair">
            <LogOut size={14} />
            Sair
          </button>
        </span>
      </header>

      <div className={`layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
        <nav className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          {isTechnician ? (
            <div className="sidebar-section">
              <div className="sidebar-label">Meu trabalho</div>
              <NavLink to="/inicio" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <LayoutDashboard size={15} /> Início
              </NavLink>
              <NavLink to="/minha-fila" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                <Wrench size={15} /> Minha fila
              </NavLink>
            </div>
          ) : (
            <>
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
                <NavLink to="/estoque" end className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                  <Boxes size={15} /> Estoque
                </NavLink>
                <NavLink to="/estoque/referencias" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`} style={{ paddingLeft: "2rem", fontSize: "0.85rem" }}>
                  Referências de peças
                </NavLink>
                <NavLink to="/bipagem" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                  <ScanBarcode size={15} /> Contagem
                </NavLink>
              </div>

              {isAdmin && (
                <div className="sidebar-section">
                  <div className="sidebar-label">Administração</div>
                  <NavLink to="/admin/dashboards" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                    <LayoutDashboard size={15} /> Dashboards
                  </NavLink>
                  <NavLink to="/admin/dados" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                    <Database size={15} /> Dados
                  </NavLink>
                  <NavLink to="/admin/usuarios" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                    <Users size={15} /> Usuários
                  </NavLink>
                  <NavLink to="/admin/pessoas" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
                    <Users size={15} /> Pessoas / Técnicos
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
            </>
          )}
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to={isTechnician ? "/inicio" : "/fila-reparos"} replace />} />
            <Route path="/inicio" element={<TecnicoHome />} />
            <Route path="/minha-fila" element={<TecnicoFila />} />
            <Route path="/fila-reparos" element={<FilaReparos />} />
            <Route path="/analise" element={<Analise />} />
            <Route path="/importar" element={<Importar />} />
            <Route path="/diagnostico" element={<Diagnostico />} />
            <Route path="/pedidos" element={<Pedidos />} />
            <Route path="/compras" element={<Compras />} />
            <Route path="/bipagem" element={<Bipagem />} />
            <Route path="/estoque" element={<Estoque />} />
            <Route path="/estoque/movimentacoes" element={<Movimentacoes />} />
            <Route path="/estoque/referencias" element={<Referencias />} />
            <Route path="/cotacoes" element={<Cotacoes />} />
            <Route path="/match" element={<Match />} />
            {/* Compatibilidade — /separacao redireciona para a fila */}
            <Route path="/separacao" element={<Navigate to="/fila-reparos" replace />} />
            <Route path="/admin/usuarios" element={<AdminUsuarios />} />
            <Route path="/admin/tecnicos" element={<AdminTecnicos />} />
            <Route path="/admin/pessoas" element={<AdminPessoas />} />
            <Route path="/admin/datasys" element={<AdminDatasys />} />
            <Route path="/admin/dados" element={<AdminDados />} />
            <Route path="/admin/dashboards" element={<AdminDashboards />} />
            <Route path="/admin/regras-match" element={<AdminMatchRules />} />
            <Route path="*" element={<Navigate to={isTechnician ? "/inicio" : "/fila-reparos"} replace />} />
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
              ? <Navigate to={user.role === "TECHNICIAN" ? "/inicio" : "/fila-reparos"} replace />
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
