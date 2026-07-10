/**
 * Testes de ambiente beta:
 * - beta-start usa --port 5173 --strictPort no Vite
 * - /api/runtime-info retorna dados corretos
 * - FilaReparos: summary e listagem são requests independentes
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. beta-start.ts: verificar que o script passa --port e --strictPort ao Vite
// ---------------------------------------------------------------------------

describe("beta-start: portas fixas", () => {
  it("beta-start.ts passa --port 5173 ao Vite", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "beta-start.ts"), "utf8");
    expect(src).toContain("--port");
    expect(src).toContain("5173");
  });

  it("beta-start.ts passa --strictPort ao Vite", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "beta-start.ts"), "utf8");
    expect(src).toContain("--strictPort");
  });

  it("beta-start.ts verifica se a porta está ocupada antes de spawnar", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "beta-start.ts"), "utf8");
    expect(src).toContain("isPortBusy");
    // Deve checar 5173 e 3001
    expect(src).toContain("FRONTEND_PORT");
    expect(src).toContain("BACKEND_PORT");
  });

  it("beta-start.ts aborta se porta ocupada (process.exit)", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "beta-start.ts"), "utf8");
    expect(src).toContain("process.exit(1)");
    // Mensagem de erro referencia beta:stop
    expect(src).toContain("beta:stop");
  });
});

// ---------------------------------------------------------------------------
// 2. /api/runtime-info: endpoint existe em app.ts e retorna campos esperados
// ---------------------------------------------------------------------------

describe("runtime-info endpoint", () => {
  it("app.ts define GET /api/runtime-info", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "server", "app.ts"), "utf8");
    expect(src).toContain("/api/runtime-info");
    expect(src).toContain("databaseFile");
    expect(src).toContain("apiPort");
    expect(src).toContain("mode");
  });

  it("runtime-info handler usa BETA_MODE para definir mode=BETA", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "server", "app.ts"), "utf8");
    // Verifica que o handler lê BETA_MODE e retorna "BETA"
    expect(src).toContain("BETA_MODE");
    expect(src).toContain('"BETA"');
    // E que retorna o nome do arquivo do banco
    expect(src).toContain("path.basename");
  });
});

// ---------------------------------------------------------------------------
// 3. FilaReparos: summary e listagem são requests independentes (via source)
// ---------------------------------------------------------------------------

describe("FilaReparos: summary separado da listagem", () => {
  it("loadSummary faz fetch para /api/fila-reparos/summary (rota dedicada)", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
      "utf8",
    );
    expect(src).toContain("/api/fila-reparos/summary");
    expect(src).toContain("/api/fila-reparos?");
  });

  it("botão Atualizar chama loadSummary, loadItems e loadEngine", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
      "utf8",
    );
    // O onClick do botão de refresh deve conter os três
    expect(src).toContain("loadSummary");
    expect(src).toContain("loadItems");
    expect(src).toContain("loadEngine");
    // Verifica que o botão chama os três juntos
    const refreshButtonMatch = src.match(/onClick=\{[^}]*loadSummary[^}]*loadItems[^}]*loadEngine[^}]*\}/);
    expect(refreshButtonMatch).not.toBeNull();
  });

  it("botão Atualizar preserva filtro atual (não limpa filter)", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
      "utf8",
    );
    // loadItems usa o estado 'filter' via closure — verifica que não há setFilter dentro do onClick do refresh
    const lines = src.split("\n");
    const refreshIdx = lines.findIndex((l) => l.includes("Atualizar fila"));
    if (refreshIdx === -1) throw new Error("Botão Atualizar fila não encontrado");
    // As 3 linhas ao redor do botão não devem chamar setFilter
    const context = lines.slice(Math.max(0, refreshIdx - 5), refreshIdx + 5).join("\n");
    expect(context).not.toContain("setFilter");
  });

  it("não existem dois ícones de RefreshCw com ação de refresh de dados", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
      "utf8",
    );
    // O botão de refresh de dados deve ser único. O EngineStatusBar tem "Recalcular" (texto), não RefreshCw.
    // Conta quantos <RefreshCw aparecem no JSX
    const refreshCwMatches = [...src.matchAll(/<RefreshCw/g)];
    // Deve haver apenas 1 (o botão standalone)
    expect(refreshCwMatches.length).toBe(1);
  });

  it("mensagem correta quando filtro ativo sem resultado mas há aparelhos em outros filtros", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
      "utf8",
    );
    expect(src).toContain("em outros filtros");
    // Não deve mostrar "Todos os aparelhos estão em dia" quando kpiTotal > 0
    expect(src).not.toContain("Todos os aparelhos estão em dia");
  });

  it("listError é exibido quando o fetch falha", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src", "client", "pages", "FilaReparos.tsx"),
      "utf8",
    );
    expect(src).toContain("listError");
    expect(src).toContain("Erro ao carregar a fila");
  });
});
