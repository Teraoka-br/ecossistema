import { describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  recordPriceEvent,
  listPriceEvents,
  getLatestPrice,
  getPriceSummary,
} from "../src/operational/part-price-service.js";

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

describe("part-price-service", () => {
  describe("recordPriceEvent", () => {
    it("insere evento e retorna id", () => {
      const db = freshDb();
      const id = recordPriceEvent(db, {
        chavePeca: "BATERIA IPHONE 11",
        sourceType: "APPROVED_COTACAO",
        unitPrice: 45.50,
        quantity: 5,
        supplier: "Fornecedor A",
        confidence: "MEDIUM",
        createdBy: "admin",
        occurredAt: "2026-07-20T10:00:00Z",
      });
      expect(id).toBeGreaterThan(0);
    });

    it("rejeita preço negativo", () => {
      const db = freshDb();
      expect(() =>
        recordPriceEvent(db, {
          chavePeca: "TELA SAMSUNG",
          sourceType: "COTACAO",
          unitPrice: -10,
          confidence: "LOW",
          occurredAt: "2026-07-20T10:00:00Z",
        }),
      ).toThrow("negativo");
    });

    it("rejeita chavePeca vazia", () => {
      const db = freshDb();
      expect(() =>
        recordPriceEvent(db, {
          chavePeca: "",
          sourceType: "COTACAO",
          unitPrice: 10,
          confidence: "LOW",
          occurredAt: "2026-07-20T10:00:00Z",
        }),
      ).toThrow("obrigatória");
    });

    it("normaliza chavePeca corretamente", () => {
      const db = freshDb();
      recordPriceEvent(db, {
        chavePeca: "  bateria iphone 11 ",
        sourceType: "GOODS_RECEIPT",
        unitPrice: 40,
        confidence: "HIGH",
        occurredAt: "2026-07-20T10:00:00Z",
      });
      const events = listPriceEvents(db, { chavePecaNorm: "BATERIA IPHONE 11" });
      expect(events).toHaveLength(1);
      expect(events[0].chavePecaNorm).toBe("BATERIA IPHONE 11");
    });

    it("registra campos opcionais de vínculo", () => {
      const db = freshDb();
      // Criar registros referenciados para satisfazer FKs
      db.prepare("INSERT INTO cotacoes (supplier, status, created_by) VALUES ('Sup B', 'PENDING_APPROVAL', 'test')").run();
      db.prepare("INSERT INTO purchase_orders (order_number, supplier, status, created_by) VALUES ('PED-0001', 'Sup B', 'AWAITING_RECEIPT', 'test')").run();
      recordPriceEvent(db, {
        chavePeca: "TELA IPHONE 12",
        sourceType: "GOODS_RECEIPT",
        unitPrice: 120,
        effectiveUnitCost: 125,
        quantity: 3,
        supplier: "Sup B",
        cotacaoId: 1,
        cotacaoItemId: 10,
        purchaseOrderId: 1,
        purchaseOrderItemId: 50,
        goodsReceiptId: 2,
        goodsReceiptItemId: 20,
        confidence: "HIGH",
        previousPrice: 110,
        notes: "Teste completo",
        createdBy: "operador",
        occurredAt: "2026-07-21T14:00:00Z",
      });
      const ev = listPriceEvents(db, { chavePecaNorm: "TELA IPHONE 12" })[0];
      expect(ev.effectiveUnitCost).toBe(125);
      expect(ev.cotacaoId).toBe(1);
      expect(ev.goodsReceiptItemId).toBe(20);
      expect(ev.previousPrice).toBe(110);
      expect(ev.notes).toBe("Teste completo");
    });
  });

  describe("listPriceEvents", () => {
    it("filtra por chavePecaNorm", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT A", sourceType: "COTACAO", unitPrice: 10, confidence: "LOW", occurredAt: "2026-01-01" });
      recordPriceEvent(db, { chavePeca: "BAT B", sourceType: "COTACAO", unitPrice: 20, confidence: "LOW", occurredAt: "2026-01-01" });
      const results = listPriceEvents(db, { chavePecaNorm: "BAT A" });
      expect(results).toHaveLength(1);
      expect(results[0].chavePeca).toBe("BAT A");
    });

    it("filtra por sourceType", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "TELA", sourceType: "COTACAO", unitPrice: 10, confidence: "LOW", occurredAt: "2026-01-01" });
      recordPriceEvent(db, { chavePeca: "TELA", sourceType: "GOODS_RECEIPT", unitPrice: 12, confidence: "HIGH", occurredAt: "2026-01-02" });
      const results = listPriceEvents(db, { chavePecaNorm: "TELA", sourceType: "GOODS_RECEIPT" });
      expect(results).toHaveLength(1);
      expect(results[0].unitPrice).toBe(12);
    });

    it("ordena por occurred_at DESC", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "X", sourceType: "COTACAO", unitPrice: 1, confidence: "LOW", occurredAt: "2026-01-01" });
      recordPriceEvent(db, { chavePeca: "X", sourceType: "COTACAO", unitPrice: 2, confidence: "LOW", occurredAt: "2026-06-01" });
      recordPriceEvent(db, { chavePeca: "X", sourceType: "COTACAO", unitPrice: 3, confidence: "LOW", occurredAt: "2026-03-01" });
      const results = listPriceEvents(db, { chavePecaNorm: "X" });
      expect(results.map(e => e.unitPrice)).toEqual([2, 3, 1]);
    });

    it("respeita limit e offset", () => {
      const db = freshDb();
      for (let i = 0; i < 5; i++) {
        recordPriceEvent(db, { chavePeca: "Z", sourceType: "COTACAO", unitPrice: i, confidence: "LOW", occurredAt: `2026-0${i + 1}-01` });
      }
      const page = listPriceEvents(db, { chavePecaNorm: "Z", limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
    });
  });

  describe("getLatestPrice", () => {
    it("retorna o mais recente", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "COTACAO", unitPrice: 10, confidence: "LOW", occurredAt: "2026-01-01" });
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "GOODS_RECEIPT", unitPrice: 12, confidence: "HIGH", occurredAt: "2026-06-01" });
      const latest = getLatestPrice(db, "BAT");
      expect(latest).not.toBeNull();
      expect(latest!.unitPrice).toBe(12);
    });

    it("filtra por supplier", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "COTACAO", unitPrice: 10, supplier: "A", confidence: "LOW", occurredAt: "2026-06-01" });
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "COTACAO", unitPrice: 20, supplier: "B", confidence: "LOW", occurredAt: "2026-06-02" });
      const latest = getLatestPrice(db, "BAT", "A");
      expect(latest!.unitPrice).toBe(10);
    });

    it("retorna null quando não existe", () => {
      const db = freshDb();
      expect(getLatestPrice(db, "INEXISTENTE")).toBeNull();
    });
  });

  describe("getPriceSummary", () => {
    it("calcula estatísticas corretamente", () => {
      const db = freshDb();
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "COTACAO", unitPrice: 10, supplier: "A", confidence: "LOW", occurredAt: "2026-07-01" });
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "COTACAO", unitPrice: 20, supplier: "B", confidence: "LOW", occurredAt: "2026-07-10" });
      recordPriceEvent(db, { chavePeca: "BAT", sourceType: "GOODS_RECEIPT", unitPrice: 15, supplier: "A", confidence: "HIGH", occurredAt: "2026-07-15" });

      const summary = getPriceSummary(db, "BAT");
      expect(summary.eventCount).toBe(3);
      expect(summary.minPrice).toBe(10);
      expect(summary.maxPrice).toBe(20);
      expect(summary.latestPrice).toBe(15);
      expect(summary.latestSupplier).toBe("A");
      expect(summary.suppliers).toEqual(["A", "B"]);
    });

    it("retorna zeros para chave sem eventos", () => {
      const db = freshDb();
      const summary = getPriceSummary(db, "VAZIO");
      expect(summary.eventCount).toBe(0);
      expect(summary.latestPrice).toBeNull();
      expect(summary.suppliers).toEqual([]);
    });
  });

  describe("imutabilidade", () => {
    it("eventos são imutáveis — não existe UPDATE/DELETE", () => {
      const db = freshDb();
      const id = recordPriceEvent(db, {
        chavePeca: "TELA",
        sourceType: "COTACAO",
        unitPrice: 50,
        confidence: "LOW",
        occurredAt: "2026-07-01",
      });
      // Inserir correção cria novo evento, não altera o anterior
      recordPriceEvent(db, {
        chavePeca: "TELA",
        sourceType: "COST_CORRECTION",
        unitPrice: 55,
        previousPrice: 50,
        confidence: "HIGH",
        notes: "Correção de preço",
        occurredAt: "2026-07-02",
      });
      const events = listPriceEvents(db, { chavePecaNorm: "TELA" });
      expect(events).toHaveLength(2);
      expect(events[0].sourceType).toBe("COST_CORRECTION");
      expect(events[0].previousPrice).toBe(50);
      expect(events[1].unitPrice).toBe(50);
    });
  });
});
