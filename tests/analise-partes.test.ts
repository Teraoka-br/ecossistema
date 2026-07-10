/**
 * Testes para a validação de peças na tela Analisar aparelho.
 *
 * Cobre:
 * - linha preenchida conta como válida (computeBlockers filtra vazias)
 * - linha vazia não bloqueia quando há outra peça válida
 * - linha com incluirCor=true mas sem cor gera erro específico
 * - navegação por teclado presente no código-fonte
 * - backend valida parts.length === 0 (rota analise-routes.ts)
 * - estado vazio da fila após beta limpo (FilaReparos.tsx)
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Analise.tsx — validação de peças (computeBlockers)
// ---------------------------------------------------------------------------

describe("Analise.tsx: computeBlockers — peças", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "client", "pages", "Analise.tsx"),
    "utf8",
  );

  it("filtra partes vazias antes de validar (pecaNome.trim() !== '')", () => {
    // validParts = parts.filter(...) aparece em computeBlockers
    expect(src).toContain('p.pecaNome.trim() !== ""');
    expect(src).toContain("validParts");
  });

  it("bloqueia finalização apenas quando não há peça preenchida (validParts.length === 0)", () => {
    expect(src).toContain("validParts.length === 0");
    expect(src).toContain("Ao menos uma peça obrigatória.");
  });

  it("erro de cor é checado em validParts, não em todas as partes", () => {
    const lines = src.split("\n");
    const missingCorLine = lines.find((l) => l.includes("missingCor") && l.includes("find"));
    expect(missingCorLine).toBeDefined();
    expect(missingCorLine).toContain("validParts");
  });

  it("linhas vazias são removidas do payload antes de enviar ao backend", () => {
    // .filter deve aparecer antes do .map no trecho de partsPayload
    const payloadIdx  = src.indexOf("partsPayload");
    const filterAfter = src.indexOf('.filter((p) => p.pecaNome.trim() !== "")', payloadIdx);
    expect(filterAfter).toBeGreaterThan(payloadIdx - 1);
    expect(filterAfter).toBeLessThan(payloadIdx + 200);
  });
});

// ---------------------------------------------------------------------------
// 2. Analise.tsx — autocomplete com navegação por teclado
// ---------------------------------------------------------------------------

describe("Analise.tsx: autocomplete — navegação por teclado", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "client", "pages", "Analise.tsx"),
    "utf8",
  );

  it("estado highlightedSuggIdx existe", () => {
    expect(src).toContain("highlightedSuggIdx");
  });

  it("onKeyDown trata ArrowDown (incrementa índice)", () => {
    expect(src).toContain('"ArrowDown"');
    expect(src).toContain("Math.min");
  });

  it("onKeyDown trata ArrowUp (decrementa índice)", () => {
    expect(src).toContain('"ArrowUp"');
    expect(src).toContain("Math.max");
  });

  it("onKeyDown Enter seleciona sugestão destacada quando índice ≥ 0", () => {
    expect(src).toContain('"Enter"');
    expect(src).toContain("highlightedSuggIdx >= 0");
  });

  it("onKeyDown Escape fecha a lista de sugestões", () => {
    expect(src).toContain('"Escape"');
  });

  it("sugestão destacada recebe fundo diferente (var(--elevated))", () => {
    expect(src).toContain("idx === highlightedSuggIdx");
    expect(src).toContain("var(--elevated)");
  });

  it("onMouseEnter sincroniza o índice com o hover do mouse", () => {
    expect(src).toContain("onMouseEnter");
    expect(src).toContain("setHighlightedSuggIdx(idx)");
  });

  it("fetchSuggestions reseta highlightedSuggIdx ao receber novas sugestões", () => {
    // Deve aparecer setHighlightedSuggIdx(-1) dentro de fetchSuggestions
    const fetchIdx = src.indexOf("fetchSuggestions");
    const resetIdx = src.indexOf("setHighlightedSuggIdx(-1)", fetchIdx);
    expect(resetIdx).toBeGreaterThan(fetchIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. Backend: analise-routes.ts valida parts.length === 0
// ---------------------------------------------------------------------------

describe("analise-routes.ts: validação de partes", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "server", "routes", "analise-routes.ts"),
    "utf8",
  );

  it("rejeita partes vazias com status 400", () => {
    expect(src).toContain("parts.length === 0");
    expect(src).toContain("Ao menos uma peça é obrigatória.");
    expect(src).toContain("status(400)");
  });

  it("valida incluirCor sem cor com erro específico", () => {
    expect(src).toContain("p.incluirCor && !p.corUsada");
    expect(src).toContain("Cor obrigatória para peça");
  });
});

// ---------------------------------------------------------------------------
// 4. FilaReparos.tsx — estado vazio após beta limpo
// ---------------------------------------------------------------------------

describe("FilaReparos.tsx: estado vazio quando kpiTotal === 0", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
    "utf8",
  );

  it("exibe 'Nenhum aparelho importado ainda' quando kpiTotal === 0", () => {
    expect(src).toContain("kpiTotal === 0");
    expect(src).toContain("Nenhum aparelho importado ainda");
  });

  it("checagem de kpiTotal === 0 vem antes das mensagens de filtro", () => {
    const zeroIdx   = src.indexOf("kpiTotal === 0");
    const filterIdx = src.indexOf("Nenhum aparelho no filtro");
    expect(zeroIdx).toBeGreaterThan(0);
    expect(filterIdx).toBeGreaterThan(zeroIdx);
  });

  it("não exibe mais 'em outros filtros' quando não há aparelhos (kpiTotal === 0 branch)", () => {
    // A mensagem "em outros filtros" só aparece quando kpiTotal > 0
    // Após a fix, a branch kpiTotal===0 não deve ter essa mensagem
    const lines = src.split("\n");
    const zeroLineIdx = lines.findIndex((l) => l.includes("kpiTotal === 0"));
    // Dentro das próximas 5 linhas não deve ter "em outros filtros"
    const block = lines.slice(zeroLineIdx, zeroLineIdx + 8).join("\n");
    expect(block).not.toContain("em outros filtros");
  });
});
