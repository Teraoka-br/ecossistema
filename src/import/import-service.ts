import fs from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import type { Db } from "../db/database.js";
import type {
  DetectedTable,
  ImportIssue,
  ImportPreview,
  ImportResult,
} from "../shared/types.js";
import * as repo from "../db/repository.js";
import { allowLegacyReimport, initializeSystem, isInitialized } from "../system/system-service.js";
import { listSheetNames, readSheets, readTopRowsForSheets, sha256File, type SheetMatrix } from "./xlsx-reader.js";
import {
  assignRolesFromDetections,
  detectSheet,
  isCandidateSheetName,
  isHistoricalSheetName,
  type Assignment,
  type RoleAssignment,
  type SheetDetection,
} from "./table-detection.js";
import {
  detectStatusConflicts,
  mapAnalysis,
  mapInventory,
  mapOrders,
  mapQuotations,
  type AnalysisRecord,
  type InventoryRecord,
  type MapOutput,
  type OrderPartRecord,
  type QuotationRecord,
} from "./mappers.js";

export interface FileInput {
  /** Caminho físico (temporário) do arquivo .xlsx. */
  filePath: string;
  /** Nome original exibido ao usuário. */
  fileName: string;
}

export interface AnalysisOutcome {
  assignment: Assignment;
  orders: MapOutput<OrderPartRecord>;
  inventory: MapOutput<InventoryRecord>;
  quotations: MapOutput<QuotationRecord>;
  analysis: MapOutput<AnalysisRecord>;
  issues: ImportIssue[];
}

const EMPTY = <T>(): MapOutput<T> => ({ records: [], issues: [], rowsFound: 0 });

type MatrixCache = Map<string, Map<string, SheetMatrix>>;

/**
 * Lê, de uma vez por arquivo, todas as abas necessárias às atribuições.
 * Evita reabrir um .xlsx de dezenas de MB uma vez por papel.
 */
function loadNeededSheets(pathByFile: Map<string, string>, roles: (RoleAssignment | undefined)[]): MatrixCache {
  const wanted = new Map<string, Set<string>>();
  for (const r of roles) {
    if (!r) continue;
    const set = wanted.get(r.detection.fileName) ?? new Set<string>();
    set.add(r.detection.sheetName);
    wanted.set(r.detection.fileName, set);
  }
  const cache: MatrixCache = new Map();
  for (const [fileName, sheetSet] of wanted) {
    const filePath = pathByFile.get(fileName);
    if (!filePath) continue;
    cache.set(fileName, readSheets(filePath, [...sheetSet]));
  }
  return cache;
}

function fullSheet(
  cache: MatrixCache,
  role: RoleAssignment | undefined,
): { matrix: SheetMatrix; assignment: RoleAssignment } | null {
  if (!role) return null;
  const matrix = cache.get(role.detection.fileName)?.get(role.detection.sheetName);
  if (!matrix) return null;
  return { matrix, assignment: role };
}

/**
 * Detecção de papéis em etapas, para não decompactar/parsear abas históricas
 * gigantes (ex.: "His Estoque", centenas de MB de XML) ao procurar cabeçalhos.
 *
 *   1. lista os nomes das abas (leitura leve, `bookSheets`);
 *   2. lê as primeiras linhas só das abas cujo NOME é candidato a algum papel
 *      conhecido (heurística — nunca a autoridade final);
 *   3. atribui os papéis pelo CONTEÚDO do cabeçalho dessas abas;
 *   4. só se algum papel continuar ausente, expande a varredura para as
 *      demais abas não-históricas, uma por vez, parando ao encontrar tudo;
 *   5. abas claramente históricas/volumosas nunca são lidas, em nenhuma etapa.
 */
