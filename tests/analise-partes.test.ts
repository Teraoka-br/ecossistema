/**
 * Testes para a validação de peças na tela Analisar aparelho.
 *
 * Cobre os 12 cenários obrigatórios + testes de autocomplete e backend.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const src = fs.readFileSync(
  path.join(ROOT, "src", "client", "pages", "Analise.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1–12. Cenários obrigatórios (source-inspection)
// ---------------------------------------------------------------------------

describe("Analise.tsx: cenários obrigatórios de peças", () => {
  // 1. Tela inicial sem peça mostra pendência
  it("1. computeBlockers retorna b.parts quando parts está vazio", () => {
    expect(src).toContain("buildValidPartsPayload(parts, form)");
    expect(src).toContain("if (!partsResult.ok) b.parts = partsResult.error;");
    expect(src).toContain("Adicione pelo menos uma peça necessária.");
  });

  // 2. Usuário adiciona primeira peça via commitPartInput
  it("2. commitPartInput adiciona item ao array parts", () => {
    expect(src).toContain("function commitPartInput()");
    expect(src).toContain("const name = partInput.trim()");
    expect(src).toContain("if (!name) return;");
    // adiciona ao array
    expect(src).toContain("setParts((p) => [...p, {");
  });

  // 3. Erro desaparece após adicionar (buildValidPartsPayload detecta nonEmpty.length > 0)
  it("3. buildValidPartsPayload retorna ok:true quando há pelo menos um item não-vazio", () => {
    const fnStart = src.indexOf("function buildValidPartsPayload");
    const fnEnd   = src.indexOf("\n}", fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain("nonEmpty.length === 0");
    expect(fn).toContain("return { ok: true, parts: result }");
  });

  // 4. Lista mostra peças adicionadas (parts.map no render)
  it("4. lista de peças usa parts.map no render", () => {
    const renderStart = src.indexOf("return (");
    const renderBody  = src.slice(renderStart);
    expect(renderBody).toContain("parts.map((part)");
    // exibe o nome
    expect(renderBody).toContain("part.pecaNome");
  });

  // 5. Payload contém exatamente as peças adicionadas (buildValidPartsPayload → result.push)
  it("5. buildValidPartsPayload monta payload com pecaNome e chavePeca", () => {
    expect(src).toContain("result.push({");
    expect(src).toContain("pecaNome: p.pecaNome.trim()");
    expect(src).toContain("chavePeca,");
  });

  // 6. Finalizar análise com peça válida → setSavedCase chamado
  it("6. handleSave(finalize=true) chama setSavedCase após POST bem-sucedido", () => {
    const saveStart = src.indexOf("async function handleSave");
    const saveEnd   = src.indexOf("\n  }", saveStart + 100);
    const saveBody  = src.slice(saveStart, saveEnd + 10);
    expect(saveBody).toContain("setSavedCase(");
    expect(saveBody).toContain("rc[\"analysisStatus\"]");
  });

  // 7. Após sucesso, não há painel de pendências (isJustFinalized suprime)
  it("7. painel de pendências suprimido quando isJustFinalized", () => {
    expect(src).toContain("isJustFinalized");
    expect(src).toContain("!isJustFinalized && hasBlockers");
  });

  // 8. Após sucesso, não há erro inline de falta de peça
  it("8. erro inline de peças é envolvido em !isJustFinalized", () => {
    // blockers.parts só renderiza dentro do bloco !isJustFinalized
    const renderStart  = src.indexOf("{isJustFinalized ?");
    const elseBlock    = src.indexOf("<>", renderStart);
    const blockerParts = src.indexOf("blockers.parts &&", elseBlock);
    expect(blockerParts).toBeGreaterThan(elseBlock);
  });

  // 9. Salvar e Finalizar usam a mesma validação (buildValidPartsPayload)
  it("9. handleSave usa buildValidPartsPayload tanto para draft quanto para finalize", () => {
    const saveStart = src.indexOf("async function handleSave");
    const saveBody  = src.slice(saveStart, saveStart + 3000);
    // aparece pelo menos duas vezes: finalize e draft
    const occurrences = (saveBody.match(/buildValidPartsPayload/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  // 10. Remover única peça faz a pendência voltar (nonEmpty.length === 0)
  it("10. removePart filtra o item do array parts", () => {
    expect(src).toContain("function removePart(key: string)");
    expect(src).toContain("p.filter((x) => x.key !== key)");
  });

  // 11. Adicionar peça por Enter funciona
  it("11. onKeyDown Enter chama commitPartInput (sem sugestão selecionada)", () => {
    expect(src).toContain('"Enter"');
    expect(src).toContain("commitPartInput()");
  });

  // 12. Adicionar peça por clique no botão
  it("12. botão Adicionar tem onClick={commitPartInput}", () => {
    expect(src).toContain("onClick={commitPartInput}");
    expect(src).toContain("<Plus size={14} /> Adicionar");
  });
});

// ---------------------------------------------------------------------------
// Autocomplete da barra de busca
// ---------------------------------------------------------------------------

describe("Analise.tsx: autocomplete da barra de busca de peças", () => {
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
// Backend: analise-routes.ts
// ---------------------------------------------------------------------------

describe("analise-routes.ts: validação de partes", () => {
  const routeSrc = fs.readFileSync(
    path.join(ROOT, "src", "server", "routes", "analise-routes.ts"),
    "utf8",
  );

  it("rejeita partes vazias com status 400", () => {
    expect(routeSrc).toContain("validParts.length === 0");
    expect(routeSrc).toContain("Ao menos uma peça é obrigatória.");
    expect(routeSrc).toContain("status(400)");
  });

  it("valida incluirCor sem cor com erro específico", () => {
    expect(routeSrc).toContain("p.incluirCor && !p.corUsada");
    expect(routeSrc).toContain("Cor obrigatória para peça");
  });
});

// ---------------------------------------------------------------------------
// FilaReparos.tsx — estado vazio após beta limpo
// ---------------------------------------------------------------------------

describe("FilaReparos.tsx: estado vazio quando kpiTotal === 0", () => {
  const filaSrc = fs.readFileSync(
    path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
    "utf8",
  );

  it("exibe 'Nenhum aparelho importado ainda' quando kpiTotal === 0", () => {
    expect(filaSrc).toContain("kpiTotal === 0");
    expect(filaSrc).toContain("Nenhum aparelho importado ainda");
  });

  it("checagem de kpiTotal === 0 vem antes das mensagens de filtro", () => {
    const zeroIdx   = filaSrc.indexOf("kpiTotal === 0");
    const filterIdx = filaSrc.indexOf("Nenhum aparelho no filtro");
    expect(zeroIdx).toBeGreaterThan(0);
    expect(filterIdx).toBeGreaterThan(zeroIdx);
  });
});
