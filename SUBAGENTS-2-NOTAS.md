# SUBAGENTS-2-NOTAS — ID01-433: background subagents + status

Implementación de `SPEC-subagents-2.md` en `feat/subagents-background` (rama, sin merge).
Baseline 432 intacta: foreground no cambia semántica.

## Qué se agregó

- `subagents` acepta `background: true` → retorna YA `{dispatched:[{id,role,model}], note}`,
  `details:{dispatched}` (igual shape que 432). Los resultados llegan solos como mensajes
  `customType:"subagent-result"` con `{content, display:true, details:result}`.
- Tool nueva `subagents_status` (sin parámetros, no bloquea, no spawnea):
  `{running:[{id,state:"queued"|"running",elapsed,role,model}], completed:[…últimos 20…]}`,
  más reciente al final del array. `queued` = en cola (cap); `running` = ya spawnó.
- Runtime: `dispatchBackground(tasks,{onComplete,signal})` + `status()` sobre el mismo
  `runTask`/queue cap 4. Validaciones idénticas a foreground (depth, review≠implement, ≥1 task)
  ANTES de spawnear; id colisionando con `running` (o duplicado en el mismo batch) rechaza el
  batch entero, 0 spawns.
- Store `running` (Map) + `completed` (ring 20) vive dentro de `createSubagentsRuntime`; la
  extensión crea UN runtime por proceso pi → equivalente a module-level, sobrevive a cada
  dispatch (no por batch) pero aislado por runtime en tests.
- `killAll()` (abort/shutdown) marca `killed` en CADA entry de `running` (per-entry, no flag
  global): lo que muere a partir de ahí pasa a `completed` con `state:"killed"` (en vuelo y en
  cola). Un abort NO contamina batches futuros (sin flag sticky).
- Cada dispatch lleva un `batch` token: el sweep `finally` solo toca entries de ESE dispatch,
  así reusar un id (p.ej. `t1`) en un batch nuevo no lo clava como killed.
- `session_shutdown` → flag `shutdown` ANTES de `killAll()`: después de shutdown NO se envía
  ningún `sendMessage`.

## Entrega de resultados (decisión congelada, no re-investigar)

- `chooseDeliverAs(agentLive)` → `"steer"` si hay turno vivo, `"nextTurn"` si idle.
- `agentLive` se trackea con `agent_start`/`agent_settled` (NO `agent_end`: hay retries/compaction).
- **`triggerTurn` PROHIBIDO en v1**: con sesión idle dispararía un turno SELF-CONTINUED en Zeron.
  Idle = resultado encolado (`nextTurn`), sin disparar turno.
- 1 `sendMessage` POR resultado (nunca concatenados); `steeringMode:"one-at-a-time"` ya encola.
- Formato: `[subagent ${id} · ${role} · ${model} · ${secs}s · exit ${code}]\n${output}`
  (`secs` = durationMs/1000 a 1 decimal; output ya viene tail-capped a 8KB del runtime 432).

## Limitaciones conocidas (por diseño del spec)

- **Background ≠ durable**: el store es memoria del proceso pi. Restart de pi/session
  (o `session_shutdown` por switch/fork) pierde running/completed y MATA los hijos
  (van a `completed:"killed"` si el proceso vive lo suficiente para registrarlo).
- Los tasks `killed` (en cola o en vuelo) NO disparan `onComplete` (no hay result real); sí
  quedan en `completed` con `state:"killed"` y `exitCode:-1`.
- `state:"done"` = exitCode 0; `"error"` = exitCode ≠ 0 (incluye timeouts → 124 y spawn errors → -1);
  `"killed"` = muerte inducida por killAll (abort/shutdown).
- **Reuso de id en el ring**: el spec solo rechaza ids en `running`; una vez completado, el id se
  libera y un batch nuevo puede reusarlo. El ring puede quedar con dos entradas del mismo id
  (vieja done/killed + nueva done) → desambiguar por `finishedAt` (más reciente último).
- **`killAll()` es global**: el `signal` de UN dispatch (o un abort foreground) mata los hijos de
  TODOS los batches vivos (`live` compartido). En la extensión todos comparten `agent.signal`, así
  que el efecto es el mismo; en un runtime aislado (tests/otros usos) es más destructivo que la API.
- E2E real (`SUBAGENTS_E2E=1`) NO se corrió (no es gate).

## Hardening post-review (k3)

- `onComplete` va en try/catch dentro de `finishTask`: si `pi.sendMessage` lanza (sesión en
  teardown), no re-finaliza el task (evita doble entrada en `completed` + doble mensaje) y no
  propaga (la IIFE fire-and-forget no reventa el proceso con unhandledRejection).
- Timers de SIGKILL (`pendingKills`) con `unref()`: no retienen el event loop tras shutdown/abort.
- `killEpoch`: `killAll()` incrementa; `runBatch` deja de spawnar (cierra el hueco foreground
  post-shutdown). Un batch nuevo captura el epoch actual → no es sticky.
- `dispatchBackground` con `signal` ya abortado **rechaza** (no devuelve dispatched fantasma).
- Ids duplicados en el mismo batch se rechazan también en foreground.
- `installSubagents(pi, runtime)` exportado para testear steer/nextTurn/shutdown.

## Tests

`env -u PI_SUBAGENT_DEPTH node tooling/pi-extensions/subagents.test.mjs` → **33 passed, 0 failed**.

⚠️ Correr SIEMPRE con `env -u PI_SUBAGENT_DEPTH`: el shell de Zeron hereda `PI_SUBAGENT_DEPTH=1`
y `canSpawn()` rechazaría batches que están bien.

## Instalación runtime

Mismos bytes: `cp tooling/pi-extensions/subagents.ts ~/.pi/agent/extensions/subagents.ts`
(verificado con `cmp`). Recarga de pi al próximo arranque de sesión; no toca el engine Zeron.