function detectAssignmentStaged(
  files: { fileName: string; filePath: string; sheetNames: string[] }[],
): Assignment {
  const detections: SheetDetection[] = [];

  const collect = (fileName: string, matrices: SheetMatrix[]): void => {
    for (const m of matrices) {
      const d = detectSheet(fileName, m);
      if (d) detections.push(d);
    }
  };

  // Etapa 1: só abas com nome candidato.
  for (const f of files) {
    const candidateNames = f.sheetNames.filter((n) => isCandidateSheetName(n));
    collect(f.fileName, readTopRowsForSheets(f.filePath, candidateNames));
  }

  let assignment = assignRolesFromDetections(detections);
  const allRolesFound = (a: Assignment): boolean =>
    !!a.orders && !!a.inventory && !!a.quotations && !!a.analysis;

  // Etapa 2: só se algum papel ainda estiver ausente — expande para as
  // demais abas não-históricas, uma por vez, até achar tudo ou esgotar.
  if (!allRolesFound(assignment)) {
    outer: for (const f of files) {
      const triedNames = new Set(f.sheetNames.filter((n) => isCandidateSheetName(n)));
      const remaining = f.sheetNames.filter(
        (n) => !triedNames.has(n) && !isHistoricalSheetName(n),
      );
      for (const sheetName of remaining) {
        if (allRolesFound(assignment)) break outer;
        collect(f.fileName, readTopRowsForSheets(f.filePath, [sheetName]));
        assignment = assignRolesFromDetections(detections);
      }
    }
  }

  return assignment;
}

/**
 * Detecta tabelas e mapeia ambos os arquivos, sem gravar nada.
 * Usado tanto pela pré-visualização quanto pela confirmação.
 */
export function analyzeFiles(orders: FileInput, analysis: FileInput): AnalysisOutcome {
  const pathByFile = new Map<string, string>([
    [orders.fileName, orders.filePath],
    [analysis.fileName, analysis.filePath],
  ]);

  const assignment = detectAssignmentStaged([
    { fileName: orders.fileName, filePath: orders.filePath, sheetNames: listSheetNames(orders.filePath) },
    { fileName: analysis.fileName, filePath: analysis.filePath, sheetNames: listSheetNames(analysis.filePath) },
  ]);

  const cache = loadNeededSheets(pathByFile, [
    assignment.orders,
    assignment.inventory,
    assignment.quotations,
    assignment.analysis,
    assignment.ordersSecondary,
  ]);

  const ordersFull = fullSheet(cache, assignment.orders);
  const inventoryFull = fullSheet(cache, assignment.inventory);
  const quotationsFull = fullSheet(cache, assignment.quotations);
  const analysisFull = fullSheet(cache, assignment.analysis);
  const secondaryFull = fullSheet(cache, assignment.ordersSecondary);

  const ordersOut = ordersFull
    ? mapOrders(ordersFull.matrix, ordersFull.assignment.detection, ordersFull.assignment.match.columns)
    : EMPTY<OrderPartRecord>();
  const inventoryOut = inventoryFull
    ? mapInventory(inventoryFull.matrix, inventoryFull.assignment.detection, inventoryFull.assignment.match.columns)
    : EMPTY<InventoryRecord>();
  const quotationsOut = quotationsFull
    ? mapQuotations(quotationsFull.matrix, quotationsFull.assignment.detection, quotationsFull.assignment.match.columns)
    : EMPTY<QuotationRecord>();
  const analysisOut = analysisFull
    ? mapAnalysis(analysisFull.matrix, analysisFull.assignment.detection, analysisFull.assignment.match.columns)
    : EMPTY<AnalysisRecord>();

  const issues: ImportIssue[] = [
    ...ordersOut.issues,
    ...inventoryOut.issues,
    ...quotationsOut.issues,
    ...analysisOut.issues,
  ];

  // Conflitos entre a fonte primária e a secundária de pedidos.
  if (secondaryFull && ordersOut.records.length > 0) {
    issues.push(
      ...detectStatusConflicts(
        ordersOut.records,
        secondaryFull.matrix,
        secondaryFull.assignment.detection,
        secondaryFull.assignment.match.columns,
      ),
    );
  }

  // Estrutura essencial (erros estruturais são fatais — bloqueiam a confirmação).
  //
  // A condição fatal é sobre REGISTROS VÁLIDOS (records.length), não sobre
  // linhas não-vazias encontradas (rowsFound). Um cenário onde todas as
  // linhas existem mas são todas rejeitadas (ex.: todas sem ID_PEDIDO) tem
  // rowsFound > 0 e records.length === 0 — isso TEM que ser fatal também.
  if (!assignment.orders) {
    issues.push(structural("MISSING_ORDERS_TABLE", "ERROR", "Tabela de pedidos (ID PEDIDO/IMEI/STATUS/CHAVEPEÇA) não encontrada."));
  } else if (ordersOut.records.length === 0) {
    issues.push(structural("NO_VALID_ORDERS", "ERROR",
      ordersOut.rowsFound === 0
        ? "Nenhum pedido encontrado na tabela de pedidos."
        : `${ordersOut.rowsFound} linha(s) encontrada(s) na tabela de pedidos, mas nenhuma é um registro válido para importação.`,
    ));
  }
  if (!assignment.inventory) {
    issues.push(structural("MISSING_INVENTORY_TABLE", "ERROR", "Tabela de estoque (BIPAGEM: REFERENCIA/CHAVEPECA) não encontrada."));
  } else if (inventoryOut.records.length === 0) {
    issues.push(structural("NO_VALID_INVENTORY", "ERROR",
      inventoryOut.rowsFound === 0
        ? "Nenhuma unidade de estoque encontrada."
        : `${inventoryOut.rowsFound} linha(s) encontrada(s) na tabela de estoque, mas nenhuma é um registro válido para importação.`,
    ));
  }
  if (!assignment.quotations) {
    issues.push(structural("MISSING_QUOTATIONS_TABLE", "WARNING", "Tabela de cotações (PEÇAS A PEDIR) não encontrada."));
  }

  return {
    assignment,
    orders: ordersOut,
    inventory: inventoryOut,
    quotations: quotationsOut,
    analysis: analysisOut,
    issues,
  };
}

