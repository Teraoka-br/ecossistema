/**
 * Auditoria reproduzível com os arquivos Excel REAIS.
 *
 * Usa os MESMOS componentes da importação (`analyzeFiles`/`preview`/`confirm`
 * de `src/import/import-service.ts`) contra um banco SQLite TEMPORÁRIO — nunca
 * toca `data/app.sqlite`. Gera:
 *   - docs/REAL_DATA_AUDIT.md  (relatório legível)
 *   - audit/concluded-sample.csv
 *   - audit/status-conflicts.csv
 *
 * Uso:
 *   npm run audit:real -- --orders "<caminho/PEDIDOS.xlsx>" --analysis "<caminho/ANALISE MI.xlsx>"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { analyzeFiles, confirm, preview, type FileInput } from "../src/import/import-service.js";
import { mapOrders, type OrderPartRecord } from "../src/import/mappers.js";
import { readSheets, sha256File } from "../src/import/xlsx-reader.js";
import type { ImportIssue, ImportPreview } from "../src/shared/types.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv: string[]): { orders: string; analysis: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--orders") out.orders = argv[++i];
    else if (a === "--analysis") out.analysis = argv[++i];
  }
  if (!out.orders || !out.analysis) {
    throw new Error(
      'Uso: npm run audit:real -- --orders "<caminho/PEDIDOS.xlsx>" --analysis "<caminho/ANALISE MI.xlsx>"',
    );
  }
  return { orders: path.resolve(out.orders), analysis: path.resolve(out.analysis) };
}

function fmtBytes(n: number): string {
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(2)} MB (${n.toLocaleString("pt-BR")} bytes)`;
}

interface FileFacts {
  path: string;
  sizeBytes: number;
  mtimeIso: string;
  sha256: string;
}

function fileFacts(filePath: string): FileFacts {
  const st = fs.statSync(filePath);
  return {
    path: filePath,
    sizeBytes: st.size,
    mtimeIso: st.mtime.toISOString(),
    sha256: sha256File(filePath),
  };
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, header: string[], rows: unknown[][]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

/** Conta status (token canônico) numa lista de OrderPartRecord. */
function statusCounts(records: OrderPartRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    const k = r.statusToken ?? "(vazio)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function issuesByCode(issues: ImportIssue[], severity: ImportIssue["severity"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of issues) {
    if (i.severity !== severity) continue;
    out[i.code] = (out[i.code] ?? 0) + 1;
  }
  return out;
}

function fmtCountsTable(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "_nenhum_\n";
  return ["| Código | Quantidade |", "| --- | ---: |", ...entries.map(([k, v]) => `| \`${k}\` | ${v} |`)].join("\n") + "\n";
}

export interface AuditOptions {
  /** Diretório onde gravar REAL_DATA_AUDIT.md (padrão: docs/ na raiz do projeto). */
  docsDir?: string;
  /** Diretório onde gravar os CSVs (padrão: audit/ na raiz do projeto). */
  auditDir?: string;
}

export interface AuditResult {
  reportPath: string;
  concludedCsvPath: string;
  conflictsCsvPath: string;
  durationMs: number;
  idempotent: boolean;
  canConfirm: boolean;
}

/**
 * Roda a auditoria completa com os arquivos informados, usando os mesmos
 * componentes da importação real, contra um banco SQLite temporário (nunca
 * `data/app.sqlite`). Gera o relatório e os CSVs nos diretórios informados
 * (ou nos padrões do projeto). Exportada separadamente do CLI para permitir
 * testes automatizados com arquivos pequenos de fixture.
 */
