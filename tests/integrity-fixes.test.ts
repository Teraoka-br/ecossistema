import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import { recordPriceEvent } from "../src/operational/part-price-service.js";
import { resolveEffectivePartCost } from "../src/operational/cost-resolution-service.js";
import { backfillPriceEvents } from "../src/operational/part-price-backfill.js";
import { calculateRepairPartsCost } from "../src/operational/repair-parts-cost-service.js";
import { deleteUser } from "../src/auth/auth-service.js";
import { setPartCostOverride, restorePartCost } from "../src/operational/part-cost-override-service.js";

function freshDb(): Db {
  const d = openDatabase(":memory:");
  runMigrations(d);
  return d;
}

let db: Db;

beforeEach(() => {
  db = freshDb();
});

// ── 1. User soft-delete preserves FK integrity ─────────────────────────

describe("user soft-delete", () => {
  it("deleteUser desativa em vez de excluir fisicamente", async () => {
    const { setupFirstUser } = await import("../src/auth/auth-service.js");
    const admin = await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    const { createUser } = await import("../src/auth/auth-service.js");
    const op = await createUser(db, { username: "operador", displayName: "Op", pin: "5678", role: "OPERATOR" }, admin.id);

    deleteUser(db, op.id);

    const row = db.prepare("SELECT active FROM users WHERE id = ?").get(op.id) as { active: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.active).toBe(0);
  });

  it("sessões e permissões são removidas ao desativar", async () => {
    const { setupFirstUser, createUser } = await import("../src/auth/auth-service.js");
    const admin = await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    const op = await createUser(db, { username: "operador", displayName: "Op", pin: "5678", role: "OPERATOR" }, admin.id);

    db.prepare("INSERT INTO user_permissions (user_id, permission, granted_by) VALUES (?,?,?)").run(op.id, "MANAGE_PART_COSTS", admin.id);
    deleteUser(db, op.id);

    const perms = db.prepare("SELECT * FROM user_permissions WHERE user_id = ?").all(op.id);
    expect(perms.length).toBe(0);
  });

  it("FK violations = 0 após desativação", async () => {
    const { setupFirstUser, createUser } = await import("../src/auth/auth-service.js");
    const admin = await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    const op = await createUser(db, { username: "op", displayName: "Op", pin: "5678", role: "OPERATOR" }, admin.id);

    // Create an audit log entry referencing the user
    db.prepare("INSERT INTO audit_log (user_id, action) VALUES (?, 'TEST')").run(op.id);
    deleteUser(db, op.id);

    db.exec("PRAGMA foreign_keys = ON");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations.length).toBe(0);
  });
});

// ── 2. part_price_events immutability ──────────────────────────────────

describe("part_price_events immutability", () => {
  it("INSERT é permitido", () => {
    const id = recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12",
      sourceType: "COTACAO",
      unitPrice: 100,
      confidence: "MEDIUM",
      occurredAt: new Date().toISOString(),
    });
    expect(id).toBeGreaterThan(0);
  });

  it("UPDATE é bloqueado", () => {
    const id = recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12",
      sourceType: "COTACAO",
      unitPrice: 100,
      confidence: "MEDIUM",
      occurredAt: new Date().toISOString(),
    });
    expect(() => {
      db.prepare("UPDATE part_price_events SET unit_price = 200 WHERE id = ?").run(id);
    }).toThrow(/append-only.*UPDATE/i);
  });

  it("DELETE é bloqueado", () => {
    const id = recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12",
      sourceType: "COTACAO",
      unitPrice: 100,
      confidence: "MEDIUM",
      occurredAt: new Date().toISOString(),
    });
    expect(() => {
      db.prepare("DELETE FROM part_price_events WHERE id = ?").run(id);
    }).toThrow(/append-only.*DELETE/i);
  });
});

// ── 3. Override restore does not contaminate cost resolution ────────────