function structural(code: string, severity: ImportIssue["severity"], message: string): ImportIssue {
  return {
    fileName: "(detecção)", sheetName: null, rowNumber: null,
    entityType: null, entityKey: code, severity, code, message, rawValue: null,
  };
}

/**
 * Códigos de ocorrência ESTRUTURAL FATAL: impedem a confirmação (HTTP 422).
 * Demais ocorrências (linha inválida, chave vazia, ID ausente, erro de fórmula,
 * conflito de status entre fontes) são não fatais e permitem a importação.
 */
export const FATAL_ISSUE_CODES: ReadonlySet<string> = new Set([
  "MISSING_ORDERS_TABLE",
  "MISSING_INVENTORY_TABLE",
  "MISSING_REQUIRED_COLUMNS",
  "NO_VALID_ORDERS",
  "NO_VALID_INVENTORY",
  "REFERENCE_KEY_CONFLICT",
  "FILE_UNREADABLE",
]);

export function isFatalIssue(issue: ImportIssue): boolean {
  return FATAL_ISSUE_CODES.has(issue.code);
}

function summarize(issues: ImportIssue[]): {
  warnings: number; errors: number; conflicts: number; fatal: number; summary: Record<string, number>;
} {
  const summary: Record<string, number> = {};
  let warnings = 0, errors = 0, conflicts = 0, fatal = 0;
  for (const i of issues) {
    const k = `${i.severity}:${i.code}`;
    summary[k] = (summary[k] ?? 0) + 1;
    if (i.severity === "WARNING") warnings++;
    else if (i.severity === "ERROR") errors++;
    else conflicts++;
    if (isFatalIssue(i)) fatal++;
  }
  return { warnings, errors, conflicts, fatal, summary };
}

function detectedTables(assignment: Assignment): { fileName: string; sheetName: string; tables: DetectedTable[] }[] {
  const byFile = new Map<string, DetectedTable[]>();
  for (const d of assignment.allDetections) {
    const tables = byFile.get(d.fileName) ?? [];
    for (const m of d.roleMatches) {
      if (!m.ok) continue;
      tables.push({
        role: m.role,
        sheetName: d.sheetName,
        headerRow: d.headerRowNumber,
        matchedHeaders: m.matched,
        missingRequired: m.missingRequired,
      });
    }
    byFile.set(d.fileName, tables);
  }
  return [...byFile.entries()].map(([fileName, tables]) => ({ fileName, sheetName: "", tables }));
}

