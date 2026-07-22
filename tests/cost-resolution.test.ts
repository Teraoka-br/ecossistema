import { describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { recordPriceEvent } from "../src/operational/part-price-service.js";
import {
  resolveEffectivePartCost,
  resolvePartCostsBatch,
  COST_STALENESS_DAYS,
} from "../src/operational/cost-resolution-service.js";
import { calculateRepairPartsCost } from "../src/operational/repair-parts-cost-service.js";
import { calculateRepairMargin } from "../src/match/repair-margin-service.js";

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe("cost-resolution-service", () => {
  describe("resolveEffectivePartCost", () => {
    it("retorna MISSING quando não há eventos", () => {
      const db = freshDb();
      const r = resolveEffectivePartCost(db, { chavePecaNorm: "BAT X", context: "CURRENT_REPAIR" });
      expect(r.confidence).toBe("MISSING");
      expect(r.unitCost).toBeNull();
    });

    it("prioriza GOODS_RECEIPT sobre COTACAO", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "COTACAO", unitPrice: 50, confidence: "LOW", occurredAt: daysAgo(5) });
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "GOODS_RECEIPT", unitPrice: 45, confidence: "HIGH", occurredAt: daysAgo(10) });
      const r = resolveEffectivePartCost(db, { chavePecaNorm: "BAT", context: "CURRENT_REPAIR" });
      expect(r.unitCost).toBe(45);
      expect(r.sourceType).toBe("GOODS_RECEIPT");
    });

    it("GOODS_RECEIPT recente → HIGH confidence", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "GOODS_RECEIPT", unitPrice: 40, confidence: "HIGH", occurredAt: daysAgo(30) });
      const r = resolveEffectivePartCost(db, { chavePecaNorm: "BAT", context: "CURRENT_REPAIR" });
      expect(r.confidence).toBe("HIGH");
      expect(r.isStale).toBe(false);
    });

    it("GOODS_RECEIPT antigo → MEDIUM confidence, isStale", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "GOODS_RECEIPT", unitPrice: 40, confidence: "HIGH", occurredAt: daysAgo(120) });
      const r = resolveEffectivePartCost(db, { chavePecaNorm: "BAT", context: "CURRENT_REPAIR" });
      expect(r.confidence).toBe("MEDIUM");
      expect(r.isStale).toBe(true);
    });

    it("detecta CONFLICT com dispersão >30%", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "TELA", sourceType: "GOODS_RECEIPT", unitPrice: 100, supplier: "A", confidence: "HIGH", occurredAt: daysAgo(5) });
      recordPriceEvent(db, { chavePeca: "TELA", sourceType: "GOODS_RECEIPT", unitPrice: 150, supplier: "B", confidence: "HIGH", occurredAt: daysAgo(10) });
      const r = resolveEffectivePartCost(db, { chavePecaNorm: "TELA", context: "CURRENT_REPAIR" });
      expect(r.confidence).toBe("CONFLICT");
      expect(r.unitCost).toBe(100); // mais recente
    });

    it("usa compatível quando direta não tem dados", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT ALT", sourceType: "GOODS_RECEIPT", unitPrice: 42, confidence: "HIGH", occurredAt: daysAgo(10) });
      const r = resolveEffectivePartCost(db, {
        chavePecaNorm: "BAT ORIG",
        context: "CURRENT_REPAIR",
        compatGroupMembers: ["BAT ORIG", "BAT ALT"],
      });
      expect(r.unitCost).toBe(42);
      expect(r.reasons).toContainEqual(expect.stringContaining("compatível"));
    });

    it("compatível rebaixa confidence em 1 nível", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT ALT", sourceType: "GOODS_RECEIPT", unitPrice: 42, confidence: "HIGH", occurredAt: daysAgo(10) });
      const r = resolveEffectivePartCost(db, {
        chavePecaNorm: "BAT ORIG",
        context: "CURRENT_REPAIR",
        compatGroupMembers: ["BAT ORIG", "BAT ALT"],
      });
      // GOODS_RECEIPT recente seria HIGH direto, mas via compatível → MEDIUM
      expect(r.confidence).toBe("MEDIUM");
    });

    it("BACKFILL tem prioridade menor que GOODS_RECEIPT", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "X", sourceType: "BACKFILL_COTACAO", unitPrice: 30, confidence: "LOW", occurredAt: daysAgo(5) });
      recordPriceEvent(db, { chavePeca: "X", sourceType: "GOODS_RECEIPT", unitPrice: 35, confidence: "HIGH", occurredAt: daysAgo(100) });
      const r = resolveEffectivePartCost(db, { chavePecaNorm: "X", context: "CURRENT_REPAIR" });
      expect(r.unitCost).toBe(35);
      expect(r.sourceType).toBe("GOODS_RECEIPT");
    });
  });

  describe("resolvePartCostsBatch", () => {
    it("resolve múltiplas chaves em batch", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "A", sourceType: "GOODS_RECEIPT", unitPrice: 10, confidence: "HIGH", occurredAt: daysAgo(5) });
      recordPriceEvent(db, { chavePeca: "B", sourceType: "COTACAO", unitPrice: 20, confidence: "LOW", occurredAt: daysAgo(5) });
      const results = resolvePartCostsBatch(db, ["A", "B", "C"], "CURRENT_REPAIR");
      expect(results.get("A")!.unitCost).toBe(10);
      expect(results.get("B")!.unitCost).toBe(20);
      expect(results.get("C")!.confidence).toBe("MISSING");
    });
  });
});