describe("override restore cost resolution", () => {
  function seedCaseAndParts() {
    db.prepare(`INSERT INTO repair_cases (id, imei, brand, model, estimated_sale, cost, age_days, analysis_status, workflow_status)
      VALUES (1, '123456789012345', 'Apple', 'iPhone 12', 1500, 500, 30, 'COMPLETED', 'PEDIR_PECA')`).run();
  }

  it("após restaurar override, resolve pela melhor fonte normal (GOODS_RECEIPT)", () => {
    seedCaseAndParts();
    recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12", sourceType: "GOODS_RECEIPT",
      unitPrice: 80, confidence: "HIGH", occurredAt: "2026-07-01T00:00:00Z",
    });

    setPartCostOverride(db, {
      chavePeca: "TELA IPHONE 12", unitCost: 120, justification: "Preço atualizado pelo fornecedor", userId: "admin",
    });

    let cost = resolveEffectivePartCost(db, { chavePecaNorm: "TELA IPHONE 12", context: "CURRENT_REPAIR" });
    expect(cost.unitCost).toBe(120);
    expect(cost.sourceType).toBe("MANUAL_OVERRIDE");

    restorePartCost(db, { chavePeca: "TELA IPHONE 12", reason: "Voltando ao preço original", userId: "admin" });

    cost = resolveEffectivePartCost(db, { chavePecaNorm: "TELA IPHONE 12", context: "CURRENT_REPAIR" });
    expect(cost.unitCost).toBe(80);
    expect(cost.sourceType).toBe("GOODS_RECEIPT");
  });

  it("após restaurar override sem fonte anterior, retorna MISSING", () => {
    seedCaseAndParts();

    setPartCostOverride(db, {
      chavePeca: "BATERIA MOTO G", unitCost: 50, justification: "Definição manual inicial", userId: "admin",
    });
    restorePartCost(db, { chavePeca: "BATERIA MOTO G", reason: "Preço incorreto", userId: "admin" });

    const cost = resolveEffectivePartCost(db, { chavePecaNorm: "BATERIA MOTO G", context: "CURRENT_REPAIR" });
    expect(cost.unitCost).toBeNull();
    expect(cost.confidence).toBe("MISSING");
  });

  it("após restaurar override, resolve por APPROVED_COTACAO", () => {
    seedCaseAndParts();
    recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12", sourceType: "APPROVED_COTACAO",
      unitPrice: 95, confidence: "MEDIUM", occurredAt: "2026-07-10T00:00:00Z",
    });

    setPartCostOverride(db, {
      chavePeca: "TELA IPHONE 12", unitCost: 130, justification: "Reajuste", userId: "admin",
    });
    restorePartCost(db, { chavePeca: "TELA IPHONE 12", reason: "Revertendo reajuste", userId: "admin" });

    const cost = resolveEffectivePartCost(db, { chavePecaNorm: "TELA IPHONE 12", context: "CURRENT_REPAIR" });
    expect(cost.unitCost).toBe(95);
    expect(cost.sourceType).toBe("APPROVED_COTACAO");
  });

  it("após restaurar override, resolve por BACKFILL_COTACAO", () => {
    seedCaseAndParts();
    recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12", sourceType: "BACKFILL_COTACAO",
      unitPrice: 70, confidence: "MEDIUM", occurredAt: "2026-06-01T00:00:00Z",
    });

    setPartCostOverride(db, {
      chavePeca: "TELA IPHONE 12", unitCost: 110, justification: "Override teste", userId: "admin",
    });
    restorePartCost(db, { chavePeca: "TELA IPHONE 12", reason: "Revert", userId: "admin" });

    const cost = resolveEffectivePartCost(db, { chavePecaNorm: "TELA IPHONE 12", context: "CURRENT_REPAIR" });
    expect(cost.unitCost).toBe(70);
    expect(cost.sourceType).toBe("BACKFILL_COTACAO");
  });

  it("após restaurar override, resolve por compatibilidade", () => {
    seedCaseAndParts();

    // Create compatibility group
    db.prepare("INSERT INTO part_compatibility_groups (id, name) VALUES (1, 'Tela iPhone 12')").run();
    db.prepare("INSERT INTO part_compatibility_group_members (group_id, chave_peca, chave_peca_norm) VALUES (1, 'TELA IPHONE 12', 'TELA IPHONE 12')").run();
    db.prepare("INSERT INTO part_compatibility_group_members (group_id, chave_peca, chave_peca_norm) VALUES (1, 'TELA IPHONE 12 PRO', 'TELA IPHONE 12 PRO')").run();

    recordPriceEvent(db, {
      chavePeca: "TELA IPHONE 12 PRO", sourceType: "GOODS_RECEIPT",
      unitPrice: 90, confidence: "HIGH", occurredAt: "2026-07-05T00:00:00Z",
    });

    setPartCostOverride(db, {
      chavePeca: "TELA IPHONE 12", unitCost: 150, justification: "Override teste", userId: "admin",
    });
    restorePartCost(db, { chavePeca: "TELA IPHONE 12", reason: "Revert", userId: "admin" });

    const cost = resolveEffectivePartCost(db, {
      chavePecaNorm: "TELA IPHONE 12", context: "CURRENT_REPAIR",
      compatGroupMembers: ["TELA IPHONE 12", "TELA IPHONE 12 PRO"],
    });
    expect(cost.unitCost).toBe(90);
    expect(cost.confidence).toBe("MEDIUM"); // demoted from HIGH
  });
});

// ── 4. Backfill idempotency (per-record) ───────────────────────────────

