import { describe, it, expect } from "vitest";
import { deriveNextAction } from "../src/match/next-action-service.js";
import type { WorkflowStatus } from "../src/repair/repair-service.js";

describe("deriveNextAction", () => {
  it("EM_ANALISE → CONTINUE_ANALYSIS, enabled", () => {
    const a = deriveNextAction("EM_ANALISE");
    expect(a.code).toBe("CONTINUE_ANALYSIS");
    expect(a.enabled).toBe(true);
  });

  it("MATCH → SEPARATE_KIT, enabled", () => {
    const a = deriveNextAction("MATCH");
    expect(a.code).toBe("SEPARATE_KIT");
    expect(a.enabled).toBe(true);
  });

  it("MATCH_PARCIAL → SEPARATE_AVAILABLE, enabled", () => {
    const a = deriveNextAction("MATCH_PARCIAL");
    expect(a.code).toBe("SEPARATE_AVAILABLE");
    expect(a.enabled).toBe(true);
  });

  it("APTO_REPARO → DIRECT_TO_TECHNICIAN, enabled", () => {
    const a = deriveNextAction("APTO_REPARO");
    expect(a.code).toBe("DIRECT_TO_TECHNICIAN");
    expect(a.enabled).toBe(true);
  });

  it("DIRECIONADO_TECNICO → START_REPAIR habilitado", () => {
    const a = deriveNextAction("DIRECIONADO_TECNICO");
    expect(a.code).toBe("START_REPAIR");
    expect(a.enabled).toBe(true);
  });

  it("CONCLUIDO → VIEW_HISTORY", () => {
    const a = deriveNextAction("CONCLUIDO");
    expect(a.code).toBe("VIEW_HISTORY");
  });

  it("CANCELADO → VIEW_HISTORY", () => {
    const a = deriveNextAction("CANCELADO");
    expect(a.code).toBe("VIEW_HISTORY");
  });

  it("VERIFICAR → FIX_PENDING com role OPERATOR", () => {
    const a = deriveNextAction("VERIFICAR");
    expect(a.code).toBe("FIX_PENDING");
    expect(a.requiredRole).toBe("OPERATOR");
  });

  it("RETORNO_TECNICO → REOPEN_OR_REVIEW restrito a ADMIN", () => {
    const a = deriveNextAction("RETORNO_TECNICO");
    expect(a.code).toBe("REOPEN_OR_REVIEW");
    expect(a.requiredRole).toBe("ADMIN");
  });

  it("todos os WorkflowStatus retornam uma NextAction válida", () => {
    const statuses: WorkflowStatus[] = [
      "EM_ANALISE","PEDIR_PECA","AGUARDANDO_RECEBIMENTO",
      "MATCH_PARCIAL","MATCH","EM_SEPARACAO","APTO_REPARO",
      "DIRECIONADO_TECNICO","EM_REPARO","REPARO_EXECUTADO",
      "TRIAGEM_FINAL","RETORNO_TECNICO",
      "CONCLUIDO","VENDA_ESTADO","CANCELADO","VERIFICAR",
    ];
    for (const s of statuses) {
      const a = deriveNextAction(s);
      expect(a.code).toBeTruthy();
      expect(a.label).toBeTruthy();
      expect(["OPERATOR","ADMIN","ANY"]).toContain(a.requiredRole);
    }
  });
});
