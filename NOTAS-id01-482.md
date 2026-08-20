# NOTAS-id01-482 — Fase 1 (investigación) + veredicto Fase 2

Issue: [ID01-482](https://linear.app/davidhsutton/issue/ID01-482/pi-harness-subagentes-visibles-en-la-app-integrar-la-extension)
Fecha: 2026-08-19. Solo lectura del código vivo en `main` (`02129c5`).

## Veredicto (define Fase 2)

**La viz NO se alimenta con “el formato correcto” desde la extensión ni con config de paths.**
No hay path ACP genérico. `AgentEvent::Subagent` (lo único que abre tab + flippea el spawn chip) lo producen **solo** observers de harness: Grok (disk-tail) u OpenCode (SSE sidecar). Pi **ya usa el observer Grok**, inerte porque nunca emite el wire **privado de grok**.

Tres caminos, uno solo es honesto:

| Camino | ¿Cumple “NO tocar engine”? | ¿N tabs? | ¿Bloqueo? | Veredicto |
|---|---|---|---|---|
| A. Impersonar grok (forjar `_meta.x.ai/tool=spawn_subagent` + `subagent_spawned/finished` + `chat_history.jsonl` bajo `~/.grok/sessions`) vía patch pi-acp | sí, en letra | solo si el adapter emite **N** `spawn_subagent` sintéticos | 2º patch sobre el mismo `pi-acp@0.0.33` que ya tiene `_session/steering`; el issue prohíbe apilarlo hasta reflotar PR #4 | **NO.** Frágil, vendor-private, ensucia `~/.grok`. |
| B. Solo extensión / solo disk-tail de nuestros JSONL | sí | no | el tracker no arranca sin lifecycle grok; nuestros hijos escriben JSONL **pi** en `/tmp/pi-subagents/<batch>/<id>/` y lo **borran al finish** | **Imposible.** |
| C. Observer `Pi` en el engine + señales machine-readable en el `onUpdate` que **ya viaja** (pi-acp → `tool_call_update`) + transcripts pi en path estable | no (Fase 1 pisa la nota: el supuesto era falso) | sí: el observer mintea N chips | no depende de pi-acp ni de PR #4 | **SÍ. Este es Fase 2.** |

Heartbeat de texto se queda (fallback + ID01-466). Suite `subagents` 67/67 no se rompe.

## 1. Contrato engine — cómo se “descubre” un subagente

Fuente: `crates/harness/src/acp/subagent.rs`, `subagent_opencode.rs`, `mod.rs`, `normalize.rs`, `crates/engine/src/sessions.rs`.

### 1.1 Dónde se instala el observer

```
crates/harness/src/acp/mod.rs:2014-2028
  HarnessId::Opencode → SubagentObserver::Opencode (bus HTTP /event)
  TODO LO DEMÁS, incluido HarnessId::Pi → SubagentObserver::Grok
```

Comentario en código: *“everything else gets the grok tracker (inert for agents that never emit the `subagent_*` extension updates)”*.

### 1.2 Grok — wire (verificado en código + tests del módulo)

El tracker **no** lee `parent_tool_use_id` del ACP (grok no lo manda; `map_update` tampoco lo wrappea). Observa `session/update` **y** `_x.ai/session_notification` (`mod.rs:1486-1510`).

`observe()` (`subagent.rs:116-125`) solo reacciona a:

| `sessionUpdate` | Qué mira | Efecto |
|---|---|---|
| `tool_call` / `tool_call_update` | `_meta["x.ai/tool"].name == "spawn_subagent"` (`xai_tool_name`, `normalize.rs:96-98`). **No** el `title` ni el `kind`. | Encola chip (`toolCallId` + `rawInput.description`). |
| idem, `status=completed` | texto `subagent_id: <id>` en `rawOutput.text` o content-block (`subagent.rs:290-306`) | Bind chip ↔ id. |
| `subagent_spawned` | `subagent_id`, `child_session_id` (fallback=subagent_id), `parent_session_id` (ignora nested), `description` (bind FIFO) | `start_tail`. |
| `subagent_finished` | `subagent_id`, `status`, `output` | Settlea tail → tagged `Done`. `subagent_progress` **no se implementa**. |

Chip visual “Agent: {description}”: `typed_call` (`normalize.rs:290-297`) cuando `xai_tool_name==spawn_subagent`. OpenCode usa otra heurística (`rawInput.subagent_type` + `prompt`). **`title=="subagents"` no nombra Agent.**

### 1.3 Transcript grok = disk-tail, no ACP

- Root: `~/.grok/sessions` (override test: `AcpHarness::with_sessions_root`).
- Path: `<root>/<cualquier-dir-1-nivel>/<child_session_id>/chat_history.jsonl` (`locate_history`, `subagent.rs:318-330`).
- Poll 250 ms; post-finish drain 6×200 ms.
- Formato **vendor-private grok** (`entry_events`, `subagent.rs:375-451`):
  - `type=reasoning` → `summary[].type==summary_text`
  - `type=assistant` → `content: string` + `tool_calls[{id,name,arguments: STRING json}]`
  - `type=tool_result` → `tool_call_id` + `content: string`
  - `system` / `user` se tiran
- Fail-soft: parse error = “nada nuevo”; si nunca hubo tail, el `output` de `subagent_finished` es el doc.

### 1.4 Sink de la viz (engine, ya existe, no tocar salvo ruteo)

`crates/engine/src/sessions.rs:1492+`:

- `AgentEvent::Subagent { parent_tool_use_id, event }` → **nunca** se folda al transcript padre.
- Abre doc `subagent_doc_id(chat, parent_tool_use_id)`, setea `subagent_ref` en el `MessagePart::Tool` con ese id, flippea el chip (`running` → settle con `Done`).
- Un tab = un `parent_tool_use_id` = **un tool_call en el padre**.
- Si no hay `Tool { id == parent_tool_use_id }` en el fold, igual puede abrir sink y stamp in-place.

**No hay otro sink.** `map_update` (`normalize.rs:334+`) traduce `agent_message_chunk` / `tool_call` / `plan` a eventos planos. Un `customType` de pi **no existe** en este mapa.

### 1.5 OpenCode (solo contexto)

Tool `task` + bus SSE `http://127.0.0.1:{port}/event`. Storage SQLite, **no JSONL**. Irrelevante para pi.

## 2. Qué produce hoy la extensión y por dónde viaja

Fuente: `tooling/pi-extensions/subagents.ts` (= `~/.pi/agent/extensions/subagents.ts`, mismos bytes). Adapter: `~/.zeron/adapters/pi-acp/0.0.33/node_modules/pi-acp/dist/index.js` (ya patcheado con `_session/steering`, `tools/patch_piacp.mjs`).

### 2.1 Extensión

- **Una** tool `subagents` despacha **N** tasks. Ids internos: `t.id ?? \`t${i+1}\`` — **no se escriben de vuelta** a `rawInput` si el modelo no los mandó.
- Heartbeat ≤25 s + updates throttlados vía `opts.onUpdate({ content: [{ type:"text", text }] })` (`subagents.ts:1066-1085`, `1116-1121`). Texto humano: `subagents: ⏳ t1 (research·…) 12s — activity`.
- Background: `pi.sendMessage({ customType: "subagent-result", display: true, details }, { deliverAs: steer|nextTurn })`.
- Hijos: `pi --mode rpc --session-dir {sessionRoot}/{batchKey}/{task.id}` (`sessionRoot` default `os.tmpdir()/pi-subagents`). JSONL **formato pi v3** (`docs/session-format.md`): entries `{type:"message", message:{role, content:[{type:text|thinking|toolCall}]}}`. **Se borra el dir en finish SIEMPRE** (`runTask` finally).
- No emite `_meta`, ni `subagent_*`, ni `spawn_subagent`.

### 2.2 pi-acp (0.0.33)

`handlePiEvent` (`index.js:946+`):

- `tool_execution_start` → `session/update` `{sessionUpdate:"tool_call", toolCallId, title: toolName, kind: toToolKind, rawInput, status}`.
- `tool_execution_update` → `tool_call_update` con `content: [{type:"content", content:{type:"text", text}}]` (el heartbeat).
- `tool_execution_end` → `tool_call_update` `completed|failed` + `rawOutput`.
- `toToolKind("subagents")` → `"other"`.
- **No** hay rama `customType`. `sendMessage` custom termina como mensaje pi (texto en el padre), no como tab.
- **No** reenvía sessionUpdates arbitrarias que la extensión no puede emitir: la extensión no habla ACP.

Punto de traducción: **la extensión no puede, sola, alimentar la viz.** Un patch de adapter *podría* forjar el wire grok (camino A) — vetado por secuencia + fragilidad.

### 2.3 Steering / PR #4

- Patch local de steering **ya está** en el adapter vivo.
- `davidhs26/zeron` PR #4 (descriptor `step-boundary`) sigue **OPEN**.
- ID01-435 (upstream del patch al repo de pi-acp) está en **Backlog**.
- Nota del issue: no apilar un segundo patch divergente. Fase 2 **no toca pi-acp**.

## 3. Bonus disk-tail: ¿es “solo config”?

No.

1. El tail grok busca `chat_history.jsonl` en formato grok bajo `~/.grok/sessions`.
2. Nuestros hijos escriben JSONL pi (schema distinto: `type=message` vs `type=assistant`) en `/tmp/pi-subagents/<batchKey>/<id>/` y lo **borran**.
3. Sin `subagent_spawned` / `_meta.x.ai/tool=spawn_subagent` el Grok tracker **nunca llama `start_tail`**.
4. 1 tool call padre ≠ N tabs.

## 4. Fase 2 — contrato congelado (Camino C)

### 4.1 Extensión (`tooling/pi-extensions/subagents.ts` + runtime `~/.pi/agent/extensions/`)

Mantener heartbeat humano intacto. Agregar **líneas machine-readable** (una por evento, parseables con `strip_prefix`, no JSON) en los mismos `onUpdate`:

```
subagent_spawned: <id> role: <role> model: <model> child_session_id: <id>-<batchKey>
subagent_finished: <id> status: completed|failed|interrupted|error
```

Reglas:

- `id` = el mismo `ResolvedTask.id` de hoy (`t.id ?? t${i+1}`).
- `child_session_id` = `{id}-{batchKey}` (único; el engine no conoce `batchKey`).
- `sessionDir` del hijo = `{transcriptRoot}/{child_session_id}` (sigue `--session-dir` de pi, JSONL nativo).
- `transcriptRoot` default: `~/.pi/agent/subagent-transcripts` (override `PI_SUBAGENTS_TRANSCRIPT_ROOT` / `deps.sessionRoot`).
- **No borrar** el sessionDir en el `finally` inmediato. Delay ≥ 2.5 s (cubre `DRAIN_POLLS` 6×200 + margen) y entonces rm. Fail-soft si el rm falla.
- `subagent_spawned` se emite **al registrar** el task en `inFlight` (antes del await de `runTask`).
- `subagent_finished` se emite en el mismo lugar que hoy el `progressLine` (éxito, timeout 124, error, budget skip 125 → `status: error` / skip como `interrupted`).
- Heartbeat humano sin cambios de semántica. Las líneas machine van **además**, no en lugar.
- Tests: parse de las líneas + path del sessionDir + delay-rm (fake timers). Suite existente verde.

### 4.2 Engine — `SubagentObserver::Pi`

Archivo nuevo `crates/harness/src/acp/subagent_pi.rs`, wired en `mod.rs` cuando `harness == HarnessId::Pi` (Opencode sigue Opencode; el resto Grok).

Al ver `tool_call`/`tool_call_update` cuyo `title` o `rawInput` indica la tool `subagents` (title `"subagents"` / `"Subagents"`):

1. Recordar `parent_tool_use_id` = `toolCallId` (el chip batch, heartbeat fallback).
2. Parsear líneas `subagent_spawned:` del `content` texto (y de `rawOutput` por si acaso).
3. Por cada spawn nuevo:
   - `chip_id = format!("{parent}:{id}")`.
   - Emitir `AgentEvent::ToolCall { id: chip_id, call: Unknown { name: "Agent: {id} ({role})", input: None } }` por `event_tx` (esto **es** el tab; `sessions.rs` clavea por ese id).
   - `start_tail(chip_id, child_session_id)` sobre `{transcript_root}/{child_session_id}/*.jsonl`.
4. `subagent_finished:` → oneshot al tail (mismo settle que grok: drain + tagged `Done`; si no hubo transcript, `output` del progressLine si está a mano, si no chip-only Done).
5. Teardown del tracker (drop / session end) → Interrupted como grok.

`transcript_root`: `$HOME/.pi/agent/subagent-transcripts`, override `PI_SUBAGENTS_TRANSCRIPT_ROOT` y test seam `with_sessions_root` (reusar el campo; solo el observer Pi lo lee con semántica pi).

Tail JSONL **pi v3** (fail-soft, message-granularity — pi escribe entries enteras):

| entry | evento |
|---|---|
| `type=message` + `message.role=assistant` + content `thinking` | `ReasoningDelta` (texto + `\n\n`) |
| idem content `text` | `TextDelta` (texto + `\n\n`) |
| idem content `toolCall` `{id,name,arguments}` | `ToolCall` Unknown/mapeo liviano (name + args object, **no** el string grok) |
| `type=message` + role `toolResult` / entry tool result si aparece | `ToolResult` |
| `session`, `model_change`, `thinking_level_change`, `user` | skip |

Poll/drain iguales a grok (250 ms / 6×200).

Tests unitarios en el módulo (fixtures tipo los de `subagent.rs:616+`) + un caso en `crates/harness/tests/acp.rs` con fake agent que emite title=subagents + las dos líneas + un jsonl pi.

### 4.3 Fuera de alcance

- Patch pi-acp. Upstream ID01-435. PR #4.
- Impersonar grok / escribir `~/.grok/sessions`.
- Nested subagents (`PI_SUBAGENT_DEPTH`).
- Cambiar la tool name `subagents`.
- Deploy/swap del engine (humano).
- **Background (`background: true`)**: el tool call padre se completa al instante; no hay `onUpdate` posterior. v1 no mintea tabs para background (siguen llegando como `subagent-result`). Tabs = foreground.

### 4.4 Aceptación (mapeo del issue)

1. Batch de 2 tasks en Zeron iPhone → 2 chips `Agent: tN (role)` + 2 tabs con transcript taileado, no solo texto. (Verificación E2E post-swap; gate de merge = tests del harness.)
2. Heartbeat `subagents: ⏳ …` sigue en el chip padre. Factory/ID01-466 intacto. `env -u PI_SUBAGENT_DEPTH node tooling/pi-extensions/subagents.test.mjs` verde.
3. Review por modelo ≠ implementador; todos los hallazgos se reparan en la tanda.

## 5. Rama / Linear

- Rama: `davidhsutton/id01-482-pi-harness-subagentes-visibles-en-la-app-integrar-la`
- Linear ID01-482 → In Progress (comentario Fase 1 en el issue).
