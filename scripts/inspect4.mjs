import fs from 'node:fs';
const BASE = 'C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\REPOSITÓRIOS\\';
for (const f of ['DATASYS COM SALDO.csv','DATASYS TODOS.csv']) {
  try {
    const txt = fs.readFileSync(BASE + f, 'latin1');
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    const sep = lines[0].includes(';') ? ';' : ',';
    const hdr = lines[0].split(sep).map(h => h.trim());
    const sample = lines[1] ? lines[1].split(sep).map(v => v.trim().slice(0,25)) : [];
    console.log(f, '| ROWS:', lines.length-1, '| SEP:', sep);
    console.log('HDR:', JSON.stringify(hdr));
    console.log('SAMPLE:', JSON.stringify(sample));
  } catch(e) { console.log(f, 'ERRO:', e.message); }
}
