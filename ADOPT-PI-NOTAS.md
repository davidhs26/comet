# ADOPT-PI-NOTAS.md — adopción de sesiones pi (feat/adopt-pi-sessions)

## Qué se hizo

`crates/engine/src/pi_adopt.rs` (nuevo, reescrito del borrador): descubre sesiones pi creadas FUERA del engine y las adopta como chats del workspace, visibles desde iOS.

- `Cargo.toml` — feature `v5` de uuid (ya estaba del borrador, se deja).
- `crates/engine/src/lib.rs` — diff mínimo: `pub mod pi_adopt;`, campo `pi_adopt: Option<PiAdopt>` en `EngineCore`, hook `PiAdopt::start(workspace)` después de `SpacesSync::start`, y apagado en `shutdown()` (antes de flushear el workspace, para que un replace de profile no siga escribiendo en el workspace viejo).
- `crates/engine/tests/pi_adopt.rs` — 2 tests de integración.

## Diseño / decisiones

- **Dos fuentes, dedup por sessionId**: session-map de pi-acp (`~/.pi/pi-acp/session-map.json`) primero; después walk de `~/.pi/agent/sessions/*/*.jsonl` (un nivel de subdirs). El walk es OBLIGATORIO: la sesión PW1 vive solo ahí, nunca pasó por pi-acp. Map ilegible/corrupto/ausente → `debug!` y se sigue con el dir. **Desviación del spec (criterio 5 pedía warning)**: un warn cada 45s en máquinas sin pi-acp es spam eterno; el dir fallback cubre el caso. Un warning sí sale si `create_space` no deja una fila legible.
- **chatId determinístico**: UUIDv5 con namespace fijo, name = bytes del sessionId → re-escaneos idempotentes sin estado extra.
- **space_id siempre**: exact match de path → prefijo más largo de un space de ESTE device (con boundary de path: `/a` no matchea `/ab`) → `create_space` con id UUIDv5 (`b"space:" + device_id + 0x00 + cwd`) y RE-LECTURA de spaces (create_space es no-op si ya existe otro id con el mismo (device,path); se usa el id real). Si el re-read falla o la fila no aparece, se skipea el chat (nunca se adivina un space_id colgante: el orphan sweep lo borraría en ≤120s y el próximo scan lo re-adoptaría, ensuciando el oplog). Sin space no se renderiza en iOS.
- **Skip**: sessionId/cwd vacíos, chatId ya existente (cualquier device), chat de este device con ese `harness_session_id`, o JSONL sin mensaje user (incluye transcripts ilegibles — decisión: no adoptamos chats cuyo contenido no podemos verificar; el fallback basename(cwd) del title queda como código defensivo y está cubierto por unit test).
- **Escrituras solo si es nuevo**: nunca se reescribe una fila existente (no ensucia el oplog CRDT); writer discipline: solo este device (`device_id` = engine local). Timestamps: updatedAt del mapa → mtime del file → timestamp de la 1ª línea.
- **Flag silenciosa**: `ZERON_ADOPT_PI_SESSIONS=1` exacto; cualquier otro valor o ausente = apagado con CERO logs y CERO tasks. Overrides para tests: `ZERON_PI_SESSION_MAP`, `ZERON_PI_SESSIONS_DIR` (los lee el loop de producción; las fns testables reciben paths).
- **Nunca rompe el engine**: sin `unwrap()`/`expect()` en runtime; todo error → `tracing` y se sigue.
- Título: primer texto user, trim, truncado UTF-8-safe a 60 chars (59 + `…`).

## Tests (todos pasan)

- Unit (6, en el módulo): UUIDv5 estable/distinto, truncado UTF-8-safe + fallback basename, skip sin mensaje user, descubrimiento map+dir con dedup (caso PW1) + map corrupto/ausente, id desde filename, boundary de prefijos.
- Integración (2): adopción dir-only con space previo (attach, no crea de más), idempotencia en 3 pasadas (map ausente → map presente, dedup a 1 chat, id estable), config Pi, room_gen 2; y caso sin space → crea uno con nombre basename y `git_detected=false`.

## Qué NO se pudo verificar

- No reiniciamos el zeron de producción: el loop con flag on no se probó end-to-end contra Edge/iOS real (solo `adopt_once` directo en tests).
- No abrimos iOS: se asume el invariant del proto (chats sin `spaceId` no se renderizan); por eso space_id siempre resuelto.
- No probé resume: abrir un chat adoptado y que el engine retome la sesión pi vía `session/load` ACP queda para verificación manual.

## Fixes post-revisión adversarial (K3)

Revisor: `kimi-coding/k3 @ high` (modelo distinto al implementador glm-5.3).
- **med resolve_space id colgante**: CORREGIDO. Si el re-read post-`create_space` falla o no encuentra la fila, devolvemos `None` y skipeamos (antes se usaba el id derivado y el orphan sweep lo borra en ≤120s → loop adopt/delete).
- **low IO sync en tokio::spawn**: CORREGIDO. La pasada corre en `spawn_blocking`.
- **low early-break de scan_jsonl**: CORREGIDO. El break queda solo en `first_user_text.is_some()`.
- **low skips silenciosos**: CORREGIDO. Cada early-return de adopción loguea `debug` con motivo.
- **low spec criterio 5 (warning si falta el map)**: aceptado como desviación explícita (ver arriba); no volvemos a warn-spam.
- **low resurrección de chats borrados**: aceptado/documentado. `delete_chat` no deja tombstone; el próximo scan lo re-adopta. Caso borde para discusión upstream.

## Antes de PR upstream

- Documentar la flag en el README/docs del engine (hoy es internals).
- Considerar espaciado exponencial o scan on-boot único + inotify sobre el dir de sesiones.
