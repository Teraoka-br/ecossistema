import { TrendingUp, DollarSign, Wrench, CheckCircle, XCircle, Package } from "lucide-react";
import type { FinancialData } from "./types.js";

interface Props {
  financial: FinancialData;
}

function fmt(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

interface KpiProps {
  icon: typeof DollarSign;
  iconColor: string;
  iconBg: string;
  label: string;
  cost: number | null;
  sale: number | null;
  margin: number | null;
  count: number;
  countLabel?: string;
  highlight?: boolean;
}

function KpiCard({ icon: Icon, iconColor, iconBg, label, cost, sale, margin, count, countLabel = "casos", highlight }: KpiProps) {
  const marginPct = (cost && margin !== null && cost > 0) ? ((margin / cost) * 100) : null;

  return (
    <div style={{
      background: "var(--surface)",
      border: `1px solid ${highlight ? "rgba(124,58,237,0.3)" : "var(--border)"}`,
      borderRadius: "var(--r-lg)",
      padding: "1.25rem 1.375rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.75rem",
      boxShadow: highlight
        ? "0 4px 20px rgba(124,58,237,0.15), inset 0 1px 0 rgba(255,255,255,0.04)"
        : "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <div style={{
            width: 32, height: 32, borderRadius: "var(--r-sm)",
            background: iconBg, color: iconColor,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Icon size={15} />
          </div>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {label}
          </span>
        </div>
        <span style={{ fontSize: "0.72rem", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
          {count} {countLabel}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem" }}>
        <div>
          <div style={{ fontSize: "0.65rem", color: "var(--muted)", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Custo</div>
          <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
            {fmt(cost)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "0.65rem", color: "var(--muted)", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Venda est.</div>
          <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--info-text)", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
            {fmt(sale)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "0.65rem", color: "var(--muted)", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Margem {marginPct !== null ? <span style={{ opacity: 0.7 }}>({marginPct.toFixed(0)}%)</span> : ""}
          </div>
          <div style={{
            fontSize: "0.95rem", fontWeight: 700, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums",
            color: margin === null ? "var(--muted)"
              : margin >= 0 ? "var(--ok-text)"
              : "var(--err-text)",
          }}>
            {fmt(margin)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FinancialBlock({ financial }: Props) {
  const { active, withTechnician, waitingPart, concludedThisMonth, lostThisMonth } = financial;

  return (
    <div>
      <div style={{ marginBottom: "0.875rem", display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <TrendingUp size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text)" }}>
          Financeiro — Grana andando
        </span>
        <span style={{ fontSize: "0.72rem", color: "var(--muted)", marginLeft: "0.25rem" }}>
          valores de custo + venda estimada por status
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0.75rem" }}>
        <KpiCard
          icon={DollarSign}
          iconColor="var(--accent)"
          iconBg="var(--accent-dim)"
          label="Em circulação (ativos)"
          cost={active.totalCost}
          sale={active.totalSale}
          margin={active.totalMargin}
          count={active.caseCount}
          highlight
        />
        <KpiCard
          icon={Wrench}
          iconColor="var(--warn-text)"
          iconBg="var(--warn-dim)"
          label="Com técnico"
          cost={withTechnician.totalCost}
          sale={withTechnician.totalSale}
          margin={withTechnician.totalMargin}
          count={withTechnician.caseCount}
        />
        <KpiCard
          icon={Package}
          iconColor="var(--info-text)"
          iconBg="var(--info-dim)"
          label="Aguardando peça"
          cost={waitingPart.totalCost}
          sale={waitingPart.totalSale}
          margin={waitingPart.totalMargin}
          count={waitingPart.caseCount}
        />
        <KpiCard
          icon={CheckCircle}
          iconColor="var(--ok-text)"
          iconBg="var(--ok-dim)"
          label="Concluídos este mês"
          cost={concludedThisMonth.totalCost}
          sale={concludedThisMonth.totalSale}
          margin={concludedThisMonth.totalMargin}
          count={concludedThisMonth.caseCount}
          countLabel="finalizados"
        />
        <KpiCard
          icon={XCircle}
          iconColor="var(--err-text)"
          iconBg="var(--err-dim)"
          label="Cancelados / Venda estado mês"
          cost={lostThisMonth.totalCost}
          sale={lostThisMonth.totalSale}
          margin={lostThisMonth.totalMargin}
          count={lostThisMonth.caseCount}
          countLabel="casos"
        />
      </div>
    </div>
  );
}
