# Notas — Timer acumulado del task (ID01-423)

Branch: `feat/task-timer-accumulate` (desde `origin/main`). No mergeado, engine no swappeado.

## Qué cambió

`started_at` ahora significa "inicio del **task del usuario actual**", no "inicio del turno interno":

1. **`crates/engine/src/sessions.rs` — `set_status`** (regla nueva):
   - `Working + fresh_start` → restamp (dispatch / steer de usuario — el bug "timer abre en 30:00" sigue cubierto).
   - `Working + started_at None` → setear ahora (primera vez).
   - `Working` otherwise → **no tocar** (`was_active` dejó de decidir).
   - `Idle/Errored` con run handle **vivo** (park por quiesce o Done de sesión persistente) → **conservar** la base.
   - `Idle/Errored` sin run handle (settle verdadero: interrupt, reaper, `remove_run`+settle) → `started_at = None`.
   - `run_alive` se lee de `runs` ANTES de tomar el lock de `statuses` (sin anidamiento de locks; el settle ya hace `remove_run` antes del `set_status` final, así que lee el handle ausente).
2. **`sessions.rs` ~1406 (resume self-continued)**: `set_status(Working, true)` → `false` — el output self-continued es el MISMO task del usuario, no restampa.
3. **`steer()` y el dispatch ruteado a un run vivo**: `fresh_start: true`. Si queda `false`, el park conserva la base vieja y un mensaje nuevo reabre el reloj anterior (regresión del bug "timer abre en 30:00").
4. **Evento `Steered` (park y mid-run)**: `fresh_start: false` — el send ya restampó; un segundo restamp hacía 0:00 → 0:0X → 0:00 (hallazgo k3).
5. **`settle_status`**: sostiene el lock de `runs` mientras escribe Idle/Errored. Si ya hay un run nuevo, no toca el row (cierra el TOCTOU check→insert→Idle).
6. **Tests** (`crates/engine/tests/e2e.rs`):
   - `parked_steer_restamps_started_at_and_idle_clears_it` (actualizado): park conserva la base; steer de usuario sigue restampando (`started >= before_steer`); el drop de la base se espera solo en el settle verdadero (`Idle && started_at.is_none()`).
   - `self_continued_resume_keeps_started_at` (nuevo): turno 1 Working con base `t0` → park (Idle conserva `t0`) → output self-continued (≥ RESUME_GATE 1s, sin steer) re-arma Working con `started_at == t0` → settle final limpia.

## Tests / verificación

- `cargo check -p zeron-engine` → limpio.
- `cargo test -p zeron-engine --test e2e -- parked_steer self_continued_resume` → 2 passed.

## NO verificado

- **iPhone/iOS real**: no compilé ni probé la app iOS. El análisis del spec dice que `SessionView` ya muestra elapsed = `now - startedAt` cuando Working, así que con la base conservada el número sigue; no lo validé en dispositivo.
- **Hardening iOS**: se skipeó (spec lo permitía). `sessionStartedAt` devuelve `Int64` con fallback `nowMs()`; quitarlo exige propagar `Optional` al call site — no eran 2 líneas. Con el fix del engine, `startedAt` nil en Working solo puede ocurrir un frame en dispatch nuevo (overlay del composer ya cubre 0:00).