describe("backfill per-record idempotency", () => {
  function seedCotacaoData() {
    db.prepare("INSERT INTO cotacoes (id, supplier, status, approved_at, approved_by) VALUES (1, 'Forn A', 'APPROVED', '2026-07-01', 'admin')").run();
    db.prepare("INSERT INTO cotacao_items (id, cotacao_id, chave_peca, qtde, valor_unitario, aprovado) VALUES (1, 1, 'TELA A', 2, 50, 1)").run();
    db.prepare("INSERT INTO cotacao_items (id, cotacao_id, chave_peca, qtde, valor_unitario, aprovado) VALUES (2, 1, 'TELA B', 1, 80, 1)").run();
  }

  it("segunda execução produz zero novos eventos", () => {
    seedCotacaoData();
    const r1 = backfillPriceEvents(db);
    expect(r1.cotacaoEventsCreated).toBe(2);

    const r2 = backfillPriceEvents(db);
    expect(r2.cotacaoEventsCreated).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it("execução parcial pode ser completada", () => {
    seedCotacaoData();

    // Manually create a backfill event for item 1 only
    recordPriceEvent(db, {
      chavePeca: "TELA A", sourceType: "BACKFILL_COTACAO",
      unitPrice: 50, quantity: 2, confidence: "MEDIUM",
      cotacaoId: 1, cotacaoItemId: 1,
      occurredAt: "2026-07-01", createdBy: "backfill",
    });

    const r = backfillPriceEvents(db);
    expect(r.cotacaoEventsCreated).toBe(1); // only TELA B
    expect(r.skipped).toBe(1); // TELA A already done
  });
});

// ── 5. Deterministic cost resolution ───────────────────────────────────

describe("deterministic cost resolution", () => {
  it("same data in different insert order produces same result", () => {
    // Insert events in order A then B
    recordPriceEvent(db, {
      chavePeca: "TELA X", sourceType: "COTACAO",
      unitPrice: 100, confidence: "LOW",
      supplier: "Forn A", occurredAt: "2026-07-01T00:00:00Z",
    });
    recordPriceEvent(db, {
      chavePeca: "TELA X", sourceType: "COTACAO",
      unitPrice: 110, confidence: "LOW",
      supplier: "Forn A", occurredAt: "2026-07-10T00:00:00Z",
    });

    const result1 = resolveEffectivePartCost(db, { chavePecaNorm: "telax", context: "CURRENT_REPAIR" });

    // Now in a fresh DB with reversed insert order
    const db2 = freshDb();
    recordPriceEvent(db2, {
      chavePeca: "TELA X", sourceType: "COTACAO",
      unitPrice: 110, confidence: "LOW",
      supplier: "Forn A", occurredAt: "2026-07-10T00:00:00Z",
    });
    recordPriceEvent(db2, {
      chavePeca: "TELA X", sourceType: "COTACAO",
      unitPrice: 100, confidence: "LOW",
      supplier: "Forn A", occurredAt: "2026-07-01T00:00:00Z",
    });

    const result2 = resolveEffectivePartCost(db2, { chavePecaNorm: "telax", context: "CURRENT_REPAIR" });

    expect(result1.unitCost).toBe(result2.unitCost);
    expect(result1.sourceType).toBe(result2.sourceType);
    expect(result1.occurredAt).toBe(result2.occurredAt);
  });

  it("compatibility fallback is deterministic with sorted keys", () => {
    db.prepare("INSERT INTO part_compatibility_groups (id, name) VALUES (1, 'Telas X')").run();
    db.prepare("INSERT INTO part_compatibility_group_members (group_id, chave_peca, chave_peca_norm) VALUES (1, 'TELA X', 'TELA X')").run();
    db.prepare("INSERT INTO part_compatibility_group_members (group_id, chave_peca, chave_peca_norm) VALUES (1, 'TELA Y', 'TELA Y')").run();
    db.prepare("INSERT INTO part_compatibility_group_members (group_id, chave_peca, chave_peca_norm) VALUES (1, 'TELA Z', 'TELA Z')").run();

    recordPriceEvent(db, {
      chavePeca: "TELA Y", sourceType: "GOODS_RECEIPT",
      unitPrice: 90, confidence: "HIGH", occurredAt: "2026-07-01T00:00:00Z",
    });
    recordPriceEvent(db, {
      chavePeca: "TELA Z", sourceType: "GOODS_RECEIPT",
      unitPrice: 95, confidence: "HIGH", occurredAt: "2026-07-01T00:00:00Z",
    });

    // With keys in different order, should get same result (sorted → telay first)
    const r1 = resolveEffectivePartCost(db, {
      chavePecaNorm: "telax", context: "CURRENT_REPAIR",
      compatGroupMembers: ["telax", "telaz", "telay"],
    });
    const r2 = resolveEffectivePartCost(db, {
      chavePecaNorm: "telax", context: "CURRENT_REPAIR",
      compatGroupMembers: ["telax", "telay", "telaz"],
    });

    expect(r1.unitCost).toBe(r2.unitCost);
  });
});

// ── 6. Deterministic fingerprint ───────────────────────────────────────

describe("deterministic fingerprint", () => {
  it("same parts produce same fingerprint regardless of query order", () => {
    db.prepare(`INSERT INTO repair_cases (id, imei, brand, model, analysis_status, workflow_status)
      VALUES (1, '111111111111111', 'Apple', 'iPhone 12', 'COMPLETED', 'PEDIR_PECA')`).run();

    db.prepare(`INSERT INTO part_requests (id, repair_case_id, chave_peca, chave_peca_norm, status)
      VALUES (1, 1, 'TELA A', 'TELA A', 'PEDIR_PECA')`).run();
    db.prepare(`INSERT INTO part_requests (id, repair_case_id, chave_peca, chave_peca_norm, status)
      VALUES (2, 1, 'TELA B', 'TELA B', 'PEDIR_PECA')`).run();

    const r1 = calculateRepairPartsCost(db, 1);

    // Same setup in another DB but parts inserted in reverse order
    const db2 = freshDb();
    db2.prepare(`INSERT INTO repair_cases (id, imei, brand, model, analysis_status, workflow_status)
      VALUES (1, '111111111111111', 'Apple', 'iPhone 12', 'COMPLETED', 'PEDIR_PECA')`).run();
    db2.prepare(`INSERT INTO part_requests (id, repair_case_id, chave_peca, chave_peca_norm, status)
      VALUES (2, 1, 'TELA B', 'TELA B', 'PEDIR_PECA')`).run();
    db2.prepare(`INSERT INTO part_requests (id, repair_case_id, chave_peca, chave_peca_norm, status)
      VALUES (1, 1, 'TELA A', 'TELA A', 'PEDIR_PECA')`).run();

    const r2 = calculateRepairPartsCost(db2, 1);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it("different prices produce different fingerprint", () => {
    db.prepare(`INSERT INTO repair_cases (id, imei, brand, model, analysis_status, workflow_status)
      VALUES (1, '111111111111111', 'Apple', 'iPhone 12', 'COMPLETED', 'PEDIR_PECA')`).run();
    db.prepare(`INSERT INTO part_requests (id, repair_case_id, chave_peca, chave_peca_norm, status)
      VALUES (1, 1, 'TELA A', 'TELA A', 'PEDIR_PECA')`).run();

    recordPriceEvent(db, {
      chavePeca: "TELA A", sourceType: "COTACAO",
      unitPrice: 80, confidence: "LOW", occurredAt: "2026-06-01T00:00:00Z",
    });
    const r1 = calculateRepairPartsCost(db, 1);

    recordPriceEvent(db, {
      chavePeca: "TELA A", sourceType: "GOODS_RECEIPT",
      unitPrice: 100, confidence: "HIGH", occurredAt: "2026-07-01T00:00:00Z",
    });

    const r2 = calculateRepairPartsCost(db, 1);
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });
});

// ── 7. Economic evaluation staleness ───────────────────────────────────

describe("economic evaluation staleness", () => {
  it("detects stale evaluation when fingerprint changes", async () => {
    // Setup: active rule
    // Desativar regras existentes e criar uma para o teste
    db.prepare("UPDATE match_rule_sets SET active = 0").run();
    db.prepare(`INSERT INTO match_rule_sets (id, name, version, active, margin_weight, age_weight, margin_amount_per_point, age_days_per_point, age_max_points)
      VALUES (100, 'Regra Teste', 100, 1, 0.7, 0.3, 100, 30, 10)`).run();

    db.prepare(`INSERT INTO repair_cases (id, imei, brand, model, estimated_sale, cost, age_days, analysis_status, workflow_status)
      VALUES (1, '111111111111111', 'Apple', 'iPhone 12', 1500, 500, 30, 'COMPLETED', 'PEDIR_PECA')`).run();
    db.prepare(`INSERT INTO part_requests (id, repair_case_id, chave_peca, chave_peca_norm, status)
      VALUES (1, 1, 'TELA A', 'TELA A', 'PEDIR_PECA')`).run();

    const { evaluateEconomics, getEconomicEvaluation } = await import("../src/match/economic-evaluation-service.js");
    evaluateEconomics(db);

    let ev = getEconomicEvaluation(db, 1);
    expect(ev).not.toBeNull();
    expect(ev!.isStale).toBe(false);

    // Now add a price event → fingerprint changes
    recordPriceEvent(db, {
      chavePeca: "TELA A", sourceType: "GOODS_RECEIPT",
      unitPrice: 200, confidence: "HIGH", occurredAt: "2026-07-20T00:00:00Z",
    });

    ev = getEconomicEvaluation(db, 1);
    expect(ev!.isStale).toBe(true);
  });
});
