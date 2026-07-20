import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const db = new DatabaseSync("data/app-beta.sqlite");

function stripDescrSuffix(s) {
  return s.replace(/\s*[-–]?\s*(OPEN|NOVO|SEMINOVO|OUTLET)\s*$/i, "").trim();
}

function extractCapacity(s) {
  const m = s.match(/\b(\d+\s*(?:GB|TB))\b/i);
  return m ? m[1].replace(/\s+/, "").toUpperCase() : null;
}

function normStr(s) {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

// Carregar PEACS ativo
const peacsRows = db.prepare(
  "SELECT marca_modelo_norm, estimated_sale FROM peacs_catalog WHERE active=1 AND estimated_sale IS NOT NULL"
).all();
const peacsMap = new Map(peacsRows.map(r => [r.marca_modelo_norm, r.estimated_sale]));
console.log("PEACS ativos:", peacsMap.size);

// Casos sem estimated_sale com IMEI
const cases = db.prepare(`
  SELECT rc.id, rc.cost, rc.estimated_sale,
         rsc.codigo_comercial, rsc.descricao
  FROM repair_cases rc
  LEFT JOIN rel_seriais_current rsc ON rsc.imei_norm = rc.imei_norm
  WHERE rc.imei_norm IS NOT NULL AND rc.estimated_sale IS NULL
`).all();
console.log("Casos sem preço para processar:", cases.length);

const stmt = db.prepare("UPDATE repair_cases SET estimated_sale=? WHERE id=?");

let updated = 0;
let noMatch = 0;
const noMatchModels = new Map();

for (const c of cases) {
  if (!c.codigo_comercial) { noMatch++; continue; }

  // 1. Match exato por codigo_comercial (strip sufixo)
  const codClean = normStr(stripDescrSuffix(c.codigo_comercial));
  let price = peacsMap.get(codClean);

  // 2. Se não tem capacidade no codigo_comercial, tenta adicionar da descricao
  if (!price && c.descricao) {
    const cap = extractCapacity(c.descricao);
    if (cap && !extractCapacity(codClean)) {
      const withCap = normStr(`${codClean} ${cap}`);
      price = peacsMap.get(withCap);
    }
  }

  // 3. Fallback: prefixo de 3 palavras
  if (!price) {
    const words = codClean.split(" ").slice(0, 3).join(" ");
    const matches = peacsRows.filter(r => r.marca_modelo_norm.startsWith(words));
    if (matches.length === 1) price = matches[0].estimated_sale;
  }

  if (price) {
    stmt.run(price, c.id);
    updated++;
  } else {
    noMatch++;
    const key = c.codigo_comercial ?? "SEM_COD";
    noMatchModels.set(key, (noMatchModels.get(key) ?? 0) + 1);
  }
}

console.log("\nResultado:");
console.log("  Atualizados:", updated);
console.log("  Sem match:", noMatch);

if (noMatchModels.size > 0) {
  console.log("\nModelos sem match na PEACS (top 20):");
  [...noMatchModels.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([m, n]) => console.log(" ", n + "x", m));
}
