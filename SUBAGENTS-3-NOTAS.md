# SUBAGENTS-3 — Notas de implementación (ID01-434, spec 3/3)

Epic ID01-431 · Depends on: ID01-432 + ID01-433 (ya en `main`).
Rama: `feat/subagents-observability`. No toca el engine. No merge/swap/deploy.

## Qué se implementó (v3 de `tooling/pi-extensions/subagents.ts`)

1. **Usage por task** (decisión congelada — NO re-investigada): hijos CON sesión
   en dir descartable. Spawn: `-p --session-dir <sessionRoot>/<batchKey>/<task.id>`
   (ya NO `--no-session`). Al `exit`/timeout/kill/spawn-error: se parsea el jsonl
   de la sesión (`usageFromSessionJsonl`: assistant + toolResult + compaction),
   se suma (`sumUsage`) y se hace `rm -rf` del dir SIEMPRE. `costUsd` solo si
   algún entry trae `cost.total`; si ninguno, se OMITE (nunca un 0 mintiendo).
   Fallback sin jsonl/usage: `{input:0,output:0,cacheRead:0,chars:<len(output)>}`.
2. **Envelope foreground**: `runBatch` sigue devolviendo `SubagentResult[]`
   (ahora con `usage`); el wrapper de la tool arma
   `{results, summary, payg}`. `summary = formatBatchSummary(...)`:
   `"N tasks · X wall · Y cpu · ~$Z total | cost n/d [· incluye PAYG] [· K skipped (presupuesto)]"`.
   `wallMs` lo mide el wrapper (reloj alrededor del batch).
3. **Presupuesto** `PI_SUBAGENTS_MAX_COST_USD` (leído de `baseEnv`):
   antes de spawnear el próximo task de la cola (foreground Y background), si
   `accumulatedCost >= max` → NO spawn; result sintético `exitCode 125`,
   `skipped: "budget"`, output declarativo. Los vivos terminan. En background
   el skipped entra a `completed` con state `"skipped"` y SÍ dispara
   `onComplete` (el orquestador se entera). `CompletedState` ahora incluye
   `"skipped"`.
4. **PAYG**: `payg = algún task con role "hard" o provider resuelto
   "deepseek-payg"` (`batchPayg`). Se refleja en envelope (`payg` + sufijo del
   summary) y en el `note` del dispatch background ("· incluye PAYG").
5. **status().totals**: `{costUsd?, sumMs, payg?}` — best-effort desde el ring
   de completados (el ring recorta a `COMPLETED_RING_MAX = 20`).
6. `onUpdate` por task ahora incluye el costo: `t2/4 done · exit 0 · 3.1s · $0.01 · model`
   (o `cost n/d`). `formatSubagentResult` ganó `· ~$0.01` / `· cost n/d`.

## Contratos nuevos (exportados)

```ts
TaskUsage { input; output; cacheRead; costUsd?; chars? }
sumUsage(parts): TaskUsage          // costUsd solo si alguna part lo trae
usageFromSessionJsonl(text): TaskUsage
parseMaxCostUsd(env): number|undefined   // ausente/""/NaN/<0 → undefined
formatBatchSummary({n,wallMs,sumMs,costUsd?,payg,skipped?}): string
batchPayg(tasks): boolean
usageCostBit(usage?): "~$X" | "cost n/d"
BUDGET_SKIP_EXIT_CODE = 125
```

`RuntimeDeps` gana: `sessionRoot?` (default `os.tmpdir()/pi-subagents`),
`readSessionUsage?`, `rmSessionDir?`, `mkdirSessionDir?`.

## Tests

`env -u PI_SUBAGENT_DEPTH node tooling/pi-extensions/subagents.test.mjs`
→ **45 passed / 0 failed** (33 de 432+433 + 12 de 434; los 2 de 432 cuyo
formato cambia por diseño —spawn args y formatSubagentResult— se actualizaron
al contrato 434, como autoriza el spec). E2E real queda opt-in
(`SUBAGENTS_E2E=1`), NO gate, no ejecutado.

## Parte B — política (FUERA del repo)

- `~/.pi/agent/AGENTS.md`: bump **v6.3 → v6.4** (2026-08-19): tool `subagents`
  como camino DEFAULT (bash `pi -p … < /dev/null` queda de fallback), columna
  `role` en la tabla de fleet, paralelización con UN solo tool call de N tasks,
  narración al despachar/recibir (incluye la línea `summary`), y hard rule del
  handoff ID01-455 (AGENTS.md/tools sin estado mutable por sesión).
- Notebook `zeron-beelink.md`: NO existe en este host (verificado en el spec,
  buscado 2026-08-18) — no se inventó; el bump se registra acá.
- `~/.pi/agent/{models,settings}.json` intocados.
- Copia runtime `~/.pi/agent/extensions/subagents.ts`: se copia al cerrar la
  tanda (`cmp` idéntico a la versionada).

## Review k3 (ronda 1) + fixes

APROBADO CON HALLAZGOS — todos reparados en la misma tanda:
- bloqueante: `task.id` sanitizado (`assertSafeTaskId`, `TASK_ID_RE`) antes de
  path.join/session-dir (cerraba `../../` + `rmSync recursive`).
- leak de dir padre `sessionRoot/batchKey`: `cleanupBatchDir` en finally de
  runBatch y del IIFE background.
- `batchKey` incluye `process.pid` (anti-colisión multi-proceso).
- catch de dispatchBackground ahora manda `usage` ceros.
- `PI_SUBAGENTS_MAX_COST_USD` se parsea por batch (no al crear el runtime).
- `wallMs` del envelope usa `runtime.now()` (reloj inyectable).
- extra: `readSessionUsageFromDir` ya no tira usages con `costUsd` y tokens 0.

## Issue

Linear ID01-434 (epic ID01-431). Commit: `feat(pi): subagents usage/cost + budget (ID01-434)`.
