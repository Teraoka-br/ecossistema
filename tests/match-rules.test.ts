import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  getActiveRuleSet, createDraftRuleSet, activateRuleSet, listRuleSets,
  MatchRuleError, validateActiveRule, updateDraftRuleSet,
} from "../src/match/match-rule-service.js";

let db: Db;
beforeEach(async () => { db = await createDb(); });

describe("match_rule_sets", () => {
  it("deve existir uma regra ativa após migrations", () => {
    const rule = getActiveRuleSet(db);
    expect(rule.active).toBe(true);
    expect(rule.version).toBe(1);
    expect(rule.marginAmountPerPoint).toBe(150);
    expect(rule.ageDaysPerPoint).toBe(30);
    expect(rule.ageMaxPoints).toBe(15);
  });

  it("cria rascunho com próxima versão", () => {
    const draft = createDraftRuleSet(db, { marginAmountPerPoint: 200, reason: "Teste" });
    expect(draft.version).toBe(2);
    expect(draft.active).toBe(false);
    expect(draft.marginAmountPerPoint).toBe(200);
  });

  it("somente uma regra ativa por vez", () => {
    const draft = createDraftRuleSet(db, { reason: "Nova" });
    activateRuleSet(db, draft.id, { reason: "Ativando v2", userId: null });
    const rules = listRuleSets(db);
    const actives = rules.filter(r => r.active);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(draft.id);
  });

  it("regra ativa não pode ser editada — deve ser criada nova versão", () => {
    const active = getActiveRuleSet(db);
    expect(() => {
      const { updateDraftRuleSet } = require("../src/match/match-rule-service.js");
      updateDraftRuleSet(db, active.id, { reason: "tentativa" }, null);
    }).toThrow();
  });

  it("ativação exige justificativa mínima de 5 chars", () => {
    const draft = createDraftRuleSet(db, {});
    expect(() => activateRuleSet(db, draft.id, { reason: "ab", userId: null }))
      .toThrow(MatchRuleError);
  });

  // O cálculo de score foi consolidado em calculate-match.ts (computeRuleScore,
  // sem arredondamento) — testado em tests/calculate-match.test.ts.

  it("validateActiveRule recusa marginAmountPerPoint = 0", () => {
    expect(validateActiveRule({ marginAmountPerPoint: 0, ageDaysPerPoint: 30, ageMaxPoints: 12, marginWeight: 1, ageWeight: 1 }))
      .not.toBeNull();
  });

  it("validateActiveRule recusa ageDaysPerPoint negativo", () => {
    expect(validateActiveRule({ marginAmountPerPoint: 150, ageDaysPerPoint: -5, ageMaxPoints: 12, marginWeight: 1, ageWeight: 1 }))
      .not.toBeNull();
  });

  it("validateActiveRule recusa NaN", () => {
    expect(validateActiveRule({ marginAmountPerPoint: NaN, ageDaysPerPoint: 30, ageMaxPoints: 12, marginWeight: 1, ageWeight: 1 }))
      .not.toBeNull();
  });

  it("validateActiveRule recusa Infinity", () => {
    expect(validateActiveRule({ marginAmountPerPoint: Infinity, ageDaysPerPoint: 30, ageMaxPoints: 12, marginWeight: 1, ageWeight: 1 }))
      .not.toBeNull();
  });

  it("validateActiveRule aceita ageMaxPoints = 0 (desabilita componente de idade)", () => {
    expect(validateActiveRule({ marginAmountPerPoint: 150, ageDaysPerPoint: 30, ageMaxPoints: 0, marginWeight: 1, ageWeight: 1 }))
      .toBeNull();
  });

  it("validateActiveRule aceita marginWeight = 0 (ignora margem)", () => {
    expect(validateActiveRule({ marginAmountPerPoint: 150, ageDaysPerPoint: 30, ageMaxPoints: 12, marginWeight: 0, ageWeight: 1 }))
      .toBeNull();
  });

  it("createDraftRuleSet rejeita marginAmountPerPoint = 0", () => {
    expect(() => createDraftRuleSet(db, { marginAmountPerPoint: 0 }))
      .toThrow(MatchRuleError);
  });

  it("createDraftRuleSet rejeita ageDaysPerPoint = NaN", () => {
    expect(() => createDraftRuleSet(db, { ageDaysPerPoint: NaN }))
      .toThrow(MatchRuleError);
  });

  it("updateDraftRuleSet rejeita marginWeight negativo", () => {
    const draft = createDraftRuleSet(db, {});
    expect(() => updateDraftRuleSet(db, draft.id, { marginWeight: -1 }, null))
      .toThrow(MatchRuleError);
  });

  it("activateRuleSet rejeita regra com parâmetros inválidos", () => {
    // Insere diretamente um rascunho com valor inválido (contornando a validação do service)
    db.prepare(
      "INSERT INTO match_rule_sets (version, name, margin_amount_per_point, age_days_per_point, age_max_points, margin_weight, age_weight, active) VALUES (99,'INVÁLIDA',0,30,12,1,1,0)"
    ).run();
    const bad = (db.prepare("SELECT * FROM match_rule_sets WHERE version = 99").get() as { id: number });
    expect(() => activateRuleSet(db, bad.id, { reason: "testando parâmetro inválido", userId: null }))
      .toThrow(MatchRuleError);
  });

  it("cria regra com manualPriorityEnabled=true e persiste o valor", () => {
    const draft = createDraftRuleSet(db, { manualPriorityEnabled: true });
    expect(draft.manualPriorityEnabled).toBe(true);
  });

  it("manualPriorityEnabled default é false", () => {
    const draft = createDraftRuleSet(db, {});
    expect(draft.manualPriorityEnabled).toBe(false);
  });
});
