import path from "node:path";

/** Raiz do projeto (diretório de onde o processo é iniciado). */
export const PROJECT_ROOT = process.cwd();

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
}

export const config = {
  serverPort: Number(process.env.SERVER_PORT ?? 3001),
  // Escuta em todas as interfaces por padrão para permitir acesso pela rede local.
  // Sem autenticação — use somente em redes locais confiáveis.
  // Para restringir ao localhost: defina SERVER_HOST=127.0.0.1.
  serverHost: process.env.SERVER_HOST ?? "0.0.0.0",
  databasePath:
    process.env.DATABASE_PATH === ":memory:"
      ? ":memory:"
      : resolveFromRoot(process.env.DATABASE_PATH ?? "data/app.sqlite"),
  uploadTmpDir: resolveFromRoot(process.env.UPLOAD_TMP_DIR ?? "data/tmp"),
  backupDir: resolveFromRoot("data/backups"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024,
  // Proteção contra contagem incompleta: percentual mínimo do total bipado
  // (ativo) em relação ao total de unidades do estoque legado do lote
  // vinculado à sessão. Abaixo disso, a finalização normal é bloqueada.
  countMinCompletenessRatio: Number(process.env.COUNT_MIN_COMPLETENESS_RATIO ?? 0.8),
  // A importação Excel é uma inicialização única. Depois de inicializado, o
  // sistema bloqueia novas importações. Reabrir só em dev/teste.
  allowLegacyReimport: process.env.ALLOW_LEGACY_REIMPORT === "true",
  /** Em produção o servidor também serve os arquivos estáticos do client. */
  clientDist: resolveFromRoot("dist/client"),
  isProduction: process.env.NODE_ENV === "production",
};
