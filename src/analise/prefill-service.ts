/**
 * Serviço de pré-preenchimento da análise de aparelho.
 * Agrega dados de SH OS, Rel. Seriais, His Estoque e PEACS.
 *
 * Precedência (campo a campo):
 *   OS              → SH
 *   marca           → SH; fallback: Rel. Seriais
 *   modelo          → SH; fallback: Rel. Seriais
 *   cor             → SH
 *   problema        → SH.defeito
 *   observacaoSv    → SH.obs_servico
 *   codigoComercial → Rel. Seriais
 *   deposito        → Rel. Seriais
 *   idade           → His Estoque
 *   custo           → His Estoque
 *   vendaEstimada   → PEACS (via codigo_comercial normalizado)
 */

import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";

export type FieldSource = "SH" | "SERIAIS" | "HIS" | "PEACS" | "MANUAL";

export interface PrefillResult {
  imei: string | null;
  os: string | null;
  marca: string | null;
  modelo: string | null;
  cor: string | null;
  problema: string | null;
  observacaoServico: string | null;
  codigoComercial: string | null;
  deposito: string | null;
  idade: number | null;
  custo: number | null;
  vendaEstimada: number;
  sources: Partial<Record<string, FieldSource>>;
  warnings: string[];
}

function normalizeImeiLocal(v: string): string {
  return v.replace(/\D/g, "").trim();
}

function normalizeOsLocal(v: string): string {
  return v.replace(/\D/g, "").trim();
}

