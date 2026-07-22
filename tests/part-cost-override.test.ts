/**
 * Override manual de custo (Camada 7).
 * Cobre spec 7 (importação não apaga override), 8 (restauração remove),
 * 51/52 (auditoria de fonte e usuário).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { recordPriceEvent } from "../src/operational/part-price-service.js";
import { resolveEffectivePartCost } from "../src/operational/cost-resolution-service.js";
import {
  setPartCostOverride,
  restorePartCost,
  getActiveOverride,
  listActiveOverrides,
  PartCostOverrideError,
} from "../src/operational/part-cost-override-service.js";

let db: Db;
beforeEach(async () => { db = await createDb(); });

describe("part-cost-override", () => {
  it("override ativo tem precedência na resolução de custo", () => {
    recordPriceEvent(db, {
      chavePeca: "TELA OV", sourceType: "GOODS_RECEIPT",
      unitPrice: 100, confidence: "HIGH", occurredAt: new Date().toISOString(),
    });
    setPartCostOverride(db, {
      chavePeca: "TELA OV", unitCost: 80,
      justification: "negociação direta", userId: "gestor",
    });
    const r = resolveEffectivePartCost(db, { chavePecaNorm: "TELA OV", context: "CURRENT_REPAIR" });
    expect(r.unitCost).toBe(80);
    expect(r.sourceType).toBe("MANUAL_OVERRIDE");
  });

  it("(spec 7) nova cotação/importação não apaga override vigente", () => {
    setPartCostOverride(db, {
      chavePeca: "BAT OV", unitCost: 50,
      justification: "custo real conhecido", userId: "gestor",
    });
    recordPriceEvent(db, {
      chavePeca: "BAT OV", sourceType: "GOODS_RECEIPT",
      unitPrice: 999, confidence: "HIGH", occurredAt: new Date().toISOString(),
    });
    const r = resolveEffectivePartCost(db, { chavePecaNorm: "BAT OV", context: "CURRENT_REPAIR" });
    expect(r.unitCost).toBe(50);
    expect(getActiveOverride(db, "BAT OV")).not.toBeNull();
  });

  it("(spec 8) restauração remove override e volta ao valor calculado", () => {
    recordPriceEvent(db, {
      chavePeca: "CAM OV", sourceType: "GOODS_RECEIPT",
      unitPrice: 70, confidence: "HIGH", occurredAt: new Date().toISOString(),
    });
    setPartCostOverride(db, {
      chavePeca: "CAM OV", unitCost: 40,
      justification: "teste temporário", userId: "gestor",
    });
    restorePartCost(db, { chavePeca: "CAM OV", reason: "voltar ao calculado", userId: "gestor" });

    expect(getActiveOverride(db, "CAM OV")).toBeNull();
    const r = resolveEffectivePartCost(db, { chavePecaNorm: "CAM OV", context: "CURRENT_REPAIR" });
    expect(r.unitCost).toBe(70);
    expect(r.sourceType).toBe("GOODS_RECEIPT");
    // Auditoria da restauração preservada
    const row = db.prepare(
      "SELECT restored_by, restore_reason FROM part_cost_overrides WHERE chave_peca_norm = 'CAM OV'",
    ).get() as { restored_by: string; restore_reason: string };
    expect(row.restored_by).toBe("gestor");
    expect(row.restore_reason).toContain("voltar");
  });

  it("(spec 51/52) override registra usuário, valor anterior e evento de preço", () => {
    recordPriceEvent(db, {
      chavePeca: "ALTO OV", sourceType: "GOODS_RECEIPT",
      unitPrice: 120, confidence: "HIGH", occurredAt: new Date().toISOString(),
    });
    const ov = setPartCostOverride(db, {
      chavePeca: "ALTO OV", unitCost: 90,
      justification: "acordo com fornecedor", userId: "maria",
    });
    expect(ov.createdBy).toBe("maria");
    expect(ov.previousResolvedCost).toBe(120);

    const ev = db.prepare(
      "SELECT * FROM part_price_events WHERE chave_peca_norm = 'ALTO OV' AND source_type = 'MANUAL_OVERRIDE'",
    ).get() as Record<string, unknown>;
    expect(ev).toBeDefined();
    expect(ev.unit_price).toBe(90);
    expect(ev.previous_price).toBe(120);
    expect(ev.created_by).toBe("maria");
  });

  it("substituição desativa o anterior e mantém um único ativo", () => {
    setPartCostOverride(db, { chavePeca: "SUB OV", unitCost: 10, justification: "primeiro valor", userId: "a" });
    setPartCostOverride(db, { chavePeca: "SUB OV", unitCost: 20, justification: "segundo valor", userId: "b" });
    const active = listActiveOverrides(db).filter((o) => o.chavePecaNorm === "SUB OV");
    expect(active).toHaveLength(1);
    expect(active[0].unitCost).toBe(20);
  });

  it("exige justificativa e custo válido", () => {
    expect(() => setPartCostOverride(db, { chavePeca: "X", unitCost: 10, justification: "ab", userId: null }))
      .toThrowError(PartCostOverrideError);
    expect(() => setPartCostOverride(db, { chavePeca: "X", unitCost: -1, justification: "custo inválido", userId: null }))
      .toThrowError(PartCostOverrideError);
    expect(() => restorePartCost(db, { chavePeca: "SEM OVERRIDE", reason: "não existe", userId: null }))
      .toThrowError(PartCostOverrideError);
  });
});
