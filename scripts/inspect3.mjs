import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const BASE = 'C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\';

// Check His Estoque in PEDIDOS.xlsx and ANALISE MI.xlsx
for (const fp of [BASE + 'PEDIDOS.xlsx', BASE + 'ANALISE MI.xlsx']) {
  console.log('\n===', fp.split('\\').pop());
  try {
    const wb = XLSX.readFile(fp, { cellFormula: false, cellHTML: false, sheetRows: 4 });
    const ws = wb.Sheets['His Estoque'];
    if (!ws) { console.log('NO His Estoque sheet'); continue; }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const hi = rows.findIndex(r => r.some(c => c != null));
    console.log('His Estoque HDR_ROW:', hi);
    console.log('HDR:', JSON.stringify(rows[hi]?.map(h => h == null ? '' : String(h))));
    if (rows[hi+1]) console.log('SAMPLE:', JSON.stringify(rows[hi+1]?.map(v => v == null ? null : String(v).slice(0,25))));
    // Check specific columns B, R, S, U (0-indexed: 1, 17, 18, 20)
    const hdr = rows[hi] || [];
    console.log('Col B (idx1):', hdr[1]);
    console.log('Col R (idx17):', hdr[17]);
    console.log('Col S (idx18):', hdr[18]);
    console.log('Col U (idx20):', hdr[20]);
    // Count rows
    const ref = ws['!ref'];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      console.log('TOTAL ROWS:', range.e.r - range.s.r);
    }
  } catch(e) { console.log('ERRO:', e.message); }
}

// Also check TABELA DE AVALIAÇÃO  (PEACS) in PEDIDOS
try {
  console.log('\n=== PEDIDOS TABELA PEACS');
  const wb = XLSX.readFile(BASE + 'PEDIDOS.xlsx', { cellFormula: false, cellHTML: false, sheetRows: 4 });
  const sheetName = wb.SheetNames.find(n => n.includes('AVALIA'));
  console.log('Sheet name:', sheetName);
  if (sheetName) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const hi = rows.findIndex(r => r.some(c => c != null));
    console.log('HDR:', JSON.stringify(rows[hi]?.map(h => h == null ? '' : String(h))));
    if (rows[hi+1]) console.log('SAMPLE:', JSON.stringify(rows[hi+1]?.map(v => v == null ? null : String(v).slice(0,30))));
  }
} catch(e) { console.log('ERRO:', e.message); }

console.log('\n=== DONE');
