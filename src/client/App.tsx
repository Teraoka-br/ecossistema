import { useState, useEffect, lazy, Suspense } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  Wrench, List, ShoppingCart, Boxes, ScanBarcode,
  Users, Database, FileInput, LogOut,
  PanelLeftClose, PanelLeftOpen, Stethoscope, Sliders, LayoutDashboard, Tag,
} from "lucide-react";
import { AuthProvider, useAuth } from "./auth.js";
import { BugReportWidget } from "./components/BugReportWidget.js";
import { NotificationBell } from "./components/NotificationBell.js";
// Login e Setup carregam sempre (necessários antes da autenticação)
import { Login } from "./pages/Login.js";
import { Setup } from "./pages/Setup.js";
// Demais páginas: carregamento sob demanda (code splitting por rota)
const Analise       = lazy(() => import("./pages/Analise.js").then(m => ({ default: m.Analise })));
const Importar      = lazy(() => import("./pages/Importar.js").then(m => ({ default: m.Importar })));
const Diagnostico   = lazy(() => import("./pages/Diagnostico.js").then(m => ({ default: m.Diagnostico })));
const Pedidos       = lazy(() => import("./pages/Pedidos.js").then(m => ({ default: m.Pedidos })));
const Estoque       = lazy(() => import("./pages/Estoque.js").then(m => ({ default: m.Estoque })));
const Cotacoes      = lazy(() => import("./pages/Cotacoes.js").then(m => ({ default: m.Cotacoes })));
const Bipagem       = lazy(() => import("./pages/Bipagem.js").then(m => ({ default: m.Bipagem })));
const Compras       = lazy(() => import("./pages/Compras.js").then(m => ({ default: m.Compras })));
const Movimentacoes = lazy(() => import("./pages/Movimentacoes.js").then(m => ({ default: m.Movimentacoes })));
const AdminUsuarios = lazy(() => import("./pages/AdminUsuarios.js").then(m => ({ default: m.AdminUsuarios })));
const AdminDatasys  = lazy(() => import("./pages/AdminDatasys.js").then(m => ({ default: m.AdminDatasys })));
const FilaReparos   = lazy(() => import("./pages/FilaReparos.js").then(m => ({ default: m.FilaReparos })));
const AdminMatchRules = lazy(() => import("./pages/AdminMatchRules.js").then(m => ({ default: m.AdminMatchRules })));
const AdminDados    = lazy(() => import("./pages/AdminDados.js").then(m => ({ default: m.AdminDados })));
const TecnicoFila   = lazy(() => import("./pages/TecnicoFila.js").then(m => ({ default: m.TecnicoFila })));
const TecnicoHome   = lazy(() => import("./pages/TecnicoHome.js").then(m => ({ default: m.TecnicoHome })));
const AdminDashboards = lazy(() => import("./pages/AdminDashboards.js").then(m => ({ default: m.AdminDashboards })));
const Referencias   = lazy(() => import("./pages/Referencias.js").then(m => ({ default: m.Referencias })));

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
  const avatarLetter = (user.displayName ?? user.username ?? "?")[0].toUpperCase();

  const link = (to: string, icon: React.ReactNode, label: string, end?: boolean) => (
    <NavLink
      to={to} end={end}
      title={label}
      className={({ isActive }) => `sidebar-link${isActive ? " active" : ""}`}
    >
      {icon} <span className="nav-text">{label}</span>
    </NavLink>
  );

  return (
    <div className="app-shell">
      <UIVersionMarker />
      <BugReportWidget />

      {/* ── Topbar simplificada ── */}
      <header className="topbar">
        <button className="topbar-btn" onClick={() => setSidebarOpen(v => !v)} title="Recolher menu">
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <span style={{ flex: 1 }} />
        <BetaBanner />
        <NotificationBell role={user.role as "ADMIN" | "OPERATOR" | "TECHNICIAN"} />
        <span className="topbar-user" style={{ gap: "0.4rem" }}>
          <span
            style={{
              width: 28, height: 28, borderRadius: "50%",
              background: "linear-gradient(135deg, #5C7CFA 0%, #3B5BDB 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.7rem", fontWeight: 800, color: "#fff", flexShrink: 0,
            }}
          >
            {avatarLetter}
          </span>
          <span style={{ fontSize: "0.78rem" }}>{user.displayName}</span>
          <button className="topbar-btn" onClick={logout} title="Sair" style={{ padding: "5px 7px" }}>
            <LogOut size={14} />
          </button>
        </span>
      </header>

      <div className={`layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
        <nav className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>

          {/* Brand */}
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">⚙</div>
            <div className="sidebar-brand-text">
              <div className="sidebar-brand-name">Outlet do Celular</div>
              <div className="sidebar-brand-sub">Sistema de Peças</div>
            </div>
          </div>

          {/* Nav */}
          <div className="sidebar-nav">
            {isTechnician ? (
              <div className="sidebar-section">
                <div className="sidebar-label">Meu trabalho</div>
                {link("/inicio",      <LayoutDashboard size={15} />, "Início")}
                {link("/minha-fila", <Wrench size={15} />,           "Minha fila")}
              </div>
            ) : (
              <>
                {isAdmin && (
                  <div className="sidebar-section">
                    <div className="sidebar-label">Visão geral</div>
                    {link("/admin/dashboards", <LayoutDashboard size={15} />, "Central operacional")}
                  </div>
                )}
                <div className="sidebar-section">
                  <div className="sidebar-label">Operação</div>
                  {link("/fila-reparos", <List size={15} />,  "Fila de reparos")}
                  {link("/analise",      <Wrench size={15} />, "Analisar aparelho")}
                </div>
                <div className="sidebar-section">
                  <div className="sidebar-label">Suprimentos</div>
                  {link("/compras",            <ShoppingCart size={15} />, "Pedidos de peças")}
                  {link("/estoque",            <Boxes size={15} />,        "Estoque", true)}
                  {link("/estoque/referencias",<Tag size={14} />,          "Referências")}
                  {link("/bipagem",            <ScanBarcode size={15} />,  "Contagem")}
                </div>
                {isAdmin && (
                  <div className="sidebar-section">
                    <div className="sidebar-label">Admin</div>
                    {link("/admin/dados",       <Database size={15} />,    "Dados")}
                    {link("/admin/usuarios",    <Users size={15} />,       "Usuários")}
                    {link("/admin/regras-match",<Sliders size={15} />,     "Regras do Match")}
                    {link("/diagnostico",       <Stethoscope size={15} />, "Diagnóstico")}
                    {link("/importar",          <FileInput size={15} />,   "Importação")}
                  </div>
                )}
              </>
            )}
          </div>

          {/* User ancorado no fundo */}
          <div className="sidebar-user">
            <div className="sidebar-avatar">{avatarLetter}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user.displayName}</div>
              <div className="sidebar-user-role">{roleLabel}</div>
            </div>
            <button
              className="topbar-btn"
              onClick={logout}
              title="Sair"
              style={{ padding: "5px 6px", flexShrink: 0 }}
            >
              <LogOut size={14} />
            </button>
          </div>
        </nav>

        <main className="main-content">
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<Navigate to={isTechnician ? "/inicio" : isAdmin ? "/admin/dashboards" : "/fila-reparos"} replace />} />
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
              <Route path="/match" element={<Navigate to="/fila-reparos" replace />} />
              <Route path="/separacao" element={<Navigate to="/fila-reparos" replace />} />
              <Route path="/admin/usuarios" element={<AdminUsuarios />} />
              <Route path="/admin/tecnicos" element={<Navigate to="/admin/usuarios" replace />} />
              <Route path="/admin/pessoas" element={<Navigate to="/admin/usuarios" replace />} />
              <Route path="/admin/datasys" element={<AdminDatasys />} />
              <Route path="/admin/dados" element={<AdminDados />} />
              <Route path="/admin/dashboards" element={<AdminDashboards />} />
              <Route path="/admin/regras-match" element={<AdminMatchRules />} />
              <Route path="*" element={<Navigate to={isTechnician ? "/inicio" : isAdmin ? "/admin/dashboards" : "/fila-reparos"} replace />} />
            </Routes>
          </Suspense>
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
              ? <Navigate to={user.role === "TECHNICIAN" ? "/inicio" : user.role === "ADMIN" ? "/admin/dashboards" : "/fila-reparos"} replace />
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
