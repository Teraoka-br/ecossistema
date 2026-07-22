/**
 * Venda no Estado — classificação econômica configurável (Camada 5).
 * Cobre spec 43–50: percentual, limite de candidatos, aprovação humana,
 * rejeição, estado protegido e determinismo do ranking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { recordPriceEvent } from "../src/operational/part-price-service.js";
import {
  evaluateEconomics,
  approveAsIs,
  rejectAsIs,
  getEconomicEvaluation,
} from "../src/match/economic-evaluation-service.js";

let db: Db;
beforeEach(async () => { db = await createDb(); });

function insertCase(db: Db, imeiNorm: string, opts: { sale?: number; cost?: number; age?: number } = {}): number {
  const r = db.prepare(`
    INSERT INTO repair_cases
      (imei, imei_norm, model, workflow_status, analysis_status, deposito_atual,
       cost, estimated_sale, margin, age_days, created_at, updated_at)
    VALUES (?, ?, 'MODELO ECON', 'PEDIR_PECA', 'COMPLETED', 'AGUARDANDO PECA',
       ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    imeiNorm, imeiNorm,
    opts.cost ?? 100, opts.sale ?? 1000,
    (opts.sale ?? 1000) - (opts.cost ?? 100),
    opts.age ?? 30,
  );
  return Number(r.lastInsertRowid);
}

function insertPartWithPrice(db: Db, caseId: number, chave: string, price: number): void {
  db.prepare(`
    INSERT INTO part_requests
      (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
    VALUES (?, ?, ?, 'PEDIR_PECA', datetime('now'), datetime('now'))
  `).run(caseId, chave, chave.toUpperCase());
  recordPriceEvent(db, {
    chavePeca: chave, sourceType: "GOODS_RECEIPT",
    unitPrice: price, confidence: "HIGH", occurredAt: new Date().toISOString(),
  });
}

describe("evaluateEconomics", () => {
  it("(spec 43/44) abaixo do percentual é viável; acima entra em risco", () => {
    const cheap = insertCase(db, "ECON00000000001", { sale: 1000 });
    insertPartWithPrice(db, cheap, "TELA BARATA", 100); // ratio 0.1
    const expensive = insertCase(db, "ECON00000000002", { sale: 1000 });
    insertPartWithPrice(db, expensive, "TELA CARA", 700); // ratio 0.7

    const report = evaluateEconomics(db);
    expect(report.viable).toBe(1);
    expect(report.activeCandidates).toBe(1); // único risco vira candidato
    expect(getEconomicEvaluation(db, cheap)!.classification).toBe("ECONOMICALLY_VIABLE");
    expect(getEconomicEvaluation(db, expensive)!.classification).toBe("ACTIVE_AS_IS_CANDIDATE");
  });

  it("(spec 45/46) somente N candidatos ficam ativos; demais permanecem em risco", () => {
    db.prepare("UPDATE match_rule_sets SET as_is_max_active_candidates = 2 WHERE active = 1").run();
    for (let i = 1; i <= 4; i++) {
      const c = insertCase(db, `ECONN000000000${i}`, { sale: 1000 });
      insertPartWithPrice(db, c, `PECA CARA ${i}`, 600 + i * 50);
    }
    const report = evaluateEconomics(db);
    expect(report.activeCandidates).toBe(2);
    expect(report.risk).toBe(2);
  });

  it("(spec 50) ranking determinístico — maior ratio primeiro", () => {
    db.prepare("UPDATE match_rule_sets SET as_is_max_active_candidates = 1 WHERE active = 1").run();
    const worse = insertCase(db, "ECOND0000000001", { sale: 1000 });
    insertPartWithPrice(db, worse, "PECA W", 900); // ratio 0.9
    const better = insertCase(db, "ECOND0000000002", { sale: 1000 });
    insertPartWithPrice(db, better, "PECA B", 600); // ratio 0.6

    evaluateEconomics(db);
    expect(getEconomicEvaluation(db, worse)!.classification).toBe("ACTIVE_AS_IS_CANDIDATE");
    expect(getEconomicEvaluation(db, better)!.classification).toBe("ECONOMIC_RISK");
  });

  it("custo incompleto marca INCOMPLETE_COST", () => {
    const c = insertCase(db, "ECONI0000000001", { sale: 1000 });
    db.prepare(`
      INSERT INTO part_requests (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
      VALUES (?, 'PECA SEM PRECO', 'PECA SEM PRECO', 'PEDIR_PECA', datetime('now'), datetime('now'))
    `).run(c);
    const report = evaluateEconomics(db);
    expect(report.incompleteCost).toBe(1);
    expect(getEconomicEvaluation(db, c)!.classification).toBe("INCOMPLETE_COST");
  });
});

describe("aprovação e rejeição humanas", () => {
  function makeCandidate(imei: string): number {
    const c = insertCase(db, imei, { sale: 1000 });
    insertPartWithPrice(db, c, `PECA ${imei}`, 800);
    evaluateEconomics(db);
    return c;
  }

  it("(spec 47) aprovação humana move para VENDA_ESTADO", () => {
    const c = makeCandidate("ECONA0000000001");
    approveAsIs(db, c, { userId: "gestor", reason: "reparo antieconômico" });
    const wf = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(c) as { workflow_status: string };
    expect(wf.workflow_status).toBe("VENDA_ESTADO");
    expect(getEconomicEvaluation(db, c)!.classification).toBe("AS_IS_APPROVED");
  });

  it("(spec 48) rejeição mantém o aparelho no reparo e é preservada", () => {
    const c = makeCandidate("ECONR0000000001");
    rejectAsIs(db, c, { userId: "gestor", reason: "vale reparar mesmo assim" });
    const wf = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(c) as { workflow_status: string };
    expect(wf.workflow_status).toBe("PEDIR_PECA");
    expect(getEconomicEvaluation(db, c)!.classification).toBe("AS_IS_REJECTED");
    // Reavaliação não sobrescreve a decisão
    const report = evaluateEconomics(db);
    expect(report.preservedDecisions).toBe(1);
    expect(getEconomicEvaluation(db, c)!.classification).toBe("AS_IS_REJECTED");
  });

  it("(spec 49) caso em estado protegido não é movido", () => {
    const c = makeCandidate("ECONP0000000001");
    db.prepare("UPDATE repair_cases SET workflow_status = 'EM_REPARO' WHERE id = ?").run(c);
    expect(() => approveAsIs(db, c, { userId: "gestor", reason: "tentativa inválida" }))
      .toThrowError(/protegido/);
  });

  it("classificação sozinha nunca altera workflow", () => {
    const c = makeCandidate("ECONW0000000001");
    const wf = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(c) as { workflow_status: string };
    expect(wf.workflow_status).toBe("PEDIR_PECA");
  });
});
