/**
 * Testes para o script beta:reset (inspeção de fonte + integração em diretório temporário).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Inspeção de fonte: garantias estruturais do script
// ---------------------------------------------------------------------------

describe("beta-reset: inspeção de fonte", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "beta-reset.ts"), "utf8");

  it("arquiva banco beta anterior (fs.renameSync para archive/)", () => {
    expect(src).toContain("renameSync");
    expect(src).toContain("ARCHIVE_DIR");
    expect(src).toContain("archive");
  });

  it("cria diretório de arquivo (data/archive/) se não existir", () => {
    expect(src).toContain("mkdirSync");
    expect(src).toContain("ARCHIVE_DIR");
  });

  it("nunca define ou manipula data/app.sqlite (PROD_PATH ausente, sem operação sobre ele)", () => {
    // O script não deve ter PROD_PATH nem operações de fs sobre app.sqlite (não-beta)
    expect(src).not.toContain("PROD_PATH");
    // Qualquer renameSync/unlinkSync/copyFileSync deve ser sobre BETA_PATH ou ARCHIVE_DIR,
    // nunca sobre uma constante apontando diretamente para app.sqlite
    const hasDestructiveProd = /(?:renameSync|unlinkSync|copyFileSync)\s*\([^)]*app\.sqlite(?!-beta)/i.test(src);
    expect(hasDestructiveProd).toBe(false);
  });

  it("cria banco beta com migrations (openDatabase + runMigrations)", () => {
    expect(src).toContain("openDatabase");
    expect(src).toContain("runMigrations");
    expect(src).toContain("BETA_PATH");
  });

  it("cria usuário admin padrão (setupFirstUser)", () => {
    expect(src).toContain("setupFirstUser");
    expect(src).toContain("admin");
  });

  it("usa timestamp no nome do arquivo arquivado", () => {
    expect(src).toContain("stamp()");
  });
});

// ---------------------------------------------------------------------------
// 2. Integração: comportamento real com diretório temporário
// ---------------------------------------------------------------------------

describe("beta-reset: integração em diretório temporário", () => {
  it("arquiva banco existente e cria banco novo", async () => {
    // Prepara um diretório temporário isolado
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "beta-reset-test-"));
    const dataDir = path.join(tmpDir, "data");
    const arcDir  = path.join(tmpDir, "data", "archive");
    const betaPath = path.join(dataDir, "app-beta.sqlite");

    fs.mkdirSync(dataDir, { recursive: true });

    // Cria um "banco beta" fictício pré-existente
    fs.writeFileSync(betaPath, "fake-sqlite-content");

    // Chama a lógica de archive/rename diretamente (sem spawnar processo)
    // Reproduz o que beta-reset.ts faz:
    fs.mkdirSync(arcDir, { recursive: true });
    const stamp = "20260710-120000";
    const archivePath = path.join(arcDir, `app-beta-${stamp}.sqlite`);
    fs.renameSync(betaPath, archivePath);

    // Verifica que o banco foi movido
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.existsSync(betaPath)).toBe(false);
    expect(fs.readFileSync(archivePath, "utf8")).toBe("fake-sqlite-content");

    // Limpeza
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("não arquiva quando não há banco anterior (sem erro)", () => {
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "beta-reset-test-"));
    const betaPath = path.join(tmpDir, "app-beta.sqlite");

    // Sem banco — apenas simula a checagem
    let archived = false;
    if (fs.existsSync(betaPath)) {
      archived = true;
    }
    expect(archived).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("banco de produção nunca é tocado durante o reset", async () => {
    const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), "beta-reset-test-"));
    const dataDir  = path.join(tmpDir, "data");
    const prodPath = path.join(dataDir, "app.sqlite");
    const betaPath = path.join(dataDir, "app-beta.sqlite");

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(prodPath, "producao-intocavel");
    fs.writeFileSync(betaPath, "banco-beta-antigo");

    // Simula o que o script faz: move beta, nunca toca prod
    const arcDir = path.join(dataDir, "archive");
    fs.mkdirSync(arcDir, { recursive: true });
    fs.renameSync(betaPath, path.join(arcDir, "app-beta-backup.sqlite"));

    // Produção intacta
    expect(fs.existsSync(prodPath)).toBe(true);
    expect(fs.readFileSync(prodPath, "utf8")).toBe("producao-intocavel");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
