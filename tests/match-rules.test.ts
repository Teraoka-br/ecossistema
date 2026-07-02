import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  getActiveRuleSet, createDraftRuleSet, activateRuleSet, listRuleSets, computeScore,
  MatchRuleError,
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

  it("computeScore — fórmula padrão", () => {
    const rule = getActiveRuleSet(db);
    const { marginPoints, agePoints, score } = computeScore(rule, 90, 450);
    expect(agePoints).toBe(3); // floor(90/30)=3
    expect(marginPoints).toBe(3); // floor(450/150)=3
    expect(score).toBe(6);
  });

  it("computeScore — teto de idade", () => {
    const rule = getActiveRuleSet(db);
    const { agePoints } = computeScore(rule, 9999, 0);
    expect(agePoints).toBe(15);
  });

  it("computeScore — margem negativa pune", () => {
    const rule = getActiveRuleSet(db);
    const { marginPoints } = computeScore(rule, 0, -300);
    expect(marginPoints).toBe(-2); // floor(-300/150)=-2
    expect(marginPoints).toBeLessThan(0);
  });

  it("computeScore — margem nula não causa crash", () => {
    const rule = getActiveRuleSet(db);
    const { marginPoints, score } = computeScore(rule, 60, null);
    expect(marginPoints).toBe(0);
    expect(score).toBe(2); // só pontos de idade
  });
});
