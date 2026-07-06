import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const BASE = 'C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\';
const files = [
  { f: BASE + 'ANALISE MI.xlsx', sheets: ['ANALISEMI','ANALISE MI','ANALISE'] },
  { f: BASE + 'PEDIDOS.xlsx', sheets: ['PEDIDOS','BIPAGEM DE PEÇAS','TABELA DE AVALIAÇÃO PEACS'] },
  { f: BASE + 'BKP SISTEMICO.xlsx', sheets: ['REPAROS TECNICOS','BAIXA_DE_PEÇA','BAIXA DE PEÇA','TRIAGEM ENTRADA'] },
  { f: BASE + 'TRIAGEM SAIDA.xlsx', sheets: ['triagem saida','TRIAGEM SAIDA'] },
  { f: BASE + 'REPOSITÓRIOS\\sH.xlsx', sheets: null },
  { f: 'C:\\Users\\Rocha Telecom\\Downloads\\Rel_Estoque_de_Seriais (77).csv', type: 'csv' },
];

for (const item of files) {
  console.log('\n===', item.f.split('\\').pop());
  if (!fs.existsSync(item.f)) { console.log('NOT FOUND'); continue; }
  const sz = fs.statSync(item.f).size;
  console.log('SIZE:', (sz/1024/1024).toFixed(1), 'MB');

  if (item.type === 'csv') {
    const txt = fs.readFileSync(item.f, 'latin1');
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    const sep = lines[0].includes(';') ? ';' : ',';
    const hdr = lines[0].split(sep).map(h => h.trim());
    const sample = lines[1] ? lines[1].split(sep).map(v => v.trim().slice(0,25)) : [];
    console.log('ROWS:', lines.length - 1, '| SEP:', sep);
    console.log('HDR:', JSON.stringify(hdr));
    console.log('SAMPLE:', JSON.stringify(sample));
    continue;
  }

  try {
    const wb = XLSX.readFile(item.f, { cellFormula: false, cellHTML: false, sheetRows: 3 });
    console.log('ABAS:', JSON.stringify(wb.SheetNames));
    const toRead = item.sheets
      ? wb.SheetNames.filter(n => item.sheets.some(s => n.trim().toUpperCase() === s.trim().toUpperCase()))
      : wb.SheetNames.slice(0, 3);
    const actual = toRead.length ? toRead : wb.SheetNames.slice(0, 3);
    for (const sn of actual) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
      const hi = rows.findIndex(r => r.some(c => c != null));
      if (hi < 0) { console.log(' SHEET:', sn, '| EMPTY'); continue; }
      console.log(' SHEET:', sn, '| HEADER_ROW:', hi, '| HDR:', JSON.stringify(rows[hi]?.map(h => h == null ? '' : String(h))));
      if (rows[hi+1]) console.log('  SAMPLE:', JSON.stringify(rows[hi+1]?.map(v => v == null ? null : String(v).slice(0,20))));
    }
  } catch(e) {
    console.log('ERRO:', e.message);
  }
}
console.log('\n=== DONE');
