# Como rodar o beta (Windows)

## URLs oficiais do modo beta

| O quê | URL |
|---|---|
| **Frontend (use esta)** | http://localhost:5173 |
| **Backend / API** | http://localhost:3001/api |
| **Banco de dados** | `data/app-beta.sqlite` |

> **Nunca abra `http://localhost:3001` diretamente no beta.**
> Nesse modo, a porta 3001 serve apenas a API. O frontend roda via Vite na porta 5173.

---

## Pré-requisito: inicializar o banco beta (uma vez só)

```powershell
npm run beta:init
```

Isso cria `data/app-beta.sqlite` copiando ou migrando o banco de produção.

---

## Iniciar o beta

```powershell
npm run beta:start
```

O comando inicia dois processos em paralelo:

- **Backend** — `npx.cmd tsx watch src/server/index.ts` (porta 3001, com hot-reload)
- **Frontend** — `npx.cmd vite --host 0.0.0.0` (porta 5173, com HMR)

O backend imprime um banner no terminal confirmando o modo e o banco usado:

```
============================================================
[server] Modo          : BETA (tsx watch)
[server] DATABASE_PATH : C:\...\data\app-beta.sqlite
[server] Porta         : 3001
[server] Frontend beta : http://localhost:5173  ← use esta URL
[server] API           : http://localhost:3001/api
[server] NUNCA acesse  : http://localhost:3001 diretamente no beta
============================================================
```

Se `DATABASE_PATH` não terminar com `app-beta.sqlite`, o backend **aborta com erro**.

---

## Parar o beta

**Opção 1 — script:**
```powershell
npm run beta:stop
```

**Opção 2 — Ctrl+C** no terminal onde `beta:start` está rodando (mata ambos os processos).

**Opção 3 — força bruta (Windows):**
```powershell
taskkill /F /IM node.exe
```

---

## Modo produção (usar dist/)

```powershell
npm run build
npm run beta:start:prod
```

Nesse modo o frontend é servido pelo próprio backend na porta 3001 (a partir de `dist/client`).
Use `http://localhost:3001` para acessar a aplicação completa.

---

## Resumo dos comandos

| Comando | O que faz |
|---|---|
| `npm run beta:init` | Cria `data/app-beta.sqlite` |
| `npm run beta:start` | Inicia backend (3001) + frontend Vite (5173) |
| `npm run beta:stop` | Para os processos iniciados por `beta:start` |
| `npm run beta:start:prod` | Inicia backend servindo `dist/` (3001 completo) |
| `npm run dev` | Desenvolvimento normal (não-beta, banco `data/app.sqlite`) |
