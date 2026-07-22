/**
 * Regressão para 3 bugs reais encontrados na revisão da Central de Problemas
 * (2026-07-21):
 *  - dashboards-routes selecionava a coluna inexistente `os_number` em
 *    repair_cases (a coluna real é `os`) — o modal "Aparelhos — {técnico}"
 *    ficava só com cabeçalho, sem carregar nada (endpoint quebrava com 500).
 *  - issue_reports.status tinha um CHECK constraint (herdado da migration 041)
 *    que não incluía 'AWAITING_TEST', embora a migration 055 tenha assumido
 *    que a coluna aceitava qualquer valor — qualquer tentativa de marcar um
 *    problema como "correção aplicada, aguardando validação" falhava.
 *  - export/import de cotação usava CSV separado por vírgula, que abre errado
 *    no Excel em locale pt-BR — trocado por .xlsx real via parseCotacaoXlsx.
 *
 * Regressão adicional (issue #14, 2026-07-22): cards da Fila de Reparos não
 * mostravam nenhuma OS para aparelhos de lote sem OS própria (import legado
 * sem rastreamento individual) — `getLatestOsByImeis` busca o último OS
 * conhecido no Datasys pelo IMEI, usado como fallback só quando `os` está
 * vazio (nunca sobrescreve o valor do caso).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/database.js";
import { createDb, cleanup, makeXlsx } from "./helpers.js";
import { getTechnicianCaseDetails } from "../src/dashboard/dashboard-overview-service.js";
import { updateIssue, createIssue } from "../src/issue/issue-service.js";
import { parseCotacaoXlsx, buildNecessidadesXlsx, listNecessidades } from "../src/operational/cotacao-service.js";
import { getLatestOsByImeis } from "../src/datasys/datasys-service.js";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanup(created.pop()!);
});

function insertTechnicianCase(db: Db, technicianId: number, opts: { imei: string; os?: string }): void {
  db.prepare(
    `INSERT INTO staff_members (id, name, type, active) VALUES (?, 'Técnico Teste', 'TECHNICIAN', 1)`,
  ).run(technicianId);
  db.prepare(
    `INSERT INTO repair_cases
       (imei, imei_norm, os, analysis_status, workflow_status, directed_technician_id, created_at, updated_at)
     VALUES (?, ?, ?, 'COMPLETED', 'DIRECIONADO_TECNICO', ?, datetime('now'), datetime('now'))`,
  ).run(opts.imei, opts.imei, opts.os ?? null, technicianId);
}

describe("getTechnicianCaseDetails (regressão: coluna os_number inexistente)", () => {
  it("não lança erro de SQL e devolve o número da OS a partir da coluna real (os)", async () => {
    const db = await createDb();
    insertTechnicianCase(db, 1, { imei: "111122223333444", os: "OS-9001" });

    const rows = getTechnicianCaseDetails(db, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0].os_number).toBe("OS-9001");
  });

  it("devolve lista vazia (não erro) para técnico sem aparelhos ativos", async () => {
    const db = await createDb();
    expect(getTechnicianCaseDetails(db, 999)).toEqual([]);
  });
});

describe("issue_reports.status AWAITING_TEST (regressão: CHECK constraint desatualizado)", () => {
  it("permite marcar um problema como AWAITING_TEST sem violar CHECK", async () => {
    const db = await createDb();
    const issue = createIssue(db, {
      title: "Bug de teste",
      module: "DASHBOARD",
      severity: "MEDIUM",
      userId: null,
      userName: null,
    });

    const updated = updateIssue(db, issue.id, {
      status: "AWAITING_TEST",
      resolution_notes: "Correção aplicada, aguardando validação.",
    });

    expect(updated?.status).toBe("AWAITING_TEST");
    expect(updated?.resolved_at).not.toBeNull();
  });
});

describe("cotação em .xlsx (evita CSV frágil a locale pt-BR)", () => {
  it("parseCotacaoXlsx lê itens de um workbook com cabeçalho", () => {
    const filePath = makeXlsx([
      { name: "Cotação", aoa: [
        ["PECA", "QTDE", "VALOR UN", "VALOR TOTAL"],
        ["BAT IPHONE 11", 5, 45.9, ""],
        ["TELA IPHONE 12", 2, "120,50", ""],
        ["SEM PRECO", 3, "", ""],
      ] },
    ]);
    created.push(filePath);

    const items = parseCotacaoXlsx(filePath);

    expect(items).toEqual([
      { chavePeca: "BAT IPHONE 11", qtde: 5, valorUnitario: 45.9 },
      { chavePeca: "TELA IPHONE 12", qtde: 2, valorUnitario: 120.5 },
    ]);
  });

  it("regressão: fornecedor digitando preço com símbolo de moeda não some da cotação", () => {
    // Bug real: "R$ 45,90" como texto (comum quando o fornecedor formata a
    // célula como moeda ou digita o símbolo) fazia parseFloat("R$ 45.90")
    // devolver NaN de cara — a linha inteira era descartada em silêncio e,
    // se acontecesse em todas as linhas, "Registrar cotação" não tinha o
    // que registrar e parecia não fazer nada.
    const filePath = makeXlsx([
      { name: "Cotação", aoa: [
        ["PECA", "QTDE", "VALOR UN", "VALOR TOTAL"],
        ["BAT IPHONE 11", 5, "R$ 45,90", ""],
        ["TELA IPHONE 12", "2 un", "R$ 1.234,56", ""],
        ["CONECTOR", 3, "R$45.90", ""],
      ] },
    ]);
    created.push(filePath);

    const items = parseCotacaoXlsx(filePath);

    expect(items).toEqual([
      { chavePeca: "BAT IPHONE 11", qtde: 5, valorUnitario: 45.9 },
      { chavePeca: "TELA IPHONE 12", qtde: 2, valorUnitario: 1234.56 },
      { chavePeca: "CONECTOR", qtde: 3, valorUnitario: 45.9 },
    ]);
  });

  it("buildNecessidadesXlsx + parseCotacaoXlsx fazem round-trip do template exportado", () => {
    const buffer = buildNecessidadesXlsx([
      { chavePeca: "CONECTOR CARGA", qtdeNecessaria: 4 },
    ]);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("listNecessidades conta separadamente aparelhos que fecham só com esta peça", async () => {
    const db = await createDb();
    // Caso 1: só falta CONECTOR — fecha comprando só essa peça.
    db.prepare(
      `INSERT INTO repair_cases (id, imei, imei_norm, analysis_status, workflow_status, created_at, updated_at)
       VALUES (1, 'IMEI1', 'imei1', 'COMPLETED', 'PEDIR_PECA', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO part_requests (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
       VALUES (1, 'CONECTOR', 'conector', 'PEDIR_PECA', datetime('now'), datetime('now'))`,
    ).run();
    // Caso 2: falta CONECTOR e também TELA — não fecha só com CONECTOR.
    db.prepare(
      `INSERT INTO repair_cases (id, imei, imei_norm, analysis_status, workflow_status, created_at, updated_at)
       VALUES (2, 'IMEI2', 'imei2', 'COMPLETED', 'PEDIR_PECA', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO part_requests (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
       VALUES (2, 'CONECTOR', 'conector', 'PEDIR_PECA', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO part_requests (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
       VALUES (2, 'TELA', 'tela', 'PEDIR_PECA', datetime('now'), datetime('now'))`,
    ).run();

    const items = listNecessidades(db);
    const conector = items.find(i => i.chavePeca === "CONECTOR");

    expect(conector?.casesBlocked).toBe(2);
    expect(conector?.fullMatchCount).toBe(1);
  });
});

describe("getLatestOsByImeis (issue #14: OS ausente em aparelhos de lote)", () => {
  function insertDatasysRecord(db: Db, opts: { imei: string; os: string; startedAt: string }): void {
    const importRes = db.prepare(
      `INSERT INTO datasys_imports (filename, file_hash, status, started_at)
       VALUES ('rel.xlsx', ?, 'COMPLETED', ?)`,
    ).run(`hash-${opts.startedAt}-${opts.imei}`, opts.startedAt);
    db.prepare(
      `INSERT INTO datasys_records (datasys_import_id, imei, imei_norm, os, os_norm)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(importRes.lastInsertRowid, opts.imei, opts.imei, opts.os, opts.os);
  }

  it("devolve o OS do registro Datasys mais recente por IMEI", async () => {
    const db = await createDb();
    insertDatasysRecord(db, { imei: "111122223333444", os: "OS-1000", startedAt: "2026-01-01 10:00:00" });
    insertDatasysRecord(db, { imei: "111122223333444", os: "OS-2000", startedAt: "2026-02-01 10:00:00" });
    insertDatasysRecord(db, { imei: "999988887777666", os: "OS-3000", startedAt: "2026-01-15 10:00:00" });

    const result = getLatestOsByImeis(db, ["111122223333444", "999988887777666", "000000000000000"]);

    expect(result.get("111122223333444")).toBe("OS-2000");
    expect(result.get("999988887777666")).toBe("OS-3000");
    expect(result.has("000000000000000")).toBe(false);
  });

  it("devolve mapa vazio para lista vazia, sem consultar o banco", async () => {
    const db = await createDb();
    expect(getLatestOsByImeis(db, [])).toEqual(new Map());
  });
});