function batchTmpDir(batchId: number): string {
  return path.join(config.uploadTmpDir, `batch-${batchId}`);
}

/** Hash do arquivo, ou null quando o arquivo está ilegível/ausente (não lança). */
function safeHash(filePath: string, fileLabel: string, issues: ImportIssue[]): string | null {
  try {
    return sha256File(filePath);
  } catch (err) {
    issues.push(structural("FILE_UNREADABLE", "ERROR", `Arquivo ilegível ou ausente (${fileLabel}): ${(err as Error).message}`));
    return null;
  }
}

/** Copia o arquivo para o diretório do lote; ignora silenciosamente se ilegível (já reportado). */
function safeCopy(src: string, dest: string): void {
  try {
    fs.copyFileSync(src, dest);
  } catch {
    /* já reportado como FILE_UNREADABLE na etapa de hash */
  }
}

/** Lista as abas, ou [] quando o arquivo está ilegível/ausente (não lança). */
function safeListSheetNames(filePath: string): string[] {
  try {
    return listSheetNames(filePath);
  } catch {
    return [];
  }
}

/** Etapa 1 — pré-visualização. Não grava dados de origem; só cria o lote-handle. */
export function preview(db: Db, orders: FileInput, analysis: FileInput): ImportPreview {
  const startedAt = Date.now();
  const hashIssues: ImportIssue[] = [];
  const ordersHash = safeHash(orders.filePath, orders.fileName, hashIssues);
  const analysisHash = safeHash(analysis.filePath, analysis.fileName, hashIssues);

  let outcome: AnalysisOutcome;
  if (ordersHash === null || analysisHash === null) {
    // Arquivo ilegível/ausente: nem tenta abrir com o leitor de planilhas.
    outcome = {
      assignment: { allDetections: [] },
      orders: EMPTY<OrderPartRecord>(),
      inventory: EMPTY<InventoryRecord>(),
      quotations: EMPTY<QuotationRecord>(),
      analysis: EMPTY<AnalysisRecord>(),
      issues: hashIssues,
    };
  } else {
    try {
      outcome = analyzeFiles(orders, analysis);
    } catch (err) {
      // Arquivo ilegível / formato inválido: ocorrência fatal, prévia ainda exibida.
      outcome = {
        assignment: { allDetections: [] },
        orders: EMPTY<OrderPartRecord>(),
        inventory: EMPTY<InventoryRecord>(),
        quotations: EMPTY<QuotationRecord>(),
        analysis: EMPTY<AnalysisRecord>(),
        issues: [structural("FILE_UNREADABLE", "ERROR", `Arquivo ilegível ou formato inválido: ${(err as Error).message}`)],
      };
    }
  }
  const { fatal, summary } = summarize(outcome.issues);

  // Hash sentinela (nunca colide com uma importação real) quando o arquivo é ilegível.
  const ordersHashFinal = ordersHash ?? `UNREADABLE:${Date.now()}:${Math.random()}`;
  const analysisHashFinal = analysisHash ?? `UNREADABLE:${Date.now()}:${Math.random()}`;

  const existing =
    ordersHash !== null && analysisHash !== null
      ? repo.findCompletedBatchByHashes(db, ordersHash, analysisHash)
      : null;

  const previewBatchId = repo.createPreviewBatch(db, {
    analysisFileName: analysis.fileName,
    ordersFileName: orders.fileName,
    analysisHash: analysisHashFinal,
    ordersHash: ordersHashFinal,
  });

  // Guarda os arquivos em diretório estável por lote para a confirmação
  // (arquivos ilegíveis/ausentes simplesmente não são copiados).
  const dir = batchTmpDir(previewBatchId);
  fs.mkdirSync(dir, { recursive: true });
  safeCopy(orders.filePath, path.join(dir, "orders.xlsx"));
  safeCopy(analysis.filePath, path.join(dir, "analysis.xlsx"));

  const sheetsInfo = [
    { fileName: orders.fileName, names: safeListSheetNames(orders.filePath) },
    { fileName: analysis.fileName, names: safeListSheetNames(analysis.filePath) },
  ];
  const detected = detectedTables(outcome.assignment);

  return {
    previewBatchId,
    analysisFileName: analysis.fileName,
    ordersFileName: orders.fileName,
    analysisFileHash: analysisHashFinal,
    ordersFileHash: ordersHashFinal,
    alreadyImported: existing !== null,
    existingBatchId: existing?.id ?? null,
    canConfirm: fatal === 0,
    fatalIssuesCount: fatal,
    sheets: sheetsInfo.map((s) => ({
      fileName: s.fileName,
      sheetNames: s.names,
      detected: detected.find((d) => d.fileName === s.fileName)?.tables ?? [],
    })),
    counts: {
      ordersFound: outcome.orders.rowsFound,
      ordersValid: outcome.orders.records.length,
      inventoryFound: outcome.inventory.rowsFound,
      inventoryValid: outcome.inventory.records.length,
      quotationsFound: outcome.quotations.rowsFound,
      quotationsValid: outcome.quotations.records.length,
      analysisFound: outcome.analysis.rowsFound,
      analysisValid: outcome.analysis.records.length,
    },
    durationMs: Date.now() - startedAt,
    issues: outcome.issues,
    issueSummary: summary,
  };
}

