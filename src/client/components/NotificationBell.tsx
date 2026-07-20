import { useState, useEffect, useRef, useCallback } from "react";
import {
  Bell, Package, AlertTriangle, RefreshCw, Wrench, CheckCheck, X,
  ArrowRight, CheckCircle, XCircle, RotateCcw, Info,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

interface NotifItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  route: string | null;
  createdAt: string;
  isRead: boolean;
}

interface ApiResponse {
  unread: number;
  items: NotifItem[];
}

interface Props {
  role: "ADMIN" | "OPERATOR" | "TECHNICIAN";
}

const TYPE_META: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  CASE_CONCLUDED:  { icon: CheckCircle, color: "var(--ok-text)",   bg: "var(--ok-dim)"   },
  CASE_CLOSED_LOSS:{ icon: XCircle,     color: "var(--err-text)",  bg: "var(--err-dim)"  },
  CASE_VERIFICAR:  { icon: AlertTriangle,color: "var(--warn-text)",bg: "var(--warn-dim)" },
  CASE_RETORNO:    { icon: RotateCcw,   color: "var(--info-text)", bg: "var(--info-dim)" },
  ENGINE_STALE:    { icon: RefreshCw,   color: "var(--warn-text)", bg: "var(--warn-dim)" },
  KITS_PRONTOS:    { icon: Package,     color: "var(--ok-text)",   bg: "var(--ok-dim)"   },
  FILA_TECNICO:    { icon: Wrench,      color: "var(--accent)",    bg: "var(--accent-dim)"},
};

function iconFor(type: string) {
  return TYPE_META[type] ?? { icon: Info, color: "var(--muted)", bg: "var(--hover)" };
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min atrás`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h atrás`;
  return `${Math.floor(h / 24)}d atrás`;
}

export function NotificationBell({ role }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ApiResponse>({ unread: 0, items: [] });
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications");
      if (r.ok) setData(await r.json() as ApiResponse);
    } catch { /* silencioso */ }
  }, []);

  // Polling a cada 45s
  useEffect(() => {
    void load();
    const interval = setInterval(load, 45_000);
    return () => clearInterval(interval);
  }, [load]);

  // Fechar ao clicar fora
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function handleOpen() {
    setOpen(v => {
      if (!v) { setLoading(true); load().finally(() => setLoading(false)); }
      return !v;
    });
  }

  async function markAllRead() {
    await fetch("/api/notifications/read-all", { method: "POST" });
    setData(prev => ({
      unread: 0,
      items: prev.items.map(i => ({ ...i, isRead: true })),
    }));
  }

  async function handleClick(item: NotifItem) {
    if (!item.isRead) {
      await fetch(`/api/notifications/${item.id}/read`, { method: "POST" });
      setData(prev => ({
        unread: Math.max(0, prev.unread - 1),
        items: prev.items.map(i => i.id === item.id ? { ...i, isRead: true } : i),
      }));
    }
    if (item.route) navigate(item.route);
    setOpen(false);
  }

  // Placeholder inline (live stats) para quando não há notificações persistentes
  const liveItems = data.items;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="topbar-btn notif-btn"
        onClick={handleOpen}
        title="Notificações"
        style={{ position: "relative" }}
      >
        <Bell size={15} />
        {data.unread > 0 && (
          <span className="notif-badge">{data.unread > 9 ? "9+" : data.unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-header">
            <span style={{ fontWeight: 700, fontSize: "0.82rem" }}>
              Notificações
              {data.unread > 0 && (
                <span style={{ marginLeft: "0.4rem", fontSize: "0.68rem", color: "var(--accent)", fontWeight: 600 }}>
                  {data.unread} não lida{data.unread !== 1 ? "s" : ""}
                </span>
              )}
            </span>
            <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              {data.unread > 0 && (
                <button className="btn-ghost-sm" onClick={markAllRead} title="Marcar todas como lidas" style={{ fontSize: "0.7rem", padding: "2px 6px" }}>
                  <CheckCheck size={12} /> Lidas
                </button>
              )}
              <button className="btn-ghost-sm" onClick={() => setOpen(false)}>
                <X size={13} />
              </button>
            </div>
          </div>

          {loading ? (
            <div style={{ padding: "1.25rem", textAlign: "center", color: "var(--muted)", fontSize: "0.8rem" }}>
              Carregando…
            </div>
          ) : liveItems.length === 0 ? (
            <div className="notif-empty">
              <CheckCheck size={24} style={{ opacity: 0.3 }} />
              <span>Sem notificações recentes</span>
            </div>
          ) : (
            <div className="notif-list">
              {liveItems.map(item => {
                const meta = iconFor(item.type);
                return (
                  <button
                    key={item.id}
                    className="notif-item"
                    onClick={() => handleClick(item)}
                    style={{ opacity: item.isRead ? 0.65 : 1 }}
                  >
                    <div className="notif-icon" style={{ background: meta.bg, color: meta.color }}>
                      <meta.icon size={14} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      <div style={{
                        fontWeight: item.isRead ? 500 : 700,
                        fontSize: "0.8rem",
                        color: "var(--text)",
                        display: "flex", alignItems: "center", gap: "0.4rem",
                      }}>
                        {!item.isRead && (
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                        )}
                        {item.title}
                      </div>
                      {item.body && (
                        <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: "0.1rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.body}
                        </div>
                      )}
                      <div style={{ fontSize: "0.65rem", color: "var(--dim)", marginTop: "0.2rem" }}>
                        {relativeTime(item.createdAt)}
                      </div>
                    </div>
                    {item.route && (
                      <ArrowRight size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {liveItems.length > 0 && (
            <div style={{
              padding: "0.5rem 1rem",
              borderTop: "1px solid var(--border)",
              fontSize: "0.7rem", color: "var(--dim)", textAlign: "center",
            }}>
              Últimas {liveItems.length} notificações · {role === "ADMIN" ? "todas as categorias" : role === "OPERATOR" ? "fila e estoque" : "sua fila"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
