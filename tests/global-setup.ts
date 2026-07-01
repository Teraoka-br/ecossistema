import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mesmo caminho fixo definido em vitest.config.ts (calculado independentemente
// para não depender de propagação de env entre processos do Vitest).
const uploadTmpDir = path.join(os.tmpdir(), "sistema-pecas-test-uploads");

/**
 * Vitest globalSetup: roda uma vez para toda a suíte. Garante que o diretório
 * temporário de upload usado pelos testes seja removido ao final, mesmo
 * quando algum teste lança antes de limpar o próprio lote.
 */
export default function setup(): () => void {
  return () => {
    fs.rmSync(uploadTmpDir, { recursive: true, force: true });
  };
}
