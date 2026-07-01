import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Diretório temporário real (fora do repositório). Nome fixo para que o
// globalSetup (processo separado) saiba qual caminho remover ao final, sem
// depender de propagação de variável de ambiente entre processos.
const uploadTmpDir = path.join(os.tmpdir(), "sistema-pecas-test-uploads");
fs.rmSync(uploadTmpDir, { recursive: true, force: true });
fs.mkdirSync(uploadTmpDir, { recursive: true });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    // Isola os arquivos temporários de teste do diretório operacional.
    env: {
      UPLOAD_TMP_DIR: uploadTmpDir,
      DATABASE_PATH: ":memory:",
    },
    // Evita colisão de diretórios de lote (batch-N) entre arquivos de teste.
    fileParallelism: false,
  },
});