export async function runAudit(
  ordersPath: string,
  analysisPath: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const docsDir = options.docsDir ?? path.join(PROJECT_ROOT, "docs");
  const auditDir = options.auditDir ?? path.join(PROJECT_ROOT, "audit");

  const ordersFacts = fileFacts(ordersPath);
  const analysisFacts = fileFacts(analysisPath);

  const orders: FileInput = { filePath: ordersPath, fileName: path.basename(ordersPath) };
  const analysis: FileInput = { filePath: analysisPath, fileName: path.basename(analysisPath) };

  // Banco temporário — nunca toca data/app.sqlite.
  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-audit-"));
  const tmpDbPath = path.join(tmpDbDir, "audit.sqlite");
  const db = openDatabase(tmpDbPath);
  runMigrations(db);

  try {
    // ---- 1ª importação ----
    const pv1: ImportPreview = preview(db, orders, analysis);
    const res1 = confirm(db, pv1.previewBatchId);

    // ---- 2ª importação (mesmos arquivos) — prova de idempotência ----
    const pv2: ImportPreview = preview(db, orders, analysis);
    const res2 = confirm(db, pv2.previewBatchId);
    const idempotent =
      pv2.alreadyImported === true &&
      res2.alreadyImported === true &&
      res2.batchId === res1.batchId &&
      res2.ordersImported === res1.ordersImported &&
      res2.inventoryImported === res1.inventoryImported;

    // ---- status por origem (mesmos componentes, sem persistir de novo) ----
    const outcome = analyzeFiles(orders, analysis);
    const primaryStatus = statusCounts(outcome.orders.records);

    let secondaryStatus: Record<string, number> = {};
    let secondarySheetName: string | null = null;
    const secondary = outcome.assignment.ordersSecondary;
    if (secondary) {
      secondarySheetName = secondary.detection.sheetName;
      const filePathForSecondary =
        secondary.detection.fileName === orders.fileName ? ordersPath : analysisPath;
      const sheets = readSheets(filePathForSecondary, [secondary.detection.sheetName]);
      const matrix = sheets.get(secondary.detection.sheetName);
      if (matrix) {
        const secondaryOut = mapOrders(matrix, secondary.detection, secondary.match.columns);
        secondaryStatus = statusCounts(secondaryOut.records);
      }
    }

    const concluidosPedidos = primaryStatus["CONCLUIDO"] ?? 0;
    const concluidosAnalise = secondaryStatus["CONCLUIDO"] ?? 0;
    const concluidosPersistidosRow = db
      .prepare(
        "SELECT COUNT(*) AS c FROM source_order_parts WHERE import_batch_id = ? AND status_atual_legado = 'CONCLUIDO'",
      )
      .get(res1.batchId) as { c: number };
    const concluidosPersistidos = concluidosPersistidosRow.c;

    const warningsByCode = issuesByCode(pv1.issues, "WARNING");
    const conflictsByCode = issuesByCode(pv1.issues, "CONFLICT");
    const errorsByCode = issuesByCode(pv1.issues, "ERROR");

    // ---- CSVs ----
    const concludedRows = db
      .prepare(
        `SELECT id_pedido, imei, os, chave_peca, custo, venda, margem_legada, status_atual_label
         FROM source_order_parts
         WHERE import_batch_id = ? AND status_atual_legado = 'CONCLUIDO'
         ORDER BY id_pedido LIMIT 200`,
      )
      .all(res1.batchId) as Record<string, unknown>[];
    writeCsv(
      path.join(auditDir, "concluded-sample.csv"),
      ["id_pedido", "imei", "os", "chave_peca", "custo", "venda", "margem", "status_label"],
      concludedRows.map((r) => [
        r.id_pedido, r.imei, r.os, r.chave_peca, r.custo, r.venda, r.margem_legada, r.status_atual_label,
      ]),
    );

    const conflictIssues = pv1.issues.filter((i) => i.code === "STATUS_CONFLICT");
    writeCsv(
      path.join(auditDir, "status-conflicts.csv"),
      ["entity_key", "file_name", "sheet_name", "row_number", "message", "raw_value"],
      conflictIssues.map((i) => [i.entityKey, i.fileName, i.sheetName, i.rowNumber, i.message, i.rawValue]),
    );

    // ---- Relatório ----
    const detectedTablesMd = pv1.sheets
      .map((s) => {
        const rows = s.detected
          .map((d) => `| ${d.role} | ${d.sheetName} | ${d.headerRow} | ${d.matchedHeaders.join(", ")} |`)
          .join("\n");
        return `**${s.fileName}** (abas: ${s.sheetNames.join(", ")})\n\n| Papel | Aba | Linha cabeçalho | Campos casados |\n| --- | --- | ---: | --- |\n${rows || "| _nenhuma_ | | | |"}\n`;
      })
      .join("\n");

    const md = `# Auditoria com dados reais

> Gerado por \`npm run audit:real\` em ${new Date().toISOString()}. Os números abaixo são uma
> fotografia dos arquivos informados nesta execução — **não são constantes de código** e não
> devem ser copiados para o código-fonte. Reexecute para uma operação viva.

## Arquivos auditados

| | PEDIDOS | ANALISE MI |
| --- | --- | --- |
| Caminho | \`${ordersFacts.path}\` | \`${analysisFacts.path}\` |
| Tamanho | ${fmtBytes(ordersFacts.sizeBytes)} | ${fmtBytes(analysisFacts.sizeBytes)} |
| Modificado em | ${ordersFacts.mtimeIso} | ${analysisFacts.mtimeIso} |
| SHA-256 | \`${ordersFacts.sha256}\` | \`${analysisFacts.sha256}\` |

## Tabelas escolhidas (detecção por cabeçalho)

${detectedTablesMd}

## Duração da leitura (prévia)

\`${pv1.durationMs} ms\` (detecção em etapas + mapeamento completo dos dois arquivos).

## Totais

| Métrica | Encontrado | Válido | Persistido |
| --- | ---: | ---: | ---: |
| Pedidos | ${pv1.counts.ordersFound} | ${pv1.counts.ordersValid} | ${res1.ordersImported} |
| Estoque (unidades) | ${pv1.counts.inventoryFound} | ${pv1.counts.inventoryValid} | ${res1.inventoryImported} |
| Cotações | ${pv1.counts.quotationsFound} | ${pv1.counts.quotationsValid} | ${res1.quotationsImported} |
| Análise (linhas) | ${pv1.counts.analysisFound} | ${pv1.counts.analysisValid} | ${res1.analysisImported} |

Status final do lote: \`${res1.status}\` (lote #${res1.batchId}).

## Status por origem (pedidos)

**PEDIDOS.xlsx** (fonte primária — aba \`${outcome.assignment.orders?.detection.sheetName ?? "—"}\`):

${fmtCountsTable(primaryStatus)}

**ANALISE MI.xlsx** (fonte secundária${secondarySheetName ? ` — aba \`${secondarySheetName}\`` : " — não encontrada"}):