describe("repair-parts-cost-service", () => {
  function setupCase(db: Db): number {
    db.prepare("INSERT INTO repair_cases (imei, imei_norm, brand, model, cost, estimated_sale, margin, workflow_status, created_at, updated_at) VALUES ('123','123','Apple','iPhone 11',500,1200,700,'PEDIR_PECA',datetime('now'),datetime('now'))").run();
    const caseId = 1;
    db.prepare("INSERT INTO part_requests (repair_case_id, description, chave_peca, chave_peca_norm, status, created_at, updated_at) VALUES (?, 'Bateria', 'BAT IPHONE 11', 'BAT IPHONE 11', 'PEDIR_PECA', datetime('now'), datetime('now'))").run(caseId);
    db.prepare("INSERT INTO part_requests (repair_case_id, description, chave_peca, chave_peca_norm, status, created_at, updated_at) VALUES (?, 'Tela', 'TELA IPHONE 11', 'TELA IPHONE 11', 'INDICADA', datetime('now'), datetime('now'))").run(caseId);
    return caseId;
  }

  it("calcula custo total com cobertura completa", () => {
    const db = freshDb();
    const caseId = setupCase(db);
    recordPriceEvent(db, { chavePeca: "BAT IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 45, confidence: "HIGH", occurredAt: daysAgo(10) });
    recordPriceEvent(db, { chavePeca: "TELA IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 120, confidence: "HIGH", occurredAt: daysAgo(10) });
    const r = calculateRepairPartsCost(db, caseId);
    expect(r.totalPartsCost).toBe(165);
    expect(r.coveragePercentage).toBe(100);
    expect(r.missingCostItems).toBe(0);
    expect(r.items).toHaveLength(2);
  });

  it("cobertura parcial quando falta preço de uma peça", () => {
    const db = freshDb();
    const caseId = setupCase(db);
    recordPriceEvent(db, { chavePeca: "BAT IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 45, confidence: "HIGH", occurredAt: daysAgo(10) });
    // TELA sem preço
    const r = calculateRepairPartsCost(db, caseId);
    expect(r.totalPartsCost).toBe(45);
    expect(r.coveragePercentage).toBe(50);
    expect(r.missingCostItems).toBe(1);
    expect(r.overallConfidence).toBe("MISSING");
  });

  it("ignora peças canceladas", () => {
    const db = freshDb();
    const caseId = setupCase(db);
    // Cancelar a bateria
    db.prepare("UPDATE part_requests SET status = 'CANCELADA', cancelled_at = datetime('now') WHERE chave_peca_norm = 'BAT IPHONE 11'").run();
    recordPriceEvent(db, { chavePeca: "TELA IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 120, confidence: "HIGH", occurredAt: daysAgo(10) });
    const r = calculateRepairPartsCost(db, caseId);
    expect(r.items).toHaveLength(1);
    expect(r.totalPartsCost).toBe(120);
  });

  it("ignora peças consumidas", () => {
    const db = freshDb();
    const caseId = setupCase(db);
    db.prepare("UPDATE part_requests SET status = 'CONSUMIDA' WHERE chave_peca_norm = 'BAT IPHONE 11'").run();
    recordPriceEvent(db, { chavePeca: "TELA IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 120, confidence: "HIGH", occurredAt: daysAgo(10) });
    const r = calculateRepairPartsCost(db, caseId);
    expect(r.items).toHaveLength(1);
  });

  it("retorna vazio para caso sem peças ativas", () => {
    const db = freshDb();
    db.prepare("INSERT INTO repair_cases (imei, imei_norm, brand, model, cost, estimated_sale, margin, workflow_status, created_at, updated_at) VALUES ('999','999','Samsung','S21',300,800,500,'PEDIR_PECA',datetime('now'),datetime('now'))").run();
    const r = calculateRepairPartsCost(db, 1);
    expect(r.items).toHaveLength(0);
    expect(r.coveragePercentage).toBe(100);
    expect(r.fingerprint).toBe("empty");
  });

  it("gera fingerprint diferente quando preço muda", () => {
    const db = freshDb();
    const caseId = setupCase(db);
    recordPriceEvent(db, { chavePeca: "BAT IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 45, confidence: "HIGH", occurredAt: daysAgo(10) });
    recordPriceEvent(db, { chavePeca: "TELA IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 120, confidence: "HIGH", occurredAt: daysAgo(10) });
    const r1 = calculateRepairPartsCost(db, caseId);
    // Adicionar novo preço para bateria
    recordPriceEvent(db, { chavePeca: "BAT IPHONE 11", sourceType: "GOODS_RECEIPT", unitPrice: 50, confidence: "HIGH", occurredAt: daysAgo(1) });
    const r2 = calculateRepairPartsCost(db, caseId);
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });
});

describe("repair-margin-service", () => {
  it("calcula margem legada e de reparo corretamente", () => {
    const r = calculateRepairMargin({
      estimatedSale: 1200,
      cost: 500,
      partsCostResult: {
        totalPartsCost: 165,
        coveragePercentage: 100,
        items: [
          { partRequestId: 1, chavePeca: "BAT", chavePecaNorm: "BAT", unitCost: 45, quantity: 1, totalCost: 45, confidence: "HIGH", sourceType: "GOODS_RECEIPT", isStale: false },
          { partRequestId: 2, chavePeca: "TELA", chavePecaNorm: "TELA", unitCost: 120, quantity: 1, totalCost: 120, confidence: "HIGH", sourceType: "GOODS_RECEIPT", isStale: false },
        ],
        overallConfidence: "HIGH",
        missingCostItems: 0,
        lowConfidenceItems: 0,
        fingerprint: "abc",
      },
    });
    expect(r.legacyMargin).toBe(700);
    expect(r.partsCost).toBe(165);
    expect(r.repairMargin).toBe(535);
    expect(r.repairCostRatio).toBeCloseTo(165 / 1200);
    expect(r.hasCompleteCostCoverage).toBe(true);
  });

  it("trata venda zero (ratio null)", () => {
    const r = calculateRepairMargin({
      estimatedSale: 0,
      cost: 500,
      partsCostResult: {
        totalPartsCost: 100,
        coveragePercentage: 100,
        items: [{ partRequestId: 1, chavePeca: "X", chavePecaNorm: "X", unitCost: 100, quantity: 1, totalCost: 100, confidence: "HIGH", sourceType: "GOODS_RECEIPT", isStale: false }],
        overallConfidence: "HIGH",
        missingCostItems: 0,
        lowConfidenceItems: 0,
        fingerprint: "x",
      },
    });
    expect(r.repairCostRatio).toBeNull();
  });

  it("trata custo ausente", () => {
    const r = calculateRepairMargin({
      estimatedSale: 1200,
      cost: null,
      partsCostResult: {
        totalPartsCost: 100,
        coveragePercentage: 100,
        items: [{ partRequestId: 1, chavePeca: "X", chavePecaNorm: "X", unitCost: 100, quantity: 1, totalCost: 100, confidence: "HIGH", sourceType: "GOODS_RECEIPT", isStale: false }],
        overallConfidence: "HIGH",
        missingCostItems: 0,
        lowConfidenceItems: 0,
        fingerprint: "x",
      },
    });
    expect(r.legacyMargin).toBeNull();
    expect(r.repairMargin).toBeNull();
  });

  it("cobertura incompleta", () => {
    const r = calculateRepairMargin({
      estimatedSale: 1200,
      cost: 500,
      partsCostResult: {
        totalPartsCost: 45,
        coveragePercentage: 50,
        items: [
          { partRequestId: 1, chavePeca: "BAT", chavePecaNorm: "BAT", unitCost: 45, quantity: 1, totalCost: 45, confidence: "HIGH", sourceType: "GOODS_RECEIPT", isStale: false },
          { partRequestId: 2, chavePeca: "TELA", chavePecaNorm: "TELA", unitCost: null, quantity: 1, totalCost: null, confidence: "MISSING", sourceType: null, isStale: false },
        ],
        overallConfidence: "MISSING",
        missingCostItems: 1,
        lowConfidenceItems: 0,
        fingerprint: "y",
      },
    });
    expect(r.hasCompleteCostCoverage).toBe(false);
    expect(r.partsCostCoverage).toBe(50);
  });

  it("sem peças → partsCost null, repairMargin null", () => {
    const r = calculateRepairMargin({
      estimatedSale: 1200,
      cost: 500,
      partsCostResult: {
        totalPartsCost: 0,
        coveragePercentage: 100,
        items: [],
        overallConfidence: "HIGH",
        missingCostItems: 0,
        lowConfidenceItems: 0,
        fingerprint: "empty",
      },
    });
    expect(r.partsCost).toBeNull();
    expect(r.repairMargin).toBeNull();
  });
});
