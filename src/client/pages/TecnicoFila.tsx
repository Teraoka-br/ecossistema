import { useEffect, useState, useCallback } from "react";
import { Play, CheckCircle, Clock, AlertCircle } from "lucide-react";

interface RepairCase {
  id: number;
  imei: string | null;
  os: string | null;
  datasys_last_os: string | null;
  brand: string | null;
  model: string | null;
  color: string | null;
  workflow_status: string;
  repair_started_at: string | null;
  repair_completed_at: string | null;
  directed_at: string | null;
  total_parts: number;
  matched_parts: number;
  notes: string | null;
}

interface StaffMember {
  id: number;
  name: string;
}

const STATUS_LABEL: Record<string, string> = {
  DIRECIONADO_TECNICO: "Aguardando início",
  EM_REPARO: "Em reparo",
  REPARO_EXECUTADO: "Reparo concluído",
  TRIAGEM_FINAL: "Triagem final",
  RETORNO_TECNICO: "Retorno técnico",
};

const STATUS_BADGE: Record<string, string> = {
  DIRECIONADO_TECNICO: "badge-warn",
  EM_REPARO: "badge-info",
  REPARO_EXECUTADO: "badge-ok",
  TRIAGEM_FINAL: "badge-muted",
  RETORNO_TECNICO: "badge-err",
};

function elapsed(from: string | null): string {
  if (!from) return "";
  const ms = Date.now() - new Date(from.replace(" ", "T") + "Z").getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

export function TecnicoFila() {
  const [cases, setCases] = useState<RepairCase[]>([]);
  const [staff, setStaff] = useState<StaffMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);
  const [notLinked, setNotLinked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/fila-reparos/minha-fila");
    if (r.ok) {
      const d = await r.json();
      setCases(d.cases ?? []);
      setStaff(d.staffMember ?? null);
      setNotLinked(!d.staffMember);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function startRepair(id: number) {
    setActing(id); setActionErr(null);
    const r = await fetch(`/api/fila-reparos/${id}/start-repair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!r.ok) { const d = await r.json(); setActionErr(d.error ?? "Erro ao iniciar reparo."); }
    setActing(null);
    load();
  }

  async function completeRepair(id: number) {
    setActing(id); setActionErr(null);
    const r = await fetch(`/api/fila-reparos/${id}/complete-repair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!r.ok) { const d = await r.json(); setActionErr(d.error ?? "Erro ao concluir reparo."); }
    setActing(null);
    load();
  }

  if (loading) return <div className="muted" style={{ padding: "2rem" }}>Carregando…</div>;

  if (notLinked) return (
    <div style={{ padding: "2rem", maxWidth: 480 }}>
      <div className="alert alert-warn">
        <AlertCircle size={16} />
        Sua conta de usuário ainda não está vinculada a um técnico. Peça ao administrador para fazer o vínculo em <strong>Administração → Pessoas → Técnicos</strong>.
      </div>
    </div>
  );

  const active = cases.filter(c => c.workflow_status === "EM_REPARO");
  const waiting = cases.filter(c => c.workflow_status === "DIRECIONADO_TECNICO");
  const done = cases.filter(c => !["EM_REPARO","DIRECIONADO_TECNICO"].includes(c.workflow_status));

  return (
    <div>
      <div className="page-header">
        <h1>Minha fila — {staff?.name}</h1>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={load}>Atualizar</button>
      </div>

      {actionErr && <div className="alert alert-err">{actionErr}</div>}

      {cases.length === 0 && (
        <div className="card muted" style={{ padding: "2rem", textAlign: "center" }}>
          Nenhum aparelho direcionado para você no momento.
        </div>
      )}

      {active.length > 0 && (
        <section style={{ marginBottom: "1.5rem" }}>
          <div className="sidebar-label" style={{ marginBottom: "0.5rem" }}>Em reparo</div>
          {active.map(c => <CaseCard key={c.id} c={c} acting={acting} onComplete={completeRepair} />)}
        </section>
      )}

      {waiting.length > 0 && (
        <section style={{ marginBottom: "1.5rem" }}>
          <div className="sidebar-label" style={{ marginBottom: "0.5rem" }}>Aguardando início</div>
          {waiting.map(c => <CaseCard key={c.id} c={c} acting={acting} onStart={startRepair} />)}
        </section>
      )}

      {done.length > 0 && (
        <section>
          <div className="sidebar-label" style={{ marginBottom: "0.5rem" }}>Concluídos / outros</div>
          {done.map(c => <CaseCard key={c.id} c={c} acting={acting} />)}
        </section>
      )}
    </div>
  );
}

function CaseCard({ c, acting, onStart, onComplete }: {
  c: RepairCase;
  acting: number | null;
  onStart?: (id: number) => void;
  onComplete?: (id: number) => void;
}) {
  const isActing = acting === c.id;

  return (
    <div className="card" style={{ marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
            <span className={`badge ${STATUS_BADGE[c.workflow_status] ?? "badge-muted"}`}>
              {STATUS_LABEL[c.workflow_status] ?? c.workflow_status}
            </span>
            {c.workflow_status === "EM_REPARO" && c.repair_started_at && (
              <span className="muted" style={{ fontSize: "0.78rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <Clock size={12} /> {elapsed(c.repair_started_at)} em reparo
              </span>
            )}
          </div>

          <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
            {[c.brand, c.model, c.color].filter(Boolean).join(" · ") || "Aparelho sem identificação"}
          </div>

          <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}>
            {c.imei && <span>IMEI: {c.imei}</span>}
            {c.imei && (c.os || c.datasys_last_os) && <span> · </span>}
            {c.os && <span>OS: {c.os}</span>}
            {!c.os && c.datasys_last_os && (
              <span title="Sem OS própria — último registro Datasys para este IMEI">Último OS (Datasys): {c.datasys_last_os}</span>
            )}
          </div>

          <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.25rem" }}>
            {c.matched_parts}/{c.total_parts} peça(s) disponível(is)
            {c.repair_started_at && (
              <span> · Iniciado: {new Date(c.repair_started_at.replace(" ", "T") + "Z").toLocaleString("pt-BR")}</span>
            )}
            {c.repair_completed_at && (
              <span> · Concluído: {new Date(c.repair_completed_at.replace(" ", "T") + "Z").toLocaleString("pt-BR")}</span>
            )}
          </div>

          {c.notes && <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.25rem", fontStyle: "italic" }}>{c.notes}</div>}
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {onStart && (
            <button className="btn btn-primary btn-sm" disabled={isActing} onClick={() => onStart(c.id)}>
              <Play size={13} /> Iniciar reparo
            </button>
          )}
          {onComplete && (
            <button className="btn btn-sm" style={{ background: "var(--green-dim)", color: "var(--green-text)", border: "1px solid var(--green-border)" }} disabled={isActing} onClick={() => onComplete(c.id)}>
              <CheckCircle size={13} /> Concluir reparo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
