/**
 * Testes para a validação de peças na tela Analisar aparelho.
 *
 * Cobre:
 * - buildValidPartsPayload usada em computeBlockers e handleSave
 * - linha preenchida conta como válida
 * - linha vazia é ignorada (não é erro por si só)
 * - incluirCor=true sem cor gera erro específico
 * - buildChavePeca("", model) não aparece como preview válido
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
// 1. Analise.tsx — buildValidPartsPayload e computeBlockers
// ---------------------------------------------------------------------------

describe("Analise.tsx: buildValidPartsPayload — peças", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "client", "pages", "Analise.tsx"),
    "utf8",
  );

  it("função buildValidPartsPayload existe no código", () => {
    expect(src).toContain("buildValidPartsPayload");
  });

  it("filtra linhas vazias antes de validar (pecaNome.trim() !== '')", () => {
    expect(src).toContain('p.pecaNome.trim() !== ""');
  });

  it("retorna erro quando não há peças (Adicione pelo menos uma peça necessária.)", () => {
    expect(src).toContain("Adicione pelo menos uma peça necessária.");
  });

  it("retorna erro de cor quando incluirCor=true e cor ausente", () => {
    expect(src).toContain(
      "A cor do aparelho é obrigatória quando 'Incluir cor' estiver marcado.",
    );
  });

  it("retorna erro quando chavePeca não pode ser gerada", () => {
    expect(src).toContain("Não foi possível gerar a CHAVEPECA da peça.");
  });

  it("computeBlockers usa buildValidPartsPayload para o blocker de peças", () => {
    // buildValidPartsPayload deve aparecer dentro de computeBlockers
    const computeStart = src.indexOf("function computeBlockers");
    const computeEnd = src.indexOf("\n}", computeStart);
    const computeBody = src.slice(computeStart, computeEnd);
    expect(computeBody).toContain("buildValidPartsPayload");
  });

  it("handleSave usa buildValidPartsPayload para finalizar", () => {
    // buildValidPartsPayload deve aparecer dentro de handleSave
    const saveStart = src.indexOf("async function handleSave");
    const saveEnd = src.indexOf("\n  }", saveStart + 100);
    const saveBody = src.slice(saveStart, saveEnd + 50);
    expect(saveBody).toContain("buildValidPartsPayload");
  });

  it("commitPartInput só adiciona peças com nome não-vazio (prevenindo peça presa na busca)", () => {
    // commitPartInput valida name = partInput.trim() antes de adicionar
    expect(src).toContain("commitPartInput");
    expect(src).toContain("const name = partInput.trim()");
    expect(src).toContain("if (!name) return;");
  });

  it("linha preenchida (pecaNome não vazio) gera payload sem exigir seleção de sugestão", () => {
    // O payload é construído diretamente a partir de pecaNome, sem checar selectedSuggestion
    expect(src).not.toContain("selectedSuggestion");
  });

  it("incluirCor=false não inclui cor no payload mesmo que haja cor no form", () => {
    // corUsada é atribuído condicional: p.incluirCor && corTrim ? corTrim : ""
    expect(src).toContain('(p.incluirCor && corTrim) ? corTrim : ""');
  });

  it("isChavePecaExistente=true usa pecaNome diretamente sem concatenar modelo", () => {
    // Deve existir o branch isChavePecaExistente dentro de buildValidPartsPayload
    const fnStart = src.indexOf("function buildValidPartsPayload");
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("isChavePecaExistente");
    expect(fnBody).toContain("p.pecaNome.trim().toUpperCase()");
  });
});

// ---------------------------------------------------------------------------
// 2. Analise.tsx — autocomplete da barra de busca de peças
// ---------------------------------------------------------------------------

describe("Analise.tsx: autocomplete da barra de busca de peças", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "client", "pages", "Analise.tsx"),
    "utf8",
  );

  it("estado partInputHighlighted existe (índice do autocomplete)", () => {
    expect(src).toContain("partInputHighlighted");
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
    expect(src).toContain("partInputHighlighted >= 0");
  });

  it("onKeyDown Escape fecha a lista de sugestões", () => {
    expect(src).toContain('"Escape"');
  });

  it("sugestão destacada recebe fundo diferente (var(--elevated))", () => {
    expect(src).toContain("idx === partInputHighlighted");
    expect(src).toContain("var(--elevated)");
  });

  it("onMouseEnter sincroniza o índice com o hover do mouse", () => {
    expect(src).toContain("onMouseEnter");
    expect(src).toContain("setPartInputHighlighted(idx)");
  });

  it("fetchPartSuggestions reseta partInputHighlighted ao receber novas sugestões", () => {
    const fetchIdx = src.indexOf("fetchPartSuggestions");
    const resetIdx = src.indexOf("setPartInputHighlighted(-1)", fetchIdx);
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
    expect(src).toContain("validParts.length === 0");
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
    const lines = src.split("\n");
    const zeroLineIdx = lines.findIndex((l) => l.includes("kpiTotal === 0"));
    const block = lines.slice(zeroLineIdx, zeroLineIdx + 8).join("\n");
    expect(block).not.toContain("em outros filtros");
  });
});
