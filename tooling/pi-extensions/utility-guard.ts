/**
 * utility-guard — bloquea TODO el toolset en sesiones de utilería del engine
 * (ID01-491, incidente 2026-08-19 ×2).
 *
 * El engine Zeron genera "corridas de utilería" (titulado de chats) mandando
 * un prompt que EMBEBE el primer mensaje del usuario. El modelo barato de esa
 * corrida tiende a EJECUTAR la tarea embebida en vez de responder el título:
 * primero lo hizo vía la tool subagents (dos batches fantasma), y tras el gate
 * de subagents (ID01-490) lo repitió con bash/edit — branch y PR duplicados
 * compitiendo con la sesión real en el mismo working tree.
 *
 * El guard: si el PRIMER input de la sesión matchea el prefijo canónico de
 * utilería, todo `tool_call` (built-ins y custom) se bloquea con
 * {block:true} — el agente solo puede responder texto, que es lo único que
 * una corrida de utilería debe producir.
 *
 * - SIN `terminate` (hallazgo ALTA del review k3): terminate podía cortar el
 *   turno con cero TextDeltas si el primer mensaje del modelo era
 *   tool-call-only → título vacío. El block simple deja que el loop converja
 *   al texto (el incidente mismo lo probó: tras un block, el modelo sigue y
 *   termina respondiendo). Además `terminate` dependía de que TODO el batch
 *   lo tuviera (every() en agent-loop) — frágil ante otros blockers.
 * - First-input-only: las corridas de utilería son de UN solo prompt; un
 *   mensaje posterior de un usuario legítimo que empiece igual no envenena
 *   nada (mismo criterio que el gate de subagents, hallazgo k3 en ID01-490).
 *   `session_start` resetea el estado: un proceso pi que sirva más de una
 *   sesión (/new en TUI) re-evalúa su primer input.
 * - Cubre el camino prompt() (el que usa el titulado del engine hoy). Los
 *   deliveries por steer/followUp/triggerTurn no emiten `input` — límite
 *   compartido con el gate de subagents; el cierre total es el marcador
 *   estructural del engine (ID01-491).
 * - Convive con el gate interno de subagents.ts (belt & suspenders); la
 *   constante está duplicada a propósito — cada extensión debe funcionar
 *   sola (test anti-drift en utility-guard.test.mjs).
 * - Deploy GLOBAL (~/.pi/agent/extensions/): las extensiones project-local
 *   no cargan en rpc/print sin trust del proyecto.
 *
 * No toca el engine.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Espejo de TITLE_PROMPT_PREFIX + frase fija en crates/engine/src/titles.rs. */
export const UTILITY_PROMPT_PREFIX = "Reply with ONLY a concise 3-5 word title";

export const BLOCK_REASON =
	"utility-guard: sesión de utilería del engine (titulado) — todas las tools están deshabilitadas. Respondé SOLO el texto pedido por el prompt, sin ejecutar nada.";

/** Wiring testeable: inyectá un `pi` mock. */
export function installUtilityGuard(pi: ExtensionAPI): void {
	let utilityRun = false;
	let firstInputSeen = false; // solo el PRIMER input decide (utilería = un prompt)

	pi.on("session_start", () => {
		// Un proceso pi puede servir más de una sesión (/new en TUI): cada
		// sesión re-evalúa su primer input desde cero (hallazgo k3). Edge
		// asumido: una sesión de utilería RESUMIDA no re-emite su input
		// original, así que el gate queda off con la tarea embebida en el
		// historial — nadie resume titulados hoy; el cierre real es ID01-491.
		utilityRun = false;
		firstInputSeen = false;
	});

	pi.on("input", (ev: { text?: string }) => {
		if (firstInputSeen) return;
		firstInputSeen = true;
		if (typeof ev?.text === "string" && ev.text.startsWith(UTILITY_PROMPT_PREFIX)) utilityRun = true;
	});

	pi.on("tool_call", () => {
		if (!utilityRun) return undefined;
		// Block SIN terminate: el modelo debe poder seguir hasta emitir el
		// título como texto. pi no tiene max-turns, pero el loop de blocks es
		// corto en la práctica (el modelo converge tras 1-2 intentos, como
		// mostró el incidente) y el reaper del engine acota el peor caso.
		return { block: true, reason: BLOCK_REASON };
	});
}

export default function (pi: ExtensionAPI): void {
	installUtilityGuard(pi);
}