export function getPrefill(db: Db, query: string): PrefillResult {
  const q = query.trim();
  const isImei = /^\d{10,}/.test(q);
  const imeiNorm = isImei ? normalizeImeiLocal(q) : null;
  const osNorm   = !isImei ? normalizeOsLocal(q) : null;

  const warnings: string[] = [];
  const sources: Partial<Record<string, FieldSource>> = {};

  // ── SH OS ──────────────────────────────────────────────────────────────────
  // Buscar na importação mais recente do SH OS
  let shOs: string | null = null;
  let shImei: string | null = null;
  let shMarca: string | null = null;
  let shModelo: string | null = null;
  let shCor: string | null = null;
  let shDefeito: string | null = null;
  let shObsServico: string | null = null;

  try {
    const latestShImport = db
      .prepare("SELECT id FROM sh_os_imports WHERE status='COMPLETED' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;

    if (latestShImport) {
      let shRow: Record<string, unknown> | undefined;
      if (imeiNorm) {
        shRow = db
          .prepare(
            `SELECT os_raw, imei_raw, marca, modelo, cor, defeito, obs_servico
             FROM sh_os_rows WHERE sh_os_import_id=? AND imei_norm=? ORDER BY id DESC LIMIT 1`,
          )
          .get(latestShImport.id, imeiNorm) as Record<string, unknown> | undefined;
      }
      if (!shRow && osNorm) {
        shRow = db
          .prepare(
            `SELECT os_raw, imei_raw, marca, modelo, cor, defeito, obs_servico
             FROM sh_os_rows WHERE sh_os_import_id=? AND os_norm=? ORDER BY id DESC LIMIT 1`,
          )
          .get(latestShImport.id, osNorm) as Record<string, unknown> | undefined;
      }
      if (shRow) {
        shOs          = (shRow["os_raw"]       as string | null) ?? null;
        shImei        = (shRow["imei_raw"]      as string | null) ?? null;
        shMarca       = (shRow["marca"]         as string | null) ?? null;
        shModelo      = (shRow["modelo"]        as string | null) ?? null;
        shCor         = (shRow["cor"]           as string | null) ?? null;
        shDefeito     = (shRow["defeito"]       as string | null) ?? null;
        shObsServico  = (shRow["obs_servico"]   as string | null) ?? null;
      }
    }
  } catch { /* tabela pode não existir ainda */ }

  // ── Rel. Seriais ────────────────────────────────────────────────────────────
  let serImei: string | null = null;
  let serMarca: string | null = null;
  let serModelo: string | null = null;
  let serCodComercial: string | null = null;
  let serDeposito: string | null = null;

  const lookupImeiNorm = imeiNorm ?? (shImei ? normalizeImeiLocal(shImei) : null);

  try {
    if (lookupImeiNorm) {
      const latestRelImport = db
        .prepare("SELECT id FROM rel_seriais_imports WHERE status='COMPLETED' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;

      if (latestRelImport) {
        // Preferir Disponivel = SIM
        const rows = db
          .prepare(
            `SELECT serial, produto, descricao, codigo_comercial, fabricante, disponivel, deposito_atual
             FROM rel_seriais_rows WHERE rel_seriais_import_id=? AND imei_norm=?
             ORDER BY (CASE WHEN upper(disponivel)='SIM' THEN 0 ELSE 1 END), id DESC`,
          )
          .all(latestRelImport.id, lookupImeiNorm) as Record<string, unknown>[];

        if (rows.length > 1) {
          const simCount = rows.filter((r) => String(r["disponivel"] ?? "").toUpperCase() === "SIM").length;
          if (simCount > 1) warnings.push(`REL_SERIAIS_MULTIPLE_SIM: IMEI ${lookupImeiNorm} tem ${simCount} linhas com Disponivel=SIM.`);
        }

        if (rows.length > 0) {
          const row = rows[0];
          serImei        = (row["serial"]           as string | null) ?? null;
          serMarca       = (row["fabricante"]        as string | null) ?? null;
          serModelo      = (row["produto"]           as string | null) ?? (row["descricao"] as string | null) ?? null;
          serCodComercial= (row["codigo_comercial"]  as string | null) ?? null;
          serDeposito    = (row["deposito_atual"]     as string | null) ?? null;
        }
      }
    }
  } catch { /* tabela pode não existir */ }

  // ── His Estoque ─────────────────────────────────────────────────────────────
  let hisIdade: number | null = null;
  let hisCusto: number | null = null;

  try {
    const hisImeiNorm = lookupImeiNorm;
    if (hisImeiNorm) {
      const latestHisImport = db
        .prepare("SELECT id FROM his_imports WHERE status='COMPLETED' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;

      if (latestHisImport) {
        const hisRow = db
          .prepare(
            `SELECT age_days, audited_cost FROM his_import_rows
             WHERE his_import_id=? AND imei_norm=? ORDER BY source_line DESC LIMIT 1`,
          )
          .get(latestHisImport.id, hisImeiNorm) as { age_days: number | null; audited_cost: number | null } | undefined;

        if (hisRow) {
          hisIdade = hisRow.age_days;
          hisCusto = hisRow.audited_cost;
          if (hisCusto === null) warnings.push("HIS_NO_COST: custo não encontrado no His Estoque.");
        } else {
          warnings.push("HIS_NOT_FOUND: IMEI não encontrado no His Estoque.");
        }
      } else {
        warnings.push("HIS_NO_IMPORT: nenhuma importação de His Estoque encontrada.");
      }
    }
  } catch { /* tabela pode não existir */ }

  // ── PEACS ───────────────────────────────────────────────────────────────────
  let vendaEstimada = 0;
  const codComercial = serCodComercial ?? null;

  try {
    if (codComercial) {
      const codNorm = normalizeKey(codComercial);
      const peacsRows = db
        .prepare(
          `SELECT estimated_sale, marca_modelo FROM peacs_catalog
           WHERE active=1 AND marca_modelo_norm=?`,
        )
        .all(codNorm) as { estimated_sale: number | null; marca_modelo: string }[];

      if (peacsRows.length === 1 && peacsRows[0].estimated_sale != null) {
        vendaEstimada = peacsRows[0].estimated_sale;
        sources["vendaEstimada"] = "PEACS";
      } else if (peacsRows.length > 1) {
        warnings.push(`PEACS_AMBIGUOUS: código comercial "${codComercial}" tem ${peacsRows.length} correspondências na PEACS.`);
      } else {
        warnings.push(`PEACS_NOT_FOUND: código comercial "${codComercial}" não localizado na PEACS.`);
      }
    } else {
      warnings.push("PEACS_NO_CODE: código comercial não disponível para consultar PEACS.");
    }
  } catch { /* tabela pode não existir */ }

  // ── Montar resultado final ─────────────────────────────────────────────────
  const finalImei   = (isImei ? q : (shImei ?? serImei)) ?? null;
  const finalOs     = (!isImei ? q : shOs) ?? null;
  const finalMarca  = shMarca ?? serMarca ?? null;
  const finalModelo = shModelo ?? serModelo ?? null;

  if (finalMarca) sources["marca"]  = shMarca ? "SH" : "SERIAIS";
  if (finalModelo) sources["modelo"] = shModelo ? "SH" : "SERIAIS";
  if (shCor) sources["cor"] = "SH";
  if (shDefeito) sources["problema"] = "SH";
  if (shObsServico) sources["observacaoServico"] = "SH";
  if (serCodComercial) sources["codigoComercial"] = "SERIAIS";
  if (serDeposito) sources["deposito"] = "SERIAIS";
  if (hisIdade != null) sources["idade"] = "HIS";
  if (hisCusto != null) sources["custo"] = "HIS";
  if (finalImei) sources["imei"] = shImei ? "SH" : "SERIAIS";
  if (finalOs) sources["os"] = "SH";

  if (hisCusto === null) warnings.push("CUSTO_ZERO: custo ausente — retornando 0.");

  return {
    imei: finalImei,
    os: finalOs,
    marca: finalMarca,
    modelo: finalModelo,
    cor: shCor,
    problema: shDefeito,
    observacaoServico: shObsServico,
    codigoComercial: codComercial,
    deposito: serDeposito,
    idade: hisIdade,
    custo: hisCusto ?? 0,
    vendaEstimada,
    sources,
    warnings,
  };
}
