/**
 * Projeção combinada de cotação com custo de peças (Camada 4).
 *
 * Garante que:
 *   - baseline não recebe crédito da compra;
 *   - a seleção fecha matches incrementais;
 *   - o custo incremental usa o preço da seleção para chaves cotadas
 *     e o custo canônico resolvido para as demais;
 *   - o impacto marginal por linha remove a contribuição da linha.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { projectCotacaoImpact } from "../src/match/cotacao-projection-service.js";
import { recordPriceEvent } from "../src/operational/part-price-service.js";

let db: Db;
beforeEach(async () => { db = await createDb(); });

function insertCase(db: Db, imeiNorm: string, opts: { sale?: number; cost?: number } = {}): number {
  const r = db.prepare(`
    INSERT INTO repair_cases
      (imei, imei_norm, model, workflow_status, analysis_status, deposito_atual,
       cost, estimated_sale, margin, age_days, created_at, updated_at)
    VALUES (?, ?, 'MODELO PROJ', 'PEDIR_PECA', 'COMPLETED', 'AGUARDANDO PECA',
       ?, ?, ?, 30, datetime('now'), datetime('now'))
  `).run(
    imeiNorm, imeiNorm,
    opts.cost ?? 100,
    opts.sale ?? 500,
    (opts.sale ?? 500) - (opts.cost ?? 100),
  );
  return Number(r.lastInsertRowid);
}

function insertPart(db: Db, caseId: number, chave: string): void {
  db.prepare(`
    INSERT INTO part_requests
      (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
    VALUES (?, ?, ?, 'PEDIR_PECA', datetime('now'), datetime('now'))
  `).run(caseId, chave, chave.toUpperCase());
}

function insertStock(db: Db, chaveNorm: string, qty: number): void {
  const sessionId = db.prepare(`
    INSERT INTO count_sessions (responsible_name, status, started_at, finished_at)
    VALUES ('sistema', 'FINALIZED', datetime('now'), datetime('now'))
  `).run().lastInsertRowid;
  const snapshotId = db.prepare(`
    INSERT INTO stock_snapshots (count_session_id, status, total_units, created_at, baseline_movement_id_max)
    VALUES (?, 'OFFICIAL', ?, datetime('now'), 0)
  `).run(sessionId, qty).lastInsertRowid;
  const ref = `REF-${chaveNorm}`;
  db.prepare(`
    INSERT INTO stock_snapshot_items (snapshot_id, reference, reference_norm, chave_peca, chave_peca_norm, counted_quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(snapshotId, ref, ref.toLowerCase(), chaveNorm, chaveNorm, qty);
}

describe("projectCotacaoImpact com custo de peças", () => {
  it("seleção que fecha match gera incremental com custo da seleção", () => {
    const c1 = insertCase(db, "PROJ00000000001", { sale: 1000, cost: 400 });
    insertPart(db, c1, "TELA X");

    const r = projectCotacaoImpact(db, [
      { id: 1, chavePeca: "TELA X", qtde: 1, valorUnitario: 120 },
    ]);

    expect(r.baselineFullMatches).toBe(0);
    expect(r.incrementalFullMatches).toBe(1);
    expect(r.incrementalCaseIds).toEqual([c1]);
    // Custo da peça vem do preço da seleção
    expect(r.incrementalPartsCost).toBe(120);
    expect(r.incrementalPartsCostCoverage).toBe(100);
    // Margem incremental legada = 600; após peças = 480
    expect(r.incrementalMargin).toBe(600);
    expect(r.incrementalRepairMargin).toBe(480);
  });

  it("baseline não recebe crédito da compra", () => {
    const c1 = insertCase(db, "PROJ00000000002");
    insertPart(db, c1, "BATERIA Y");
    insertStock(db, "BATERIA Y", 1); // já fecharia sem a compra

    const r = projectCotacaoImpact(db, [
      { id: 1, chavePeca: "BATERIA Y", qtde: 2, valorUnitario: 50 },
    ]);

    expect(r.baselineFullMatches).toBe(1);
    expect(r.incrementalFullMatches).toBe(0);
    expect(r.incrementalPartsCost).toBeNull();
    expect(r.incrementalRepairMargin).toBeNull();
  });

  it("peça fora da seleção usa custo canônico resolvido", () => {
    const c1 = insertCase(db, "PROJ00000000003", { sale: 1000, cost: 400 });
    insertPart(db, c1, "TELA Z");
    insertPart(db, c1, "BATERIA Z");
    insertStock(db, "BATERIA Z", 1); // bateria vem do estoque, não da cotação
    recordPriceEvent(db, {
      chavePeca: "BATERIA Z", sourceType: "GOODS_RECEIPT",
      unitPrice: 40, confidence: "HIGH", occurredAt: new Date().toISOString(),
    });

    const r = projectCotacaoImpact(db, [
      { id: 1, chavePeca: "TELA Z", qtde: 1, valorUnitario: 150 },
    ]);

    expect(r.incrementalFullMatches).toBe(1);
    // 150 (seleção) + 40 (custo canônico da bateria)
    expect(r.incrementalPartsCost).toBe(190);
    expect(r.incrementalPartsCostCoverage).toBe(100);
  });

  it("peça sem custo reduz cobertura", () => {
    const c1 = insertCase(db, "PROJ00000000004");
    insertPart(db, c1, "TELA W");
    insertPart(db, c1, "BATERIA W");
    insertStock(db, "BATERIA W", 1); // sem evento de preço

    const r = projectCotacaoImpact(db, [
      { id: 1, chavePeca: "TELA W", qtde: 1, valorUnitario: 80 },
    ]);

    expect(r.incrementalFullMatches).toBe(1);
    expect(r.incrementalPartsCost).toBe(80);
    expect(r.incrementalPartsCostCoverage).toBe(50);
  });

  it("impacto marginal por linha e histórico de preço", () => {
    const c1 = insertCase(db, "PROJ00000000005");
    insertPart(db, c1, "TELA H");
    recordPriceEvent(db, {
      chavePeca: "TELA H", sourceType: "GOODS_RECEIPT",
      unitPrice: 95, confidence: "HIGH", occurredAt: new Date().toISOString(),
    });

    const r = projectCotacaoImpact(db, [
      { id: 1, chavePeca: "TELA H", qtde: 1, valorUnitario: 100 },
      { id: 2, chavePeca: "PECA INUTIL", qtde: 1, valorUnitario: 10 },
    ]);

    const linhaTela = r.lineProjections.find((l) => l.id === 1)!;
    const linhaInutil = r.lineProjections.find((l) => l.id === 2)!;
    expect(linhaTela.marginalFullMatches).toBe(1);
    expect(linhaInutil.marginalFullMatches).toBe(0);
    expect(linhaTela.priceHistory).not.toBeNull();
    expect(linhaTela.priceHistory!.latestPrice).toBe(95);
    expect(linhaInutil.priceHistory).toBeNull();
  });
});