/** Etapa 2 — confirmação. Importa em transação; idempotente por hash. */
export function confirm(db: Db, previewBatchId: number): ImportResult {
  const batch = repo.getBatch(db, previewBatchId);
  if (!batch) throw new ImportError(404, "Lote de pré-visualização não encontrado.");

  // Idempotência: se já existe um lote concluído com os mesmos hashes, no-op.
  const existing = repo.findCompletedBatchByHashes(db, batch.orders_file_hash, batch.analysis_file_hash);
  if (existing && existing.id !== previewBatchId) {
    cleanupBatchDir(previewBatchId);
    repo.deleteBatch(db, previewBatchId);
    return {
      batchId: existing.id,
      status: existing.status,
      ordersFound: existing.orders_found, ordersImported: existing.orders_imported,
      inventoryFound: existing.inventory_found, inventoryImported: existing.inventory_imported,
      quotationsFound: existing.quotations_found, quotationsImported: existing.quotations_imported,
      analysisFound: existing.analysis_found, analysisImported: existing.analysis_imported,
      warningsCount: existing.warnings_count, errorsCount: existing.errors_count,
      conflictsCount: existing.conflicts_count,
      alreadyImported: true,
    };
  }

  // A importação Excel é uma INICIALIZAÇÃO ÚNICA do sistema. Depois de
  // inicializado, novas importações (arquivos diferentes) são recusadas — o
  // sistema passa a ser a fonte operacional. Só dev/teste reabre via
  // ALLOW_LEGACY_REIMPORT=true. A reimportação idempotente (mesmos hashes) já
  // retornou acima e não chega aqui.
  if (isInitialized(db) && !allowLegacyReimport()) {
    throw new ImportError(
      409,
      "Sistema já inicializado: a importação Excel só é usada para inicializar o sistema. " +
        "Novas importações estão bloqueadas (defina ALLOW_LEGACY_REIMPORT=true apenas em dev/teste).",
    );
  }

  const dir = batchTmpDir(previewBatchId);
  const ordersPath = path.join(dir, "orders.xlsx");
  const analysisPath = path.join(dir, "analysis.xlsx");
  if (!fs.existsSync(ordersPath) || !fs.existsSync(analysisPath)) {
    // Hash sentinela: o arquivo já era ilegível/ausente na própria prévia (fatal, 422).
    const wasUnreadable =
      batch.orders_file_hash.startsWith("UNREADABLE:") || batch.analysis_file_hash.startsWith("UNREADABLE:");
    if (wasUnreadable) {
      throw new ImportError(422, "Importação bloqueada: arquivo ilegível ou ausente na prévia. Corrija e refaça a importação.");
    }
    throw new ImportError(410, "Arquivos da pré-visualização expiraram. Refaça a importação.");
  }

  const orders: FileInput = { filePath: ordersPath, fileName: batch.orders_file_name };
  const analysis: FileInput = { filePath: analysisPath, fileName: batch.analysis_file_name };

  let outcome: AnalysisOutcome;
  try {
    outcome = analyzeFiles(orders, analysis);
  } catch (err) {
    // O backend recalcula as condições fatais na confirmação (não confia só no frontend).
    outcome = {
      assignment: { allDetections: [] },
      orders: EMPTY<OrderPartRecord>(),
      inventory: EMPTY<InventoryRecord>(),
      quotations: EMPTY<QuotationRecord>(),
      analysis: EMPTY<AnalysisRecord>(),
      issues: [structural("FILE_UNREADABLE", "ERROR", `Arquivo ilegível ou formato inválido: ${(err as Error).message}`)],
    };
  }
  const { warnings, errors, conflicts, fatal } = summarize(outcome.issues);

  // Erros estruturais fatais impedem a confirmação.
  if (fatal > 0) {
    throw new ImportError(422, `Importação bloqueada: ${fatal} ocorrência(s) estrutural(is) fatal(is). Corrija os arquivos e refaça a importação.`);
  }

  const status =
    warnings > 0 || errors > 0 || conflicts > 0 ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";

  db.exec("BEGIN");
  try {
    // Importação idempotente do snapshot: limpa qualquer dado parcial deste lote.
    db.prepare("DELETE FROM source_order_parts WHERE import_batch_id = ?").run(previewBatchId);
    db.prepare("DELETE FROM source_inventory_items WHERE import_batch_id = ?").run(previewBatchId);
    db.prepare("DELETE FROM source_quotations WHERE import_batch_id = ?").run(previewBatchId);
    db.prepare("DELETE FROM source_order_analysis WHERE import_batch_id = ?").run(previewBatchId);
    db.prepare("DELETE FROM import_issues WHERE import_batch_id = ?").run(previewBatchId);

    const ordersImported = repo.insertOrderParts(db, previewBatchId, outcome.orders.records);
    const inventoryImported = repo.insertInventory(db, previewBatchId, outcome.inventory.records);
    const quotationsImported = repo.insertQuotations(db, previewBatchId, outcome.quotations.records);
    const analysisImported = repo.insertAnalysis(db, previewBatchId, outcome.analysis.records);
    repo.insertIssues(db, previewBatchId, outcome.issues);

    repo.updateBatchOnComplete(db, previewBatchId, {
      status,
      ordersFound: outcome.orders.rowsFound, ordersImported,
      inventoryFound: outcome.inventory.rowsFound, inventoryImported,
      quotationsFound: outcome.quotations.rowsFound, quotationsImported,
      analysisFound: outcome.analysis.rowsFound, analysisImported,
      warningsCount: warnings, errorsCount: errors, conflictsCount: conflicts,
    });

    // Inicialização única: na primeira importação confirmada, fixa o lote
    // inicial e cria as solicitações de compra aprovadas. Idempotente — só age
    // se o sistema ainda não estiver inicializado. Dentro desta transação.
    initializeSystem(db, previewBatchId, null);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    // O lote-handle permanece, marcado como FALHO (fora da transação revertida).
    db.prepare("UPDATE import_batches SET status='FAILED', finished_at=datetime('now') WHERE id=?").run(previewBatchId);
    throw new ImportError(500, `Falha na importação (rollback aplicado): ${(err as Error).message}`);
  }

  cleanupBatchDir(previewBatchId);

  const final = repo.getBatch(db, previewBatchId)!;
  return {
    batchId: final.id,
    status: final.status,
    ordersFound: final.orders_found, ordersImported: final.orders_imported,
    inventoryFound: final.inventory_found, inventoryImported: final.inventory_imported,
    quotationsFound: final.quotations_found, quotationsImported: final.quotations_imported,
    analysisFound: final.analysis_found, analysisImported: final.analysis_imported,
    warningsCount: final.warnings_count, errorsCount: final.errors_count,
    conflictsCount: final.conflicts_count,
    alreadyImported: false,
  };
}

function cleanupBatchDir(batchId: number): void {
  const dir = batchTmpDir(batchId);
  fs.rmSync(dir, { recursive: true, force: true });
}

export class ImportError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "ImportError";
  }
}
