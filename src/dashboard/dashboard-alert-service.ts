import type { Db } from "../db/database.js";

export type AlertSeverity = "INFO" | "WARN" | "CRITICAL";

export interface OperationalAlert {
  code: string;
  title: string;
  description: string;
  severity: AlertSeverity;
  count: number;
  suggestedAction: string;
  route?: string;
  /** Se definido, clicar no alerta ativa este filtro no dashboard em vez de navegar. */
  cardFilter?: string;
}

function isWeekday(date: Date): boolean {
  const d = date.getDay();
  return d >= 1 && d <= 5;
}

function lastBusinessDaySP(): Date {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  while (!isWeekday(d)) d.setDate(d.getDate() - 1);
  return d;
}

export function getOperationalAlerts(db: Db): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];

  // 1. Nenhuma contagem no ultimo dia util
  const lastBd = lastBusinessDaySP();
  const lastBdStr = lastBd.toISOString().slice(0, 10);
  const countYesterday = db
    .prepare(
      `SELECT COUNT(*) as c FROM count_sessions
       WHERE status='FINALIZED' AND DATE(finished_at)=?`,
    )
    .get(lastBdStr) as { c: number };
  if (countYesterday.c === 0) {
    alerts.push({
      code: "NO_COUNT_LAST_BUSINESS_DAY",
      title: "Sem contagem no ultimo dia util",
      description: `Nenhuma contagem finalizada em ${lastBdStr}.`,
      severity: "WARN",
      count: 1,
      suggestedAction: "Realizar contagem de estoque",
      route: "/bipagem",
    });
  }

  // 2a. Aparelhos em VERIFICAR (repair_cases)
  const casesVerificarRow = db
    .prepare(`SELECT COUNT(*) as c FROM repair_cases WHERE workflow_status='VERIFICAR'`)
    .get() as { c: number };
  if (casesVerificarRow.c > 0) {
    alerts.push({
      code: "CASES_VERIFICAR",
      title: "Aparelhos para verificar",
      description: `${casesVerificarRow.c} aparelho(s) aguardando verificacao manual na fila.`,
      severity: casesVerificarRow.c > 10 ? "CRITICAL" : "WARN",
      count: casesVerificarRow.c,
      suggestedAction: "Filtrar VERIFICAR na fila de reparos",
      cardFilter: "verificar",
    });
  }

  // 2b. Peças em VERIFICAR (part_requests)
  const partsVerificarRow = db
    .prepare(`SELECT COUNT(*) as c FROM part_requests WHERE status='VERIFICAR' AND cancelled_at IS NULL`)
    .get() as { c: number };
  if (partsVerificarRow.c > 0) {
    alerts.push({
      code: "PARTS_VERIFICAR",
      title: "Pecas com status VERIFICAR",
      description: `${partsVerificarRow.c} peca(s) em VERIFICAR na fila de reparos precisam de revisao.`,
      severity: partsVerificarRow.c > 20 ? "CRITICAL" : "WARN",
      count: partsVerificarRow.c,
      suggestedAction: "Revisar pecas na fila",
      route: "/fila-reparos",
    });
  }

  // 3. Casos sem deposito
  const semDeposito = db
    .prepare(
      `SELECT COUNT(*) as c FROM repair_cases
       WHERE deposito_atual IS NULL AND workflow_status NOT IN ('ENTREGUE','CANCELADO')`,
    )
    .get() as { c: number };
  if (semDeposito.c > 0) {
    alerts.push({
      code: "CASES_NO_DEPOSIT",
      title: "Casos sem deposito",
      description: `${semDeposito.c} caso(s) ativo(s) sem deposito definido.`,
      severity: "WARN",
      count: semDeposito.c,
      suggestedAction: "Atribuir deposito aos casos na fila",
      route: "/fila-reparos",
    });
  }

  // 4. Pecas sem referencia resolvida
  const semRefRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM part_requests pr
       LEFT JOIN reference_mappings rm ON rm.reference_norm = pr.chave_peca_norm AND rm.active = 1
       WHERE pr.cancelled_at IS NULL
         AND pr.chave_peca IS NULL
         AND rm.id IS NULL`,
    )
    .get() as { c: number };
  if (semRefRow.c > 0) {
    alerts.push({
      code: "PARTS_NO_REFERENCE",
      title: "Pecas sem referencia resolvida",
      description: `${semRefRow.c} peca(s) sem CHAVEPECA e sem mapeamento de referencia.`,
      severity: "WARN",
      count: semRefRow.c,
      suggestedAction: "Resolver referencias pendentes",
      route: "/estoque/referencias",
    });
  }

  // 4b. Aparelhos aguardando peca ha mais de 7 dias
  const longWaitRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM repair_cases
       WHERE workflow_status IN ('PEDIR_PECA','AGUARDANDO_RECEBIMENTO')
         AND julianday('now') - julianday(updated_at) > 7`,
    )
    .get() as { c: number };
  if (longWaitRow.c > 0) {
    alerts.push({
      code: "CASES_LONG_WAIT_PART",
      title: "Aparelhos aguardando peca ha mais de 7 dias",
      description: `${longWaitRow.c} aparelho(s) em espera de peca por mais de 7 dias.`,
      severity: longWaitRow.c > 5 ? "CRITICAL" : "WARN",
      count: longWaitRow.c,
      suggestedAction: "Verificar pedidos de compra e reservas",
      cardFilter: "aguardandoPeca",
    });
  }

  // 5. Pedidos de compra aguardando ha muito tempo (>30 dias)
  const oldPO = db
    .prepare(
      `SELECT COUNT(*) as c FROM purchase_orders
       WHERE status='AWAITING'
         AND julianday('now') - julianday(created_at) > 30`,
    )
    .get() as { c: number };
  if (oldPO.c > 0) {
    alerts.push({
      code: "OLD_PURCHASE_ORDERS",
      title: "Pedidos aguardando ha mais de 30 dias",
      description: `${oldPO.c} pedido(s) de compra em AWAITING ha mais de 30 dias.`,
      severity: "WARN",
      count: oldPO.c,
      suggestedAction: "Revisar pedidos de compra",
      route: "/compras",
    });
  }

  // 6. Snapshots desatualizados (mais de 2 dias sem snapshot)
  const lastSnapRow = db
    .prepare(
      `SELECT snapshot_date FROM dashboard_daily_snapshots ORDER BY snapshot_date DESC LIMIT 1`,
    )
    .get() as { snapshot_date: string } | undefined;
  if (!lastSnapRow) {
    alerts.push({
      code: "NO_DASHBOARD_SNAPSHOT",
      title: "Sem snapshot de dashboard",
      description: "Nenhum snapshot diario encontrado. O historico aparece apos o primeiro snapshot ser gerado.",
      severity: "INFO",
      count: 0,
      suggestedAction: 'Clique em "Recalcular snapshot" no cabecalho do dashboard',
    });
  } else {
    const daysSince = Math.floor(
      (Date.now() - new Date(lastSnapRow.snapshot_date + "T12:00:00").getTime()) / 86400000,
    );
    if (daysSince > 2) {
      alerts.push({
        code: "STALE_DASHBOARD_SNAPSHOT",
        title: "Snapshot desatualizado",
        description: `Ultimo snapshot em ${lastSnapRow.snapshot_date} (${daysSince} dia(s) atras). O grafico de historico pode estar incompleto.`,
        severity: "WARN",
        count: daysSince,
        suggestedAction: 'Clique em "Recalcular snapshot" no cabecalho do dashboard',
      });
    }
  }

  // 7. Bugs criticos abertos
  const criticalBugs = db
    .prepare(
      `SELECT COUNT(*) as c FROM issue_reports
       WHERE status IN ('OPEN','IN_ANALYSIS') AND severity='CRITICAL'`,
    )
    .get() as { c: number };
  if (criticalBugs.c > 0) {
    alerts.push({
      code: "CRITICAL_BUGS_OPEN",
      title: "Problemas criticos abertos",
      description: `${criticalBugs.c} problema(s) critico(s) sem resolucao.`,
      severity: "CRITICAL",
      count: criticalBugs.c,
      suggestedAction: "Resolver os problemas criticos",
    });
  }

  // 7b. Bugs aguardando validacao em producao
  const awaitingTest = db
    .prepare(`SELECT COUNT(*) as c FROM issue_reports WHERE status='AWAITING_TEST'`)
    .get() as { c: number };
  if (awaitingTest.c > 0) {
    alerts.push({
      code: "ISSUES_AWAITING_TEST",
      title: "Problemas aguardando validacao",
      description: `${awaitingTest.c} problema(s) com correcao aplicada aguardando confirmacao em producao.`,
      severity: "INFO",
      count: awaitingTest.c,
      suggestedAction: "Validar em producao e marcar como Resolvido",
    });
  }

  // 8. Ausencia de regra de match ativa
  const activeRuleRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM match_rule_sets WHERE active=1`,
    )
    .get() as { c: number };
  if (activeRuleRow.c === 0) {
    alerts.push({
      code: "NO_ACTIVE_MATCH_RULE",
      title: "Sem regra de match ativa",
      description: "Nenhuma regra de match esta ativa. O motor nao executara.",
      severity: "CRITICAL",
      count: 0,
      suggestedAction: "Ativar uma regra de match",
      route: "/admin/regras-match",
    });
  }

  // 9. Reservas ativas ligadas a casos já encerrados (vazamento de reserva)
  const leakedReservations = db
    .prepare(
      `SELECT COUNT(*) as c FROM operational_reservations orr
       JOIN repair_cases rc ON rc.id = orr.repair_case_id
       WHERE orr.status = 'ACTIVE'
         AND rc.workflow_status IN ('CONCLUIDO','CANCELADO','VENDA_ESTADO')`,
    )
    .get() as { c: number };
  if (leakedReservations.c > 0) {
    alerts.push({
      code: "LEAKED_RESERVATIONS",
      title: "Reservas inconsistentes",
      description: `${leakedReservations.c} reserva(s) ATIVA(S) ligadas a casos já encerrados (CONCLUIDO/CANCELADO/VENDA_ESTADO). O estoque disponível pode estar subestimado.`,
      severity: "WARN",
      count: leakedReservations.c,
      suggestedAction: "Revisar reservas em Estoque ou acionar o administrador",
      route: "/estoque",
    });
  }

  const order: Record<AlertSeverity, number> = { CRITICAL: 0, WARN: 1, INFO: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}