${fmtCountsTable(secondaryStatus)}

## Concluídos

| Onde | Quantidade |
| --- | ---: |
| CONCLUIDO no PEDIDOS (fonte primária) | ${concluidosPedidos} |
| CONCLUIDO no ANALISE MI (fonte secundária) | ${concluidosAnalise} |
| CONCLUIDO persistido (snapshot gravado) | ${concluidosPersistidos} |

Amostra completa em \`audit/concluded-sample.csv\` (até 200 linhas).

## Warnings por código

${fmtCountsTable(warningsByCode)}

## Erros (não fatais, por linha) por código

${fmtCountsTable(errorsByCode)}

## Conflitos por código

${fmtCountsTable(conflictsByCode)}

Lista completa de conflitos de status em \`audit/status-conflicts.csv\`.

## Idempotência (segunda importação)

| Verificação | Resultado |
| --- | --- |
| \`alreadyImported\` na 2ª prévia | ${pv2.alreadyImported} |
| \`alreadyImported\` na 2ª confirmação | ${res2.alreadyImported} |
| Mesmo \`batchId\` reaproveitado | ${res2.batchId === res1.batchId} |
| Mesmos totais importados | ${res2.ordersImported === res1.ordersImported && res2.inventoryImported === res1.inventoryImported} |
| **Idempotente** | **${idempotent}** |

## Erros fatais

${pv1.canConfirm ? "Nenhum — a importação foi confirmada normalmente." : `${pv1.fatalIssuesCount} ocorrência(s) fatal(is) — confirmação bloqueada.`}
`;

    const docsPath = path.join(docsDir, "REAL_DATA_AUDIT.md");
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, md, "utf8");

    const concludedCsvPath = path.join(auditDir, "concluded-sample.csv");
    const conflictsCsvPath = path.join(auditDir, "status-conflicts.csv");

    return {
      reportPath: docsPath,
      concludedCsvPath,
      conflictsCsvPath,
      durationMs: pv1.durationMs,
      idempotent,
      canConfirm: pv1.canConfirm,
    };
  } finally {
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { orders: ordersPath, analysis: analysisPath } = parseArgs(process.argv.slice(2));
  console.log(`[audit] PEDIDOS:    ${ordersPath}`);
  console.log(`[audit] ANALISE MI: ${analysisPath}`);

  const result = await runAudit(ordersPath, analysisPath);

  console.log(`[audit] relatório: ${result.reportPath}`);
  console.log(`[audit] csv: ${result.concludedCsvPath}`);
  console.log(`[audit] csv: ${result.conflictsCsvPath}`);
  console.log(`[audit] duração da prévia: ${result.durationMs} ms`);
  console.log(`[audit] idempotente: ${result.idempotent}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error(`[audit] falhou: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
