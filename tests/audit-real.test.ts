import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAudit } from "../scripts/audit-real.js";
import {
  ANALYSIS_HEADER,
  BIPAGEM_HEADER,
  ORDERS_HEADER,
  QUOTATION_HEADER,
  cleanup,
  makeXlsx,
  orderRow,
} from "./helpers.js";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanup(created.pop()!);
});

describe("npm run audit:real — geração do relatório (fixtures pequenas)", () => {
  it("gera REAL_DATA_AUDIT.md e os dois CSVs com conteúdo coerente", async () => {
    const ordersPath = makeXlsx(
      [
        {
          name: "PEDIDOS",
          aoa: [
            ORDERS_HEADER,
            orderRow({ idPedido: "PED1", imei: "111", chave: "BATERIA 13", status: "Concluído", statusKit: "KIT POSSÍVEL", custo: 50, venda: 200 }),
            orderRow({ idPedido: "PED2", imei: "222", chave: "TELA X", status: "PEDIR PEÇA", statusKit: "KIT INCOMPLETO" }),
          ],
        },
        { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT 13", "QUARTT", "BATERIA 13", "DISPONÍVEL", "PC-1"]] },
      ],
      "PEDIDOS.xlsx",
    );
    const analysisPath = makeXlsx(
      [
        { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER, ["PED2", "TELA X", 3, 40, 120, "2026-06-26", "COTANDO"]] },
        { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
        {
          name: "PEDIDOS FULL",
          aoa: [
            ORDERS_HEADER,
            orderRow({ idPedido: "PED1", imei: "111", chave: "BATERIA 13", status: "SEM SALDO", statusKit: "KIT POSSÍVEL" }), // diverge do primário -> STATUS_CONFLICT
          ],
        },
      ],
      "ANALISE MI.xlsx",
    );
    created.push(ordersPath, analysisPath);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-audit-test-out-"));
    const docsDir = path.join(outDir, "docs");
    const auditDir = path.join(outDir, "audit");

    const result = await runAudit(ordersPath, analysisPath, { docsDir, auditDir });

    expect(result.canConfirm).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(fs.existsSync(result.reportPath)).toBe(true);
    expect(fs.existsSync(result.concludedCsvPath)).toBe(true);
    expect(fs.existsSync(result.conflictsCsvPath)).toBe(true);

    const md = fs.readFileSync(result.reportPath, "utf8");
    expect(md).toContain("# Auditoria com dados reais");
    expect(md).toContain("SHA-256");
    expect(md).toContain("Tabelas escolhidas");
    expect(md).toContain("Duração da leitura");
    expect(md).toContain("STATUS_CONFLICT");
    expect(md).toContain("Idempotente");
    expect(md).toContain("**true**");

    const concludedCsv = fs.readFileSync(result.concludedCsvPath, "utf8");
    expect(concludedCsv.split("\n")[0]).toContain("id_pedido");
    expect(concludedCsv).toContain("PED1");

    const conflictsCsv = fs.readFileSync(result.conflictsCsvPath, "utf8");
    expect(conflictsCsv).toContain("PED1");
    expect(conflictsCsv).toContain("Status divergente");

    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
