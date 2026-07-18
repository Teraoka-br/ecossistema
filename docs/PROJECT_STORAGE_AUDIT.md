# Auditoria de Storage — Sistema de Peças

> Gerado em: 2026-07-17

## Tamanhos principais (dentro do worktree)

| Pasta/Arquivo                | Tamanho | Risco | Pode apagar? | Observacao |
|------------------------------|--------:|-------|--------------|------------|
| `node_modules/`              | 7,9 MB  | BAIXO | Sim (recriar com `npm install`) | Ignorado pelo .gitignore |
| `data/`                      | 7,9 MB  | ALTO  | Nao          | Banco operacional + backups reais |
| `data/app.sqlite`            | 1,4 MB  | ALTO  | Nao          | Banco operacional — NUNCA apagar |
| `data/app.sqlite-wal`        | 258 KB  | MEDIO | Nao (manual) | WAL ativo; sera consolidado no proximo checkpoint |
| `data/app.sqlite-shm`        | 32 KB   | BAIXO | Nao (manual) | Shared memory do WAL |
| `data/backups/`              | 6,3 MB  | MEDIO | Parcialmente | Ver regra abaixo |
| `dist/`                      | 4,7 MB  | BAIXO | Sim          | Build gerado; ignorado pelo .gitignore |
| `src/`                       | 1,9 MB  | NULO  | Nao          | Codigo-fonte do projeto |

## Backups em data/backups/

| Arquivo                                          | Tamanho | Pode apagar? |
|--------------------------------------------------|--------:|--------------|
| `app-2026-07-18T02-29-40-513Z.sqlite` (mais novo)| 1,4 MB  | Nao          |
| `app-2026-07-15T13-35-17-039Z.sqlite`            | 1,3 MB  | Opcinal (> 7 dias) |
| `app-2026-07-14T13-51-58-039Z.sqlite`            | 1,3 MB  | Opcional (> 7 dias) |
| `app-2026-07-14T13-51-52-951Z.sqlite`            | 1,3 MB  | Opcional (> 7 dias) |
| `app-2026-07-14T13-51-45-537Z.sqlite`            | 1,3 MB  | Opcional (> 7 dias) |

**Recomendacao:** manter os ultimos 3 backups (ou 7 dias). Nunca apagar automaticamente.

## Verificacao do .gitignore

Confirmado que o `.gitignore` ja exclui corretamente:
- `node_modules/`
- `dist/`
- `data/*.sqlite`, `data/*.sqlite-wal`, `data/*.sqlite-shm`
- `data/backups/`
- `data/tmp/`
- `.env`
- `*.xlsx`
- `.claude/worktrees/`
- `.claire/`

## Recomendacoes

1. **Nao apagar** `data/app.sqlite` — banco operacional com dados reais do beta.
2. **Nao apagar** o backup mais recente de cada dia.
3. **Pode apagar** backups com mais de 7 dias apos confirmar que o banco operacional esta integro.
4. **Pode apagar** `dist/` a qualquer momento — e gerado pelo `npm run build`.
5. **Pode apagar** `data/app.sqlite-wal` e `-shm` apenas apos fazer `PRAGMA wal_checkpoint(FULL)` ou parar o servidor — nao apagar enquanto o servidor estiver rodando.
6. **Pode recriar** `node_modules/` com `npm install`.
