/**
 * subagents — tool foreground de subagentes pi (ID01-432, SPEC-subagents-1).
 *
 * Despacha N hijos `pi` en paralelo (cap 4, cola), espera a TODOS y devuelve
 * {id, role, model, exitCode, durationMs, output} por task. Reemplaza el
 * patrón `pi … & wait` del AGENTS.md para tandas paralelas.
 *
 * v2 (ID01-433): `background:true` despacha y retorna YA con {dispatched, note};
 * los resultados llegan solos como mensajes `subagent-result` vía pi.sendMessage
 * (chooseDeliverOpts: steer si el agente está vivo, triggerTurn:true si idle —
 * revisado 2026-08-19: nextTurn dejaba los resultados en un agujero negro).
 * Tool nueva `subagents_status` (running + ring de 20 completados).
 * Background NO es durable: el store vive en el proceso pi, no sobrevive restart.
 *
 * - Copia versionada: /home/david/comet/tooling/pi-extensions/subagents.ts
 * - Copia runtime:    ~/.pi/agent/extensions/subagents.ts (mismos bytes)
 *
 * Background NO es durable: el store vive en el proceso pi, no sobrevive restart.
 *
 * v3 (ID01-434): usage/costo por task (jsonl de la sesión del hijo en dir
 * descartable; fallback chars), envelope foreground {results, summary, payg},
 * presupuesto PI_SUBAGENTS_MAX_COST_USD (tasks NUEVOS no se despachan; los
 * vivos terminan) y status().totals (best-effort, ring de 20).
 *
 * v4 (ID01-461): hijos en modo rpc (`pi --mode rpc`, prompt por stdin, eventos
 * JSONL por stdout) → streaming real: output incremental (no solo al final),
 * actividad rodante en el heartbeat y updates inmediatos throttlados.
 * `PI_SUBAGENTS_CHILD_MODE=print` vuelve al modo `-p` (fallback de emergencia).
 *
 * v5 (ID01-482): viz en la app. Líneas machine-readable en los onUpdate del
 * tool call (`subagent_spawned:` / `subagent_finished:`; el heartbeat humano
 * queda intacto) para el observer Pi del engine, sessionDir del hijo bajo
 * `{transcriptRoot}/{id}-{batchKey}` (default ~/.pi/agent/subagent-transcripts,
 * override PI_SUBAGENTS_TRANSCRIPT_ROOT / deps.sessionRoot) y rm del sessionDir
 * diferido ≥2.5s post-finish para que el engine tailee el JSONL (drain).
 *
 * No toca el engine.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 900_000; // 15 min
export const KILL_GRACE_MS = 10_000; // SIGTERM → +10s → SIGKILL
export const OUTPUT_CAP_BYTES = 8 * 1024;
/** Convención `timeout(1)`: exitCode reportado cuando un task muere por timeout. */
export const TIMEOUT_EXIT_CODE = 124;
/** Convención "no corrido": task NO despachado por presupuesto (ID01-434). */
export const BUDGET_SKIP_EXIT_CODE = 125;

export type Role = "research" | "implement" | "review" | "hard" | "grunt";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Route {
	provider: string;
	model: string;
	thinking: string;
}

/** Tabla de routing por rol (SPEC-subagents-1 §Routing). */
export const ROUTES: Record<Role, Route> = {
	research: { provider: "alibaba", model: "qwen3.8-max", thinking: "low" },
	grunt: { provider: "alibaba", model: "qwen3.8-max", thinking: "low" },
	implement: { provider: "zai", model: "glm-5.3", thinking: "medium" },
	review: { provider: "kimi-coding", model: "k3", thinking: "high" },
	hard: {
		provider: "deepseek-payg",
		model: "deepseek/deepseek-v4-pro",
		thinking: "medium",
	},
};

export function modelKey(route: Route): string {
	return `${route.provider}/${route.model}`;
}

/**
 * Pisos por rol del CAP DURO (ID01-484, 2026-08-19): el orquestador LLM no
 * puede pedir un cap menor al piso. NO son timeouts de ejecución: el asesino
 * primario en modo rpc es la INACTIVIDAD (abajo) — un hijo que emite eventos
 * está trabajando y no se mata por reloj. Los valores anteriores
 * (900/600/300, directiva 2026-08-18) actuaban como timeout efectivo y
 * mataron a los tres hijos de la sesión ID01-482 en pleno trabajo (cargo
 * tests, review de diff Rust) — todos exit 124 con output parcial probándolo.
 */
export const ROLE_TIMEOUT_FLOOR_MS: Record<Role, number> = {
	implement: 3_600_000,
	hard: 3_600_000,
	review: 1_800_000,
	research: 900_000,
	grunt: 900_000,
};

/**
 * Timeout efectivo de un task: max(pedido, piso del rol). Sin pedido → default.
 * En modo print sigue siendo EL timeout; en rpc es solo el CAP DURO (la
 * inactividad corta antes si el hijo se cuelga de verdad).
 */
export function effectiveTimeoutMs(
	role: Role,
	requested: number | undefined,
	floors: Partial<Record<Role, number>> = ROLE_TIMEOUT_FLOOR_MS,
): number {
	const floor = floors[role] ?? 0;
	return Math.max(requested ?? DEFAULT_TIMEOUT_MS, floor);
}

/**
 * Inactividad (solo rpc): si el hijo pasa este tiempo sin emitir NINGÚN
 * evento parseado, se lo da por colgado. Se chequea con un interval barato
 * (sin churn de timers por delta). Un tool call en vuelo exime del corte:
 * ese silencio lo cubre el cap duro, no la inactividad.
 */
export const INACTIVITY_TIMEOUT_MS = 600_000;

/** Knob operativo: PI_SUBAGENTS_INACTIVITY_MS (0 = deshabilitar; inválido → default). */
export function resolveInactivityMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.PI_SUBAGENTS_INACTIVITY_MS;
	if (raw !== undefined && raw !== "") {
		const n = Number(raw);
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return INACTIVITY_TIMEOUT_MS;
}

/**
 * Heartbeat de progreso hacia el padre (directiva David 2026-08-18: el usuario
 * debe ver en qué se trabaja cada ≤25s). Además mantiene vivo el stream ACP:
 * el engine Zeron parkea turnos tras ~30s de silencio (settle window).
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Throttle de updates inmediatos por cambio de actividad (ID01-461): si la
 * actividad de un task cambia y pasaron ≥ esto desde el último update emitido
 * para ese task, se emite YA (sin esperar al próximo heartbeat).
 */
export const ACTIVITY_THROTTLE_MS = 5_000;
/**
 * Ventana de gracia tras `agent_settled` antes de dar el task por terminado
 * (ID01-461). El hijo carga las extensiones globales: si el repo tiene
 * `.pi-verify.json`, verify-gate (ID01-454) reinyecta un turno de reparación.
 * Cerrar stdin en el primer settle mataría esa reparación a mitad (el
 * `shutdown()` del modo rpc hace `process.exit` sin esperar el turno en vuelo).
 *
 * La ventana solo cubre el time-to-first-token del turno reinyectado, no la
 * duración de los tests: pi awaitea los handlers de extensión ANTES de emitir
 * el evento al stream (`_emitAgentSettled`, core/agent-session.ts:604-610), así
 * que cuando el padre VE el settle, el gate ya corrió sus comandos y ya
 * reinyectó. 15s cubren TTFT lento (review@high, provider en cola) — el review
 * adversarial marcó que 3s se comían reparaciones reales. CUALQUIER evento del
 * stream cancela la ventana.
 *
 * Solo se activa si el cwd del task tiene `.pi-verify.json` — el mismo lookup
 * que hace verify-gate (`loadConfig(ctx.cwd)`), así que no hay desalineación.
 */
export const SETTLE_GRACE_MS = 15_000;
/**
 * Cap del buffer de línea JSONL del stream rpc (se descarta hasta el próximo \n).
 * Son CHARS de JS (UTF-16), no bytes: el consumo real puede ser mayor.
 */
export const RPC_LINE_CAP_CHARS = 1_048_576;
/** Espera entre el `abort` por stdin y el ladder de señales, en timeout rpc. */
export const RPC_ABORT_GRACE_MS = 1_500;
/** Throttle del recálculo de actividad desde los deltas de texto. */
export const ACTIVITY_RECALC_MS = 500;

/** Cap de la actividad rodante: una línea, sin newlines. */
export const ACTIVITY_CAP_CHARS = 80;

/**
 * Actividad rodante desde el texto acumulado del assistant: última línea no
 * vacía, capeada a ACTIVITY_CAP_CHARS con "…". Sin texto → undefined.
 */
export function activityFromText(text: string): string | undefined {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i].trim();
		if (l) return l.length > ACTIVITY_CAP_CHARS ? `${l.slice(0, ACTIVITY_CAP_CHARS - 1)}…` : l;
	}
	return undefined;
}

/** Texto plano de un `message_end` assistant (bloques content[].type==="text"). */
function textFromMessage(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) =>
			b && typeof b === "object" && (b as { type?: unknown }).type === "text"
				? String((b as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/** Motivo legible de un assistantMessageEvent type==="error" (modo rpc). */
function rpcErrorText(ame: Record<string, unknown>): string {
	const err = ame.error;
	if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
		return (err as { message: string }).message;
	}
	if (typeof ame.message === "string") return ame.message;
	return JSON.stringify(ame).slice(0, 200);
}

/**
 * Resuelve provider/model/thinking para un task. `modelOverride` se splitea en
 * el PRIMER "/" → provider/model (el model puede contener slashes, p.ej.
 * "deepseek-payg/deepseek/deepseek-v4-pro"). Role default: grunt.
 */
export function resolveRoute(
	role: Role = "grunt",
	modelOverride?: string,
	thinkingOverride?: string,
): Route {
	const base = ROUTES[role];
	if (!base) throw new Error(`subagents: rol desconocido "${role}"`);
	const route: Route = { provider: base.provider, model: base.model, thinking: base.thinking };
	if (modelOverride !== undefined) {
		const i = modelOverride.indexOf("/");
		if (i <= 0 || i === modelOverride.length - 1) {
			throw new Error(`subagents: model override inválido "${modelOverride}" (esperado "provider/model")`);
		}
		route.provider = modelOverride.slice(0, i);
		route.model = modelOverride.slice(i + 1);
	}
	if (thinkingOverride !== undefined) route.thinking = thinkingOverride;
	return route;
}

/** Un subagente (PI_SUBAGENT_DEPTH>=1) no puede spawnear subagentes. */
export function canSpawn(env: NodeJS.ProcessEnv = process.env): boolean {
	const depth = Number(env.PI_SUBAGENT_DEPTH);
	return !(depth >= 1); // Number("abc")=NaN → NaN>=1 es false → puede
}

/**
 * Regla dura §7: si el batch mezcla review + implement, los MODELOS RESUELTOS
 * de revisor e implementador deben diferir (revisor ≠ implementador).
 */
export function assertReviewerDistinct(items: Array<{ role: Role; route: Route }>): void {
	const reviewers = items.filter((t) => t.role === "review");
	const implementers = items.filter((t) => t.role === "implement");
	if (reviewers.length === 0 || implementers.length === 0) return;
	const reviewModels = new Set(reviewers.map((t) => modelKey(t.route)));
	for (const t of implementers) {
		if (reviewModels.has(modelKey(t.route))) {
			throw new Error(
				`subagents: revisor e implementador resuelven al mismo modelo (${modelKey(t.route)}); el revisor debe diferir del implementador`,
			);
		}
	}
}

/** Recorta el output a los últimos `capBytes` bytes (tail), con marcador. */
export function trimTail(text: string, capBytes: number = OUTPUT_CAP_BYTES): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= capBytes) return text;
	let start = buf.length - capBytes;
	// No partir un codepoint multibyte por la mitad
	while (start > 0 && start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
	return `[…${start} bytes recortados del inicio]\n${buf.subarray(start).toString("utf8")}`;
}

/**
 * Entrega de subagent-result (ID01-433, REVISADA 2026-08-19 tras incidente):
 * agente vivo → "steer" (entra antes de la próxima llamada al LLM);
 * idle → { triggerTurn: true }: el resultado despierta el turno y el
 * orquestador lo reporta al usuario.
 *
 * La política v1 ("jamás triggerTurn"; idle → nextTurn) creó un agujero
 * negro: nextTurn queda encolado hasta el PRÓXIMO prompt del usuario — que
 * puede no llegar nunca — y el reaper de sesiones idle del engine mata pi
 * (~30 min) con el store background en memoria. Resultado real: batch
 * completado, cero evidencia en el chat (smoke test 2026-08-19). Un turno
 * disparado por completions es exactamente lo que la doctrina de reportes
 * ≤25s espera. Sin loop de mecanismo: pi flipea isStreaming SINCRÓNICO al
 * arrancar el turno, así que N completions idle coalescen en 1 turno +
 * N-1 steers (verificado contra agent-session.js por el review k3), y la
 * entrega no emite `input` ni re-lanza nada por sí misma.
 */
export function chooseDeliverOpts(agentLive: boolean): { deliverAs?: "steer"; triggerTurn?: boolean } {
	return agentLive ? { deliverAs: "steer" } : { triggerTurn: true };
}

// ---------- ID01-434: usage/costo + presupuesto ----------

export interface TaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	/** Solo si algún entry trajo cost.total; si NINGUNO, se OMITE (no 0 mintiendo). */
	costUsd?: number;
	/** Solo fallback (sin jsonl/usage): chars del output. */
	chars?: number;
}

interface UsageRaw {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cost?: { total?: unknown } | undefined;
}

/** Suma usages; `costUsd` solo si ALGUNA part lo trae. `chars` no se propaga. */
export function sumUsage(parts: TaskUsage[]): TaskUsage {
	const total: TaskUsage = { input: 0, output: 0, cacheRead: 0 };
	let cost = 0;
	let hasCost = false;
	for (const p of parts) {
		// defensivo: parts parciales (p.ej. fallback solo chars) no generan NaN
		total.input += num(p.input);
		total.output += num(p.output);
		total.cacheRead += num(p.cacheRead);
		if (typeof p.costUsd === "number") {
			hasCost = true;
			cost += p.costUsd;
		}
	}
	if (hasCost) total.costUsd = cost;
	return total;
}

const num = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

function usageFromRaw(raw: UsageRaw | undefined | null): TaskUsage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const u: TaskUsage = { input: num(raw.input), output: num(raw.output), cacheRead: num(raw.cacheRead) };
	if (raw.cost && typeof raw.cost.total === "number") u.costUsd = raw.cost.total;
	return u;
}

/**
 * Suma el usage de un session jsonl de pi (docs/session-format.md):
 * message.role assistant|toolResult → message.usage; type compaction → usage.
 * Líneas ilegibles se ignoran. Sin entries con usage → {0,0,0} sin costUsd.
 */
export function usageFromSessionJsonl(text: string): TaskUsage {
	const parts: TaskUsage[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue; // línea trunca/ruidosa
		}
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: unknown; message?: { role?: unknown; usage?: UsageRaw } };
		if (e.message?.role === "assistant" || e.message?.role === "toolResult") {
			const u = usageFromRaw(e.message.usage);
			if (u) parts.push(u);
		} else if (e.type === "compaction") {
			const u = usageFromRaw((e as { usage?: UsageRaw }).usage);
			if (u) parts.push(u);
		}
	}
	return sumUsage(parts);
}

/**
 * Default readSessionUsage: walk del dir de sesión buscando *.jsonl
 * (pi guarda sessionDir/--<cwd>--/*.jsonl). Dir ilegible/inexistente o jsonl
 * sin usage → undefined (el caller aplica el fallback chars).
 */
function readSessionUsageFromDir(dir: string): TaskUsage | undefined {
	const texts: string[] = [];
	const walk = (d: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && e.name.endsWith(".jsonl")) {
				try {
					texts.push(fs.readFileSync(p, "utf8"));
				} catch {
					/* ilegible → ignorar */
				}
			}
		}
	};
	walk(dir);
	const parts = texts.flatMap((t) => {
		const u = usageFromSessionJsonl(t);
		// {0,0,0} sin costUsd = archivo sin usage real → no cuenta
		return u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.costUsd === undefined ? [] : [u];
	});
	if (parts.length === 0) return undefined;
	return sumUsage(parts);
}

/** Ids de task van a path.join(transcriptRoot, childSessionId). Rechazar traversal. */
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;
export function assertSafeTaskId(id: string): void {
	if (!TASK_ID_RE.test(id) || id === "." || id === "..") {
		throw new Error(`subagents: id "${id}" inválido (solo [A-Za-z0-9._-]+)`);
	}
}

// ---------- ID01-482: viz en la app (líneas machine-readable) ----------

/**
 * Root default de los sessionDir de los hijos (JSONL pi v3 que el engine
 * tailea). Override: `PI_SUBAGENTS_TRANSCRIPT_ROOT` / `deps.sessionRoot`
 * (deps gana). Antes vivían en `os.tmpdir()/pi-subagents` y se borraban al
 * finish; ahora quedan ≥SESSION_DIR_RM_DELAY_MS para el drain del engine.
 */
export const DEFAULT_TRANSCRIPT_ROOT = path.join(os.homedir(), ".pi", "agent", "subagent-transcripts");

/**
 * Delay del rm del sessionDir post-finish: cubre el drain del observer Pi
 * del engine (6 polls × 200ms) + margen. El rm SIEMPRE se agenda (también
 * en fallo/timeout/kill); si falla es fail-soft.
 */
export const SESSION_DIR_RM_DELAY_MS = 2_500;

/** transcriptRoot efectivo: deps.sessionRoot > env > default. */
export function resolveTranscriptRoot(
	deps: Pick<RuntimeDeps, "sessionRoot">,
	env: NodeJS.ProcessEnv,
): string {
	if (deps.sessionRoot) return deps.sessionRoot;
	const envRoot = env.PI_SUBAGENTS_TRANSCRIPT_ROOT;
	if (envRoot !== undefined && envRoot.trim() !== "") return envRoot;
	return DEFAULT_TRANSCRIPT_ROOT;
}

/**
 * child_session_id del hijo (ID01-482): `{id}-{batchKey}` — único por
 * proceso+batch; el engine no conoce batchKey y clavea por esto.
 */
export function childSessionIdFor(taskId: string, batchKey: string): string {
	return `${taskId}-${batchKey}`;
}

/** Status machine del finish: mapea exitCode/skip a completed|failed|interrupted|error. */
export type SubagentFinishStatus = "completed" | "failed" | "interrupted" | "error";

export function finishStatusFor(r: Pick<SubagentResult, "exitCode" | "skipped">): SubagentFinishStatus {
	if (r.skipped === "budget") return "interrupted"; // 125: no despachado
	if (r.exitCode === 0) return "completed";
	if (r.exitCode === TIMEOUT_EXIT_CODE) return "interrupted"; // 124: timeout
	if (r.exitCode === -1) return "error"; // spawn error
	return "failed";
}

/** `subagent_spawned: <id> role: <role> model: <model> child_session_id: <csid>` (parseable con strip_prefix, valores single-token). */
export function formatSpawnedLine(id: string, role: Role, model: string, childSessionId: string): string {
	return `subagent_spawned: ${id} role: ${role} model: ${model} child_session_id: ${childSessionId}`;
}

/** `subagent_finished: <id> status: completed|failed|interrupted|error` */
export function formatFinishedLine(id: string, status: SubagentFinishStatus): string {
	return `subagent_finished: ${id} status: ${status}`;
}

/** Tope de costo del batch: ausente / "" / NaN / <0 → undefined (sin tope). */
export function parseMaxCostUsd(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env.PI_SUBAGENTS_MAX_COST_USD;
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n;
}

/**
 * Línea-resumen del batch (SPEC-subagents-3):
 * "4 tasks · 12.3s wall · 30.1s cpu · ~$0.31 total" · [" · incluye PAYG"] · [" · N skipped (presupuesto)"]
 */
export function formatBatchSummary(opts: {
	n: number;
	wallMs: number;
	sumMs: number;
	costUsd?: number;
	payg: boolean;
	skipped?: number;
}): string {
	let s = `${opts.n} tasks · ${(opts.wallMs / 1000).toFixed(1)}s wall · ${(opts.sumMs / 1000).toFixed(1)}s cpu`;
	s += opts.costUsd !== undefined ? ` · ~$${opts.costUsd.toFixed(2)} total` : " · cost n/d";
	if (opts.payg) s += " · incluye PAYG";
	if (opts.skipped !== undefined && opts.skipped > 0) s += ` · ${opts.skipped} skipped (presupuesto)`;
	return s;
}

/** PAYG del batch: algún task con role "hard" o provider resuelto deepseek-payg. */
export function batchPayg(tasks: SubagentTask[]): boolean {
	return tasks.some((t) => {
		if (t.role === "hard") return true;
		try {
			return resolveRoute(t.role ?? "grunt", t.model, t.thinking).provider === "deepseek-payg";
		} catch {
			return false; // input inválido: resolveTasks ya lo rechazó antes de llegar acá
		}
	});
}

/** `~$0.01` si hay costUsd; `cost n/d` si no (nunca un 0 mintiendo). */
export function usageCostBit(usage?: TaskUsage): string {
	return typeof usage?.costUsd === "number" ? `~$${usage.costUsd.toFixed(2)}` : "cost n/d";
}

/** Formato congelado del mensaje subagent-result (SPEC-subagents-2/3). */
export function formatSubagentResult(result: SubagentResult): string {
	const secs = (result.durationMs / 1000).toFixed(1);
	return `[subagent ${result.id} · ${result.role} · ${result.model} · ${secs}s · exit ${result.exitCode} · ${usageCostBit(result.usage)}]\n${result.output}`;
}

export interface SubagentTask {
	id?: string;
	role?: Role;
	prompt: string;
	cwd?: string;
	/** Override "provider/model" — split en el primer "/" */
	model?: string;
	thinking?: ThinkingLevel;
	timeoutMs?: number;
}

export interface SubagentResult {
	id: string;
	role: Role;
	model: string;
	exitCode: number;
	durationMs: number;
	output: string;
	usage: TaskUsage;
	/** Task NO despachado por presupuesto: exitCode 125, durationMs 0 (ID01-434). */
	skipped?: "budget";
}

export interface DispatchedTask {
	id: string;
	role: Role;
	model: string;
}

export interface RunningEntry {
	id: string;
	role: Role;
	model: string;
	startedAt: number;
	killed: boolean;
	/** Identidad del batch: el sweep de un dispatch no puede clavar un id reusado. */
	batch: object;
	/** false = en cola (cap 4); true = ya se llamó spawn. */
	spawned: boolean;
}

export type CompletedState = "done" | "error" | "killed" | "skipped";

export interface CompletedEntry {
	id: string;
	role: Role;
	model: string;
	state: CompletedState;
	elapsed: number;
	exitCode: number;
	finishedAt: number;
	usage?: TaskUsage;
	/** true si el task era role hard / provider deepseek-payg. */
	payg?: boolean;
}

/** Ring de los últimos N completados (SPEC-subagents-2: 20). */
export const COMPLETED_RING_MAX = 20;

export type SpawnFn = typeof spawn;

export interface RuntimeDeps {
	spawnFn?: SpawnFn;
	now?: () => number;
	concurrency?: number;
	killGraceMs?: number;
	piBin?: string;
	cwdDefault?: string;
	env?: NodeJS.ProcessEnv;
	/** ID01-434: raíz de sesiones de los hijos; ID01-482: override del transcriptRoot. */
	sessionRoot?: string;
	/** ID01-482: delay del rm del sessionDir post-finish (default 2.5s). */
	sessionRmDelayMs?: number;
	/** Lee usage del dir de sesión del hijo; undefined → fallback chars. */
	readSessionUsage?: (dir: string) => TaskUsage | undefined;
	/** Borra el dir de sesión (corre SIEMPRE: exit/timeout/kill/error). */
	rmSessionDir?: (dir: string) => void;
	/** Crea el dir de sesión antes del spawn. */
	mkdirSessionDir?: (dir: string) => void;
	/** Pisos de timeout por rol; {} deshabilita el clamp (tests). */
	timeoutFloorsMs?: Partial<Record<Role, number>>;
	/** Intervalo del heartbeat de progreso; 0 lo deshabilita. */
	heartbeatMs?: number;
	/** ID01-461: modo del hijo; default rpc. Gana sobre PI_SUBAGENTS_CHILD_MODE. */
	childMode?: ChildMode;
	/** Throttle de updates inmediatos por cambio de actividad (ID01-461). */
	activityThrottleMs?: number;
	/** Inactividad rpc: ms sin eventos del hijo antes de darlo por colgado. */
	inactivityMs?: number;
	/** Gracia post-settle antes de cerrar el task rpc (0 = cerrar al primer settle). */
	settleGraceMs?: number;
	/**
	 * ¿El cwd del task puede reinyectar turnos post-settle? Default: existe
	 * `.pi-verify.json` (verify-gate, ID01-454). Si es false, el cierre es
	 * inmediato — sin impuesto de latencia en el caso común.
	 */
	settleGraceProbe?: (cwd: string) => boolean;
}

export type ChildMode = "print" | "rpc";

/**
 * Modo del hijo (ID01-461): default "rpc" (streaming real). deps.childMode gana
 * sobre el env; el env solo reconoce "print" (fallback de emergencia a `-p`).
 */
export function resolveChildMode(deps: Pick<RuntimeDeps, "childMode">, env: NodeJS.ProcessEnv): ChildMode {
	if (deps.childMode) return deps.childMode;
	return env.PI_SUBAGENTS_CHILD_MODE === "print" ? "print" : "rpc";
}

interface ResolvedTask {
	id: string;
	role: Role;
	route: Route;
	prompt: string;
	cwd?: string;
	timeoutMs?: number;
}

const defaultPiBin = (): string => path.join(os.homedir(), ".npm-global", "bin", "pi");

/**
 * Runtime testeable: spawn/now/relojes inyectables. Un fallo de UN task no
 * tumba el batch (cada task resolve con su propio exitCode/output).
 */
export function createSubagentsRuntime(deps: RuntimeDeps = {}) {
	const spawnFn: SpawnFn = deps.spawnFn ?? spawn;
	const now: () => number = deps.now ?? Date.now;
	const timeoutFloorsMs: Partial<Record<Role, number>> = deps.timeoutFloorsMs ?? ROLE_TIMEOUT_FLOOR_MS;
	const heartbeatMs: number = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
	const childMode: ChildMode = resolveChildMode(deps, deps.env ?? process.env);
	const activityThrottleMs: number = deps.activityThrottleMs ?? ACTIVITY_THROTTLE_MS;
	const settleGraceMs: number = deps.settleGraceMs ?? SETTLE_GRACE_MS;
	const inactivityMs: number = deps.inactivityMs ?? resolveInactivityMs(deps.env ?? process.env);
	const settleGraceProbe: (cwd: string) => boolean =
		deps.settleGraceProbe ??
		((cwd) => {
			try {
				return fs.existsSync(path.join(cwd, ".pi-verify.json"));
			} catch {
				return false;
			}
		});
	const concurrency: number = deps.concurrency ?? MAX_CONCURRENCY;
	const killGraceMs: number = deps.killGraceMs ?? KILL_GRACE_MS;
	const piBin: string = deps.piBin ?? defaultPiBin();
	const baseEnv: NodeJS.ProcessEnv = deps.env ?? process.env;
	// ID01-482: los sessionDir de los hijos viven bajo transcriptRoot (default
	// ~/.pi/agent/subagent-transcripts) con nombre {id}-{batchKey} — el engine
	// tailea el JSONL pi de ahí para la viz. deps.sessionRoot pisa TODO.
	const transcriptRoot: string = resolveTranscriptRoot(deps, baseEnv);
	const sessionRmDelayMs: number = deps.sessionRmDelayMs ?? SESSION_DIR_RM_DELAY_MS;
	const readSessionUsage: (dir: string) => TaskUsage | undefined =
		deps.readSessionUsage ?? readSessionUsageFromDir;
	const rmSessionDir: (dir: string) => void = deps.rmSessionDir ?? ((d) => fs.rmSync(d, { recursive: true, force: true }));
	const mkdirSessionDir: (dir: string) => void = deps.mkdirSessionDir ?? ((d) => fs.mkdirSync(d, { recursive: true }));
	// batchKey: pid + now + counter — dos procesos pi no pueden colisionar el mismo dir.
	let batchCounter = 0;
	const nextBatchKey = (): string => `${process.pid}-${now()}-${++batchCounter}`;
	// ID01-482: el rm del sessionDir se difiere ≥sessionRmDelayMs post-finish
	// (el engine drena el JSONL 6×200ms tras subagent_finished). Fail-soft.
	// Cada task agenda el suyo en finish() — todos los caminos (éxito, timeout,
	// kill, error) pasan por ahí, así que no hace falta sweep por batch.
	const scheduleSessionRm = (dir: string): void => {
		const t = setTimeout(() => {
			try {
				rmSessionDir(dir);
			} catch {
				/* ya borrado / fail-soft */
			}
		}, sessionRmDelayMs);
		t.unref?.(); // no retener el event loop por un rm diferido
	};
	const live = new Set<ChildProcess>();
	const pendingKills = new Set<ReturnType<typeof setTimeout>>();
	// Store por runtime — en la extensión hay UN runtime por proceso pi, así que
	// sobrevive a cada llamada/dispatch (no por batch). NO sobrevive restart.
	const running = new Map<string, RunningEntry>();
	const completed: CompletedEntry[] = [];
	// killAll incrementa: los workers de un batch viejo dejan de spawnar.
	// Un batch NUEVO captura el epoch actual → no es sticky.
	let killEpoch = 0;

	const pushCompleted = (entry: CompletedEntry): void => {
		completed.push(entry);
		while (completed.length > COMPLETED_RING_MAX) completed.shift();
	};

	const resultPayg = (r: SubagentResult): boolean =>
		r.role === "hard" || r.model.split("/")[0] === "deepseek-payg";

	/** Result de task NO despachado por presupuesto (los vivos terminan). */
	const budgetSkipResult = (task: ResolvedTask, max: number, accumulated: number): SubagentResult => ({
		id: task.id,
		role: task.role,
		model: modelKey(task.route),
		exitCode: BUDGET_SKIP_EXIT_CODE,
		durationMs: 0,
		output: `subagents: no despachado — presupuesto PI_SUBAGENTS_MAX_COST_USD excedido (acumulado $${accumulated.toFixed(2)} >= $${max.toFixed(2)})`,
		usage: { input: 0, output: 0, cacheRead: 0 },
		skipped: "budget",
	});

	/** onUpdate por task: incluye el costo si el usage lo trae. */
	const progressLine = (r: SubagentResult, total: number): string => {
		const cost = typeof r.usage?.costUsd === "number" ? `$${r.usage.costUsd.toFixed(2)}` : "cost n/d";
		return `subagents: ${r.id}/${total} done · exit ${r.exitCode} · ${(r.durationMs / 1000).toFixed(1)}s · ${cost} · ${r.model}`;
	};

	function killAll(): void {
		killEpoch++;
		for (const entry of running.values()) entry.killed = true;
		for (const child of [...live]) {
			try {
				child.kill("SIGTERM");
			} catch {
				/* ya muerto */
			}
			const t = setTimeout(() => {
				pendingKills.delete(t);
				try {
					child.kill("SIGKILL");
				} catch {
					/* ya muerto */
				}
			}, killGraceMs);
			t.unref?.(); // no retener el event loop si el hijo ya murió por SIGTERM
			pendingKills.add(t);
		}
	}

	async function runTask(
		task: ResolvedTask,
		batchKey: string,
		onActivity?: (activity: string) => void,
	): Promise<SubagentResult> {
		const startedAt = now();
		// ID01-434: hijo CON sesión en dir descartable → usage del jsonl;
		// stdout print-mode intacto. ID01-482: el dir es
		// {transcriptRoot}/{id}-{batchKey} y el rm se difiere (engine drain).
		const sessionDir = path.join(transcriptRoot, childSessionIdFor(task.id, batchKey));
		try {
			mkdirSessionDir(sessionDir);
		} catch {
			/* si falla, el hijo puede crearlo él mismo; seguimos */
		}
		let stdout = "";
		let stderr = "";
		return new Promise<SubagentResult>((resolve) => {
			let settled = false;
			let timedOut = false;
			// rpc: motivo del assistantMessageEvent error → exitCode 1 en agent_settled
			let rpcError: string | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			// Declarados ANTES de finish: finish los cancela (evita TDZ).
			let settleTimer: ReturnType<typeof setTimeout> | undefined;
			/**
			 * Timers de señales (reap de cierre y ladder de timeout) en un SET, no en
			 * slots únicos: los dos caminos pueden solaparse y una variable compartida
			 * dejaba un timer huérfano y, peor, hacía que el callback de uno borrara de
			 * `pendingKills` el handle del otro (leak permanente del set global).
			 */
			const localKills = new Set<ReturnType<typeof setTimeout>>();
			const scheduleKill = (delayMs: number): void => {
				const t = setTimeout(() => {
					localKills.delete(t);
					pendingKills.delete(t); // el handle propio, no una variable externa
					try {
						child.kill("SIGKILL");
					} catch {
						/* ya muerto */
					}
				}, delayMs);
				localKills.add(t);
				pendingKills.add(t);
			};
			const scheduleReap = (delayMs: number): void => {
				const t = setTimeout(() => {
					localKills.delete(t);
					try {
						child.kill("SIGTERM");
					} catch {
						/* ya muerto */
					}
					scheduleKill(killGraceMs);
				}, delayMs);
				localKills.add(t);
			};
			// rpc: cierre en curso (stdin cerrado, esperando el exit del hijo).
			let closing = false;
			// ¿El cierre ordenado arrancó ANTES del timeout? Solo entonces el stream
			// define el exitCode; si el timeout venció primero, manda 124. Sin esta
			// distinción, un task que settleó completo y se colgó en el shutdown se
			// reportaría 124 y el orquestador lo re-correría (caro en implement).
			let closedBeforeTimeout = false;
			// rpc: ¿llegó AL MENOS un evento JSON? Si no y el hijo falló, casi seguro
			// el pi instalado no soporta --mode rpc → hint accionable en el output.
			let sawRpcEvent = false;
			// Inactividad (ID01-484): un hijo que emite está vivo; solo el silencio
			// total mata. Marca de último evento + interval de chequeo barato.
			let lastEventAt = now();
			let inactivityFired = false;
			let inactivityCheck: ReturnType<typeof setInterval> | undefined;
			// Tool en vuelo (tool_execution_start sin cerrar): puede ser
			// legítimamente mudo (cargo build sin stream de output) — ese silencio
			// lo cubre el cap duro, no la inactividad (review k3 de ID01-484).
			let toolInFlight = false;
			// rpc: mensajes assistant ya cerrados + buffer de deltas del mensaje en
			// curso. El output final los concatena (un turno puede tener varios).
			const finalParts: string[] = [];
			let deltaBuf = "";
			let lastActivityCalcAt = 0;
			let child: ChildProcess;
			const finish = (exitCode: number, extraErr?: string) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (settleTimer) clearTimeout(settleTimer);
				if (inactivityCheck) clearInterval(inactivityCheck);
				for (const t of localKills) {
					clearTimeout(t);
					pendingKills.delete(t);
				}
				localKills.clear();
				live.delete(child);
				// Solo si hubo eventos: si no los hubo, `stdout` trae el crudo del hijo
				// (banner/ayuda), que es el único diagnóstico disponible.
				if (childMode === "rpc" && sawRpcEvent) {
					stdout = trimTail([...finalParts, deltaBuf].filter(Boolean).join("\n"));
				}
				const parts = [stdout];
				if (stderr) parts.push(`[stderr]\n${stderr}`);
				if (extraErr) parts.push(extraErr);
				// Último: `trimTail` recorta por la cabeza, y este aviso importa
				// justamente cuando el output es grande.
				if (rpcDropped > 0) {
					parts.push(`[subagents: ${rpcDropped} evento(s) rpc descartado(s) por superar ${RPC_LINE_CAP_CHARS} chars — el output puede estar incompleto]`);
				}
				const output = trimTail(parts.filter(Boolean).join("\n"));
				// finally (exit/timeout/kill/error): usage del jsonl o fallback chars;
				// el rm se difiere ≥2.5s (ID01-482: el engine tailea/drena el JSONL).
				let usage: TaskUsage;
				try {
					usage = readSessionUsage(sessionDir) ?? { input: 0, output: 0, cacheRead: 0, chars: output.length };
				} catch {
					usage = { input: 0, output: 0, cacheRead: 0, chars: output.length };
				}
				scheduleSessionRm(sessionDir);
				resolve({
					id: task.id,
					role: task.role,
					model: modelKey(task.route),
					exitCode,
					durationMs: Math.max(0, now() - startedAt),
					output,
					usage,
				});
			};
			const isRpc = childMode === "rpc";
			// Gracia solo si el cwd puede reinyectar (verify-gate); si no, cierre
			// inmediato al settle — sin latencia extra en el caso común.
			const taskCwd = task.cwd ?? deps.cwdDefault ?? process.cwd();
			const graceMs = settleGraceProbe(taskCwd) ? settleGraceMs : 0;
			// Actividad rodante (ID01-461): se reporta al batch solo si cambia.
			let lastActivity: string | undefined;
			const setActivity = (a: string | undefined): void => {
				if (!a || a === lastActivity || !onActivity) return;
				lastActivity = a;
				try {
					onActivity(a);
				} catch {
					/* un update no debe tumbar el task */
				}
			};
			/**
			 * Parser JSONL tolerante (ID01-461): una línea por evento; las líneas
			 * no-JSON (warnings de pi) se skipean. Un chunk de stdout puede partir
			 * una línea por la mitad → buffer + split por "\n" (rpcBuf abajo).
			 */
			// Gracia post-settle: si el hijo arranca otro turno (verify-gate
			// reinyectando, retry de una extensión), se cancela el cierre.
			const closeRpcChild = (): void => {
				if (settled || closing) return;
				closing = true;
				closedBeforeTimeout = !timedOut;
				// stdin.end() PRIMERO y resolvemos en el 'exit': si resolviéramos acá,
				// un hijo que no sale (shutdown colgado, grandchild) quedaría huérfano
				// —fuera de `live`, sin timeout, invisible a killAll— y además el usage
				// se leería del jsonl sin flushear. NUNCA cerrar stdin antes del settle.
				try {
					child.stdin?.end();
				} catch {
					/* stdin ya cerrado */
				}
				// Reaper: si no sale por las suyas, TERM → +grace → KILL. El timeout
				// general del task sigue armado como última red.
				scheduleReap(killGraceMs);
			};
			const cancelPendingSettle = (): void => {
				if (settleTimer) {
					clearTimeout(settleTimer);
					settleTimer = undefined;
				}
			};
			const handleRpcLine = (line: string): void => {
				const trimmed = line.trim();
				if (!trimmed) return;
				let ev: Record<string, unknown>;
				try {
					ev = JSON.parse(trimmed);
				} catch {
					return; // warning / basura no-JSON
				}
				if (!ev || typeof ev !== "object") return;
				sawRpcEvent = true;
				lastEventAt = now();
				// CUALQUIER evento que no sea el settle es señal de trabajo vivo y
				// cancela un cierre en gracia (whitelist estrecha = cerrar a mitad de
				// una reparación de verify-gate y reportar exit 0 — hallazgo del review).
				if (ev.type !== "agent_settled") cancelPendingSettle();
				if (ev.type === "message_start" && (ev.message as { role?: unknown } | undefined)?.role === "assistant") {
					// El assistant volvió a streamear ⇒ la fase de tools terminó
					// (red de seguridad por si un pi no emite tool_execution_end).
					toolInFlight = false;
					// SOLO assistant: es el retry de pi tras un error transitorio (429),
					// que sin esto reportaría exit 1 con output bueno. Un message_start
					// de role user (reinyección de verify-gate) NO limpia el error: si el
					// turno falló de verdad, el fallo debe sobrevivir a la reparación.
					rpcError = undefined;
				}
				if (ev.type === "message_update") {
					const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined;
					if (!ame) return;
					if (ame.type === "text_delta" && typeof ame.delta === "string") {
						deltaBuf = trimTail(deltaBuf + ame.delta);
						// Actividad con throttle temporal: recalcularla por token es O(n)
						// por delta (split del buffer entero) × concurrencia.
						const t = now();
						if (t - lastActivityCalcAt >= ACTIVITY_RECALC_MS) {
							lastActivityCalcAt = t;
							setActivity(activityFromText(deltaBuf));
						}
					} else if (ame.type === "toolcall_end") {
						toolInFlight = false;
						const name = (ame.toolCall as { name?: unknown } | undefined)?.name;
						if (typeof name === "string") setActivity(`⚙ ${name}`);
					} else if (ame.type === "error") {
						rpcError = rpcErrorText(ame);
					}
					// thinking_delta y el resto (start/end/delta de toolcall, done):
					// no aportan al output ni a la actividad → ignorados
				} else if (ev.type === "message_end" && (ev.message as { role?: unknown } | undefined)?.role === "assistant") {
					// Mensaje assistant cerrado: es la versión autoritativa de ESE
					// mensaje. Se acumula (un turno puede tener varios, p.ej. tras una
					// reparación de verify-gate) y se limpia el buffer de deltas.
					const text = textFromMessage(ev.message);
					deltaBuf = "";
					if (text) {
						finalParts.push(text);
						// Cap continuo: una sesión agéntica larga acumula decenas de
						// mensajes assistant × N hijos en el padre si solo se recorta al
						// final. Se colapsa a la cola apenas supera el cap.
						const joined = finalParts.join("\n");
						if (joined.length > OUTPUT_CAP_BYTES) {
							finalParts.length = 0;
							finalParts.push(trimTail(joined));
						}
						setActivity(activityFromText(text));
					}
				} else if (ev.type === "tool_execution_start" && typeof ev.toolName === "string") {
					toolInFlight = true;
					setActivity(`⚙ ${ev.toolName}`);
				} else if (ev.type === "tool_execution_end") {
					toolInFlight = false;
				} else if (ev.type === "agent_settled") {
					toolInFlight = false;
					// Fin del turno (sin retry/compaction/continuación pendiente).
					// NO cerramos de una: una extensión del hijo (verify-gate) puede
					// reinyectar un turno de reparación justo después. Esperamos la
					// ventana de gracia; si llega actividad, se cancela el cierre.
					cancelPendingSettle();
					if (graceMs <= 0) {
						closeRpcChild();
					} else {
						// SIN unref: la gracia debe sostener el event loop; si el proceso
						// saliera antes, el task quedaría sin resolver.
						settleTimer = setTimeout(closeRpcChild, graceMs);
					}
				}
			};
			let rpcBuf = "";
			let rpcSkipLine = false; // descartando una línea que superó el cap
			let rpcDropped = 0; // cuántas líneas se descartaron (se reporta al final)
			child = spawnFn(
				piBin,
				isRpc
					? [
							"--mode",
							"rpc",
							"--provider",
							task.route.provider,
							"--model",
							task.route.model,
							"--thinking",
							task.route.thinking,
							"--session-dir",
							sessionDir,
						]
					: [
							"--provider",
							task.route.provider,
							"--model",
							task.route.model,
							"--thinking",
							task.route.thinking,
							"-p",
							"--session-dir",
							sessionDir,
							task.prompt,
						],
				{
					cwd: task.cwd ?? deps.cwdDefault ?? process.cwd(),
					env: { ...baseEnv, PI_SUBAGENT_DEPTH: "1" },
					// rpc: stdin ES el canal (pipe) — NO cerrarlo al arrancar
					stdio: isRpc ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
				},
			);
			live.add(child);
			if (isRpc) {
				// EPIPE se emite ASÍNCRONO: sin handler, un hijo que muere al arrancar
				// (flag inválido, auth, OOM) tumba al pi PADRE por uncaughtException.
				child.stdin?.on("error", () => {
					/* el hijo murió; el handler de exit/error resuelve el task */
				});
				// El prompt va por stdin: una línea JSON + "\n"
				try {
					child.stdin?.write(`${JSON.stringify({ type: "prompt", message: task.prompt })}\n`);
				} catch {
					/* stdin roto → el handler de exit/error resuelve */
				}
			}
			const fireTimeout = (): void => {
				if (settled || timedOut) return;
				timedOut = true;
				if (isRpc) {
					// abort amable por el canal y recién después el ladder de señales:
					// en el mismo tick el abort no llega a procesarse.
					try {
						child.stdin?.write('{"type":"abort"}\n');
					} catch {
						/* noop */
					}
					scheduleReap(RPC_ABORT_GRACE_MS);
				} else {
					try {
						child.kill("SIGTERM");
					} catch {
						/* noop */
					}
					scheduleKill(killGraceMs);
				}
			};
			// Cap duro (print: EL timeout; rpc: red final anti-runaway).
			timer = setTimeout(fireTimeout, effectiveTimeoutMs(task.role, task.timeoutMs, timeoutFloorsMs));
			if (isRpc && inactivityMs > 0) {
				// Asesino primario en rpc: silencio total del stream. Interval de
				// chequeo (≥3 muestras por ventana) en vez de resetear un timer por
				// delta — mismo resultado, sin churn.
				const checkEvery = Math.max(50, Math.min(30_000, Math.floor(inactivityMs / 3)));
				inactivityCheck = setInterval(() => {
					// closing/settleTimer: el silencio post-settle es ESPERADO (grace,
					// espera de exit) — sin este guard, inactivityMs < graceMs (config
					// de test) convertiría un settle exitoso en falso 124.
					if (settled || timedOut || closing || settleTimer) return;
					if (toolInFlight) return;
					if (now() - lastEventAt > inactivityMs) {
						inactivityFired = true;
						fireTimeout();
					}
				}, checkEvery);
				inactivityCheck.unref?.();
			}
			child.stdout?.on("data", (d: Buffer) => {
				if (!isRpc) {
					stdout = trimTail(stdout + d.toString("utf8"));
					return;
				}
				// Mientras no haya llegado NINGÚN evento, conservamos el stdout crudo:
				// si el pi instalado no soporta --mode rpc, es el único diagnóstico.
				if (!sawRpcEvent) stdout = trimTail(stdout + d.toString("utf8"));
				rpcBuf += d.toString("utf8");
				let idx: number;
				while ((idx = rpcBuf.indexOf("\n")) >= 0) {
					const line = rpcBuf.slice(0, idx);
					rpcBuf = rpcBuf.slice(idx + 1);
					if (rpcSkipLine) {
						// veníamos descartando una línea gigante: acá termina
						rpcSkipLine = false;
						continue;
					}
					handleRpcLine(line);
				}
				// Cap del buffer: una sola línea JSONL gigante (un evento que acarrea
				// el contenido de un archivo) se acumularía entera en el PADRE, ×N
				// hijos, y después se parsearía. Se descarta hasta el próximo "\n".
				if (rpcBuf.length > RPC_LINE_CAP_CHARS) {
					// Solo la transición cuenta: una línea de 5MB llega en varios chunks
					// y desbordaría el cap una vez por chunk (sobreconteo).
					if (!rpcSkipLine) rpcDropped++;
					rpcBuf = "";
					rpcSkipLine = true;
				}
			});
			child.stderr?.on("data", (d: Buffer) => {
				stderr = trimTail(stderr + d.toString("utf8"));
			});
			child.on("error", (err: Error) => finish(-1, `spawn error: ${err.message}`));
			child.on("exit", (code: number | null) => {
				// Flush del remanente sin "\n" final: un último evento quedaría afuera.
				if (isRpc && !rpcSkipLine && rpcBuf.trim()) {
					const rest = rpcBuf;
					rpcBuf = "";
					handleRpcLine(rest);
				}
				// El stream define el exitCode SOLO si el cierre ordenado arrancó antes
				// del timeout. Si el timeout vino primero (el hijo settleó por el
				// `abort`), manda 124: si no, un task que reventó el tiempo se
				// reportaría exitoso.
				if (closing && closedBeforeTimeout) {
					// Cierre ordenado post-settle: el exitCode lo define el STREAM
					// (el proceso puede salir 143 si hubo que TERMinarlo).
					finish(
						rpcError ? 1 : 0,
						rpcError ? `subagents: el hijo reportó error: ${rpcError}` : undefined,
					);
					return;
				}
				if (isRpc && !timedOut && !sawRpcEvent) {
					// Ni un solo evento JSON — incluso con exit 0 (banner/ayuda por
					// stdout): sin esto quedaría exit 0 con output vacío y sin pista.
					// El stdout crudo se conservó justamente para este caso.
					finish(
						code ?? -1,
						`subagents: el hijo terminó (exit ${code ?? -1}) sin emitir ningún evento rpc. Si el pi instalado no soporta "--mode rpc", corré con PI_SUBAGENTS_CHILD_MODE=print.`,
					);
					return;
				}
				if (timedOut) {
					const secs = Math.round(effectiveTimeoutMs(task.role, task.timeoutMs, timeoutFloorsMs) / 1000);
					// Dos causas distintas piden dos diagnósticos distintos (ID01-484):
					// silencio total = cuelgue probable; cap con actividad = runaway o
					// task genuinamente enorme.
					const rpcMsg = inactivityFired
						? `subagents: cortado por INACTIVIDAD — ${Math.round(inactivityMs / 1000)}s sin ningún evento del hijo (cuelgue probable). El output parcial se conserva arriba.`
						: `subagents: timeout tras ${secs}s (cap duro del rol) — si era trabajo legítimo, subí timeoutMs o partí la task en pasos más chicos. Output parcial arriba.`;
					finish(
						TIMEOUT_EXIT_CODE,
						isRpc
							? rpcMsg
							: `subagents: timeout tras ${secs}s — en modo -p el output se emite recién al final; la task probablemente seguía trabajando. Reintentá con timeoutMs mayor o partí la task en pasos más chicos.`,
					);
				} else {
					finish(code ?? -1);
				}
			});
		});
	}

	async function runBatch(
		tasks: SubagentTask[],
		opts?: {
			signal?: AbortSignal;
			onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void;
		},
	): Promise<SubagentResult[]> {
		const resolved = resolveTasks(tasks);
		const myEpoch = killEpoch;
		const batchKey = nextBatchKey();
		const maxCostUsd = parseMaxCostUsd(baseEnv);
		let accumulatedCost = 0; // Σ usage.costUsd de tasks YA terminados de ESTE batch

		let aborted = false;
		const onAbort = () => {
			aborted = true;
			killAll();
		};
		if (opts?.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort);
		}
		const results: Array<SubagentResult | undefined> = new Array(resolved.length);
		const queue = resolved.map((task, index) => ({ task, index }));
		// Heartbeat (directiva 2026-08-18): tasks vivas + elapsed cada ≤25s.
		// Mantiene vivo el stream ACP (el engine parkea a los ~30s de silencio)
		// y le muestra al usuario en qué se está trabajando.
		const inFlight = new Map<
			string,
			{ role: Role; model: string; startedAt: number; activity?: string; lastActivityEmitAt: number }
		>();
		// Hallazgo k3 (review 2026-08-18): onUpdate puede lanzar si el host está en
		// teardown — nunca debe tumbar el batch ni el interval.
		const emitUpdate = (text: string): void => {
			try {
				opts?.onUpdate?.({ content: [{ type: "text", text }] });
			} catch {
				/* host en teardown */
			}
		};
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		if (opts?.onUpdate && heartbeatMs > 0) {
			heartbeat = setInterval(() => {
				if (inFlight.size === 0) return;
				const live = [...inFlight.entries()]
					.map(
						([id, e]) =>
							// ID01-461: si hay actividad rodante (modo rpc), se muestra
							`${id} (${e.role}·${e.model}) ${Math.round((now() - e.startedAt) / 1000)}s${e.activity ? ` — ${e.activity}` : ""}`,
					)
					.join(" · ");
				const done = results.filter((r) => r !== undefined).length;
				emitUpdate(`subagents: ⏳ ${live} — ${done}/${resolved.length} done, ${queue.length} en cola`);
			}, heartbeatMs);
			heartbeat.unref?.();
		}
		const worker = async (): Promise<void> => {
			while (queue.length > 0 && !aborted) {
				if (killEpoch !== myEpoch) {
					aborted = true;
					break;
				}
				const next = queue.shift();
				if (!next) break;
				// Presupuesto (ID01-434): se chequea ANTES de spawnear el próximo de la
				// cola; los vivos terminan. Skip → result sintético exit 125 (sin
				// spawned line: nunca se registró en inFlight → el engine no mintea chip;
				// el finished interrupted es no-op ahí).
				if (maxCostUsd !== undefined && accumulatedCost >= maxCostUsd) {
					const r = budgetSkipResult(next.task, maxCostUsd, accumulatedCost);
					results[next.index] = r;
					emitUpdate(`${progressLine(r, resolved.length)}\n${formatFinishedLine(r.id, finishStatusFor(r))}`);
					continue;
				}
				inFlight.set(next.task.id, {
					role: next.task.role,
					model: modelKey(next.task.route),
					startedAt: now(),
					lastActivityEmitAt: 0,
				});
				// ID01-482: línea machine-readable ANTES del await — el observer Pi
				// del engine mintea el chip `Agent: {id} ({role})` y arranca el tail.
				emitUpdate(
					formatSpawnedLine(
						next.task.id,
						next.task.role,
						modelKey(next.task.route),
						childSessionIdFor(next.task.id, batchKey),
					),
				);
				let r: SubagentResult;
				try {
					r = await runTask(next.task, batchKey, (activity) => {
						const e = inFlight.get(next.task.id);
						if (!e || e.activity === activity) return;
						e.activity = activity;
						// ID01-461: update inmediato throttlado, sin esperar al heartbeat
						const t = now();
						if (t - e.lastActivityEmitAt >= activityThrottleMs) {
							e.lastActivityEmitAt = t;
							emitUpdate(`subagents: ⏳ ${next.task.id} (${e.role}·${e.model}) — ${activity}`);
						}
					});
				} finally {
					inFlight.delete(next.task.id);
				}
				if (typeof r.usage?.costUsd === "number") accumulatedCost += r.usage.costUsd;
				results[next.index] = r;
				// ID01-482: progressLine (humano) + finished line (machine) en el MISMO
				// update: el engine settlea el chip y usa el progressLine como output
				// fallback si nunca hubo transcript.
				emitUpdate(`${progressLine(r, resolved.length)}\n${formatFinishedLine(r.id, finishStatusFor(r))}`);
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, worker));
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			opts?.signal?.removeEventListener("abort", onAbort);
			// ID01-482: sin cleanupBatchDir — cada task ya agendó su delay-rm en
			// finish() (todos los caminos pasan por ahí).
		}
		if (aborted) throw new Error("subagents: batch abortado (signal/shutdown) — hijos killed");
		return results.map((r) => r as SubagentResult);
	}

	/** Val idaciones compartidas foreground/background (antes de spawnear). */
	function resolveTasks(tasks: SubagentTask[]): ResolvedTask[] {
		if (!canSpawn(baseEnv)) {
			throw new Error("subagents: PI_SUBAGENT_DEPTH >= 1 — un subagente no puede spawnear subagentes");
		}
		if (!Array.isArray(tasks) || tasks.length === 0) {
			throw new Error("subagents: pasá al menos un task en tasks[]");
		}
		const resolved: ResolvedTask[] = tasks.map((t, i) => {
			const role: Role = t.role ?? "grunt";
			return {
				id: t.id ?? `t${i + 1}`,
				role,
				route: resolveRoute(role, t.model, t.thinking),
				prompt: t.prompt,
				cwd: t.cwd,
				timeoutMs: t.timeoutMs,
			};
		});
		assertReviewerDistinct(resolved);
		const seen = new Set<string>();
		for (const t of resolved) {
			assertSafeTaskId(t.id);
			if (seen.has(t.id)) {
				throw new Error(`subagents: id "${t.id}" repetido en el batch`);
			}
			seen.add(t.id);
		}
		return resolved;
	}

	/**
	 * Background (ID01-433): registra en `running`, arranca el mismo queue/cap 4
	 * y retorna YA con los dispatched. Por cada task terminado: saca de running,
	 * push al ring de completados y `onComplete(result)` (1 call por task, en
	 * orden de completado). Un fallo/timeout NO tumba el resto. Ids colisionando
	 * con `running` (o duplicados en el mismo batch) → batch rechazado entero.
	 */
	async function dispatchBackground(
		tasks: SubagentTask[],
		opts?: { onComplete?: (result: SubagentResult) => void; signal?: AbortSignal },
	): Promise<DispatchedTask[]> {
		if (opts?.signal?.aborted) {
			throw new Error("subagents: signal abortado — no se despachó nada");
		}
		const resolved = resolveTasks(tasks);
		for (const t of resolved) {
			if (running.has(t.id)) {
				throw new Error(`subagents: id "${t.id}" ya está running — rechazado el batch entero`);
			}
		}
		const batch = {};
		const batchKey = nextBatchKey();
		const maxCostUsd = parseMaxCostUsd(baseEnv);
		let accumulatedCost = 0; // presupuesto: Σ usage.costUsd de ESTE batch
		for (const t of resolved) {
			running.set(t.id, {
				id: t.id,
				role: t.role,
				model: modelKey(t.route),
				startedAt: now(),
				killed: false,
				batch,
				spawned: false,
			});
		}
		const dispatched: DispatchedTask[] = resolved.map((t) => ({
			id: t.id,
			role: t.role,
			model: modelKey(t.route),
		}));

		let aborted = false;
		const onAbort = () => {
			aborted = true;
			killAll();
		};
		if (opts?.signal) {
			// aborted-al-entrar ya se rechazó arriba; acá solo abortos mid-flight
			opts.signal.addEventListener("abort", onAbort);
		}

		const finishTask = (r: SubagentResult, killed: boolean): void => {
			running.delete(r.id);
			const state: CompletedState = killed
				? "killed"
				: r.skipped === "budget"
					? "skipped"
					: r.exitCode === 0
						? "done"
						: "error";
			pushCompleted({
				id: r.id,
				role: r.role,
				model: r.model,
				state,
				elapsed: r.durationMs,
				exitCode: r.exitCode,
				finishedAt: now(),
				...(r.usage ? { usage: r.usage } : {}),
				payg: resultPayg(r),
			});
			// killed = sin result real → no onComplete (deliverResult no manda nada por él)
			if (!killed) {
				try {
					opts?.onComplete?.(r);
				} catch (err) {
					// deliverResult/pi.sendMessage puede lanzar (p.ej. sesión en teardown).
					// NO re-finalizar ni propagar: el catch del worker re-invocaría finishTask
					// → doble entrada en completed + doble sendMessage; y sin .catch la IIFE
					// crashearía el proceso pi con unhandledRejection.
					console.error(`subagents: onComplete falló para ${r.id}:`, err instanceof Error ? err.message : err);
				}
			}
		};

		const queue = [...resolved];
		const worker = async (): Promise<void> => {
			while (queue.length > 0 && !aborted) {
				const task = queue.shift();
				if (!task) break;
				const entry = running.get(task.id);
				if (!entry) continue;
				if (entry.killed) {
					// killAll() lo marcó ANTES de spawnear (shutdown/abort con el task en cola)
					running.delete(task.id);
					pushCompleted({
						id: task.id,
						role: task.role,
						model: entry.model,
						state: "killed",
						elapsed: Math.max(0, now() - entry.startedAt),
						exitCode: -1,
						finishedAt: now(),
					});
					continue;
				}
				// Presupuesto: ANTES de spawnear (nunca estuvo spawned → state
				// "skipped"); onComplete SÍ se manda (el orquestador se entera).
				if (maxCostUsd !== undefined && accumulatedCost >= maxCostUsd) {
					finishTask(budgetSkipResult(task, maxCostUsd, accumulatedCost), false);
					continue;
				}
				try {
					entry.spawned = true;
					const r = await runTask(task, batchKey);
					if (typeof r.usage?.costUsd === "number") accumulatedCost += r.usage.costUsd;
					// entry.killed pudo ponerse true durante el await (killAll)
					finishTask(r, entry.killed);
				} catch (err) {
					// runTask no debería rechazar, pero un fallo NO tumba el resto
					finishTask(
						{
							id: task.id,
							role: task.role,
							model: modelKey(task.route),
							exitCode: -1,
							durationMs: Math.max(0, now() - entry.startedAt),
							output: `subagents: spawn error: ${err instanceof Error ? err.message : String(err)}`,
							usage: { input: 0, output: 0, cacheRead: 0 },
						},
						entry.killed,
					);
				}
			}
		};

		// Fire-and-forget: el caller NUNCA espera a los hijos (cero polling).
		(async () => {
			try {
				await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, worker));
			} finally {
				opts?.signal?.removeEventListener("abort", onAbort);
				// Sweep de seguridad: tasks que quedaron en running sin finalizar
				// (workers cortados por abort antes de agotar la cola).
				for (const t of resolved) {
					const entry = running.get(t.id);
					if (!entry || entry.batch !== batch) continue;
					running.delete(t.id);
					pushCompleted({
						id: t.id,
						role: t.role,
						model: entry.model,
						state: "killed",
						elapsed: Math.max(0, now() - entry.startedAt),
						exitCode: -1,
						finishedAt: now(),
					});
				}
				// ID01-482: sin cleanupBatchDir — cada task ya agendó su delay-rm en
				// finish() (todos los caminos pasan por ahí).
			}
		})().catch(() => {
			// los workers ya tragan todo; esto evita unhandledRejection si algo escapa
		});
		return dispatched;
	}

	/**
	 * Snapshot sin bloquear: running + últimos completados (más reciente último)
	 * + totals (best-effort: el ring recorta a COMPLETED_RING_MAX=20).
	 */
	function status(): {
		running: Array<{ id: string; state: "queued" | "running"; elapsed: number; role: Role; model: string }>;
		completed: CompletedEntry[];
		totals: { costUsd?: number; sumMs: number; payg?: boolean };
	} {
		let costUsd = 0;
		let hasCost = false;
		let sumMs = 0;
		let payg = false;
		for (const c of completed) {
			sumMs += c.elapsed;
			if (typeof c.usage?.costUsd === "number") {
				hasCost = true;
				costUsd += c.usage.costUsd;
			}
			if (c.payg) payg = true;
		}
		return {
			running: [...running.values()].map((e) => ({
				id: e.id,
				state: (e.spawned ? "running" : "queued") as "queued" | "running",
				elapsed: Math.max(0, now() - e.startedAt),
				role: e.role,
				model: e.model,
			})),
			completed: completed.slice(),
			totals: {
				...(hasCost ? { costUsd } : {}),
				sumMs,
				...(payg ? { payg: true } : {}),
			},
		};
	}

	return { runBatch, dispatchBackground, status, killAll, now };
}

const RoleSchema = Type.Union([
	Type.Literal("research"),
	Type.Literal("implement"),
	Type.Literal("review"),
	Type.Literal("hard"),
	Type.Literal("grunt"),
]);
const ThinkingSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

/**
 * Apertura canónica de los prompts de utilería del engine (titulado de
 * chats). Cubre las dos variantes de crates/engine (titles.rs arma
 * "{TITLE_PROMPT_PREFIX} 3-5 word title in Title Case…"; pi_adopt.rs usa la
 * frase equivalente) — si cambian allá, cambia acá. Solo el PRIMER input de
 * la sesión puede activar el gate (las corridas de utilería son de un solo
 * prompt): un usuario legítimo que empiece un mensaje posterior igual no
 * envenena nada (hallazgo bloqueante del review k3). Incidente 2026-08-19:
 * las sesiones de titulado ejecutaron la tarea embebida y lanzaron sus
 * propios batches (2 veces). Follow-up estructural: marcador explícito del
 * engine en vez de sniffing de texto.
 */
export const UTILITY_PROMPT_PREFIX = "Reply with ONLY a concise 3-5 word title";

/** Wiring testeable: inyectá runtime (spawn/now) y un `pi` mock. */
export function installSubagents(pi: ExtensionAPI, runtime = createSubagentsRuntime()): void {
	let agentLive = false; // agent_start → true, agent_settled → false (no agent_end: hay retries/compaction)
	let shutdown = false;
	let utilityRun = false; // sesión de utilería del engine (titulado): tools deshabilitadas
	let firstInputSeen = false; // el gate solo evalúa el PRIMER input (utilería = un prompt)

	pi.on("agent_start", () => {
		agentLive = true;
	});
	pi.on("agent_settled", () => {
		agentLive = false;
	});
	pi.on("input", (ev: { text?: string }) => {
		if (firstInputSeen) return;
		firstInputSeen = true;
		if (typeof ev?.text === "string" && ev.text.startsWith(UTILITY_PROMPT_PREFIX)) utilityRun = true;
	});

	/** Entrega un resultado como subagent-result (1 sendMessage por task, sin concatenar). */
	const deliverResult = (result: SubagentResult): void => {
		if (shutdown) return; // tras session_shutdown no mandamos sendMessage
		pi.sendMessage(
			{ customType: "subagent-result", content: formatSubagentResult(result), display: true, details: result },
			chooseDeliverOpts(agentLive),
		);
	};

	pi.registerTool({
		name: "subagents",
		label: "Subagents",
		description:
			"Despacha N subagentes pi en paralelo (foreground: espera a todos y devuelve resultados). " +
			"Roles: research/grunt→qwen3.8-max low · implement→glm-5.3 medium · review→k3 high · hard→deepseek-v4-pro medium. " +
			"background:true retorna YA con dispatched y los resultados llegan solos como mensajes subagent-result " +
			"(consultá subagents_status). " +
			"Usala para subtareas INDEPENDIENTES en paralelo; dependientes van secuencial. " +
			"Foreground devuelve {results:[{id, role, model, exitCode, durationMs, output, usage:{input,output,cacheRead,costUsd?}}], summary, payg}.",
		promptSnippet: "Despachar subagentes pi paralelos por rol (research/implement/review/hard/grunt)",
		promptGuidelines: [
			"Usá subagents para subtareas independientes en paralelo en lugar de múltiples bash con `pi … &`; los prompts deben ser auto-contenidos y deterministas.",
			"DEFAULT foreground: bloquea, streamea el progreso al usuario y devuelve los resultados en el mismo turno. Si el usuario pide 'lanzá X y reportame', eso es foreground.",
			"background:true SOLO si vas a seguir trabajando en OTRA cosa mientras corren (los resultados llegan como subagent-result y despiertan el turno). No esperes con sleeps; subagents_status da el estado.",
		],
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					id: Type.Optional(Type.String({ description: "identificador corto; default t1, t2…" })),
					role: Type.Optional(RoleSchema),
					prompt: Type.String({ description: "Prompt auto-contenido (el subagente no puede repreguntar)" }),
					cwd: Type.Optional(Type.String({ description: "directorio de trabajo; default cwd actual" })),
					model: Type.Optional(Type.String({ description: 'override "provider/model", split en el primer "/"' })),
					thinking: Type.Optional(ThinkingSchema),
					timeoutMs: Type.Optional(Type.Number({ description: "CAP duro por task (no timeout de ejecución): un hijo colgado cae antes por inactividad (600s sin eventos). Clampeado al piso del rol (implement/hard 60min, review 30min, research/grunt 15min). Default: el piso del rol." })),
				}),
				{ minItems: 1 },
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"SOLO si vas a seguir con otra cosa mientras corren: retorna YA con {dispatched, note} y los resultados llegan como subagent-result. Para 'lanzá y reportame' usá el default (false: foreground, bloquea y devuelve resultados)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (utilityRun) {
				// Sesión de utilería del engine (titulado): el prompt embebe la tarea
				// del usuario y el modelo barato intenta ejecutarla (incidente
				// 2026-08-19, dos batches fantasma). Acá no se spawnea nada.
				return {
					content: [
						{
							type: "text",
							text: "subagents: deshabilitados en sesiones de utilería (titulado). Respondé SOLO lo pedido por el prompt de utilería.",
						},
					],
				};
			}
			if (params.background) {
				const dispatched = await runtime.dispatchBackground(params.tasks, {
					signal,
					onComplete: deliverResult,
				});
				const payg = batchPayg(params.tasks);
				const payload = {
					dispatched,
					note: payg
					? "los resultados llegan como subagent-result · incluye PAYG"
					: "los resultados llegan como subagent-result",
				};
				return { content: [{ type: "text", text: JSON.stringify(payload) }], details: { dispatched, payg } };
			}
			const t0 = runtime.now();
			const results = await runtime.runBatch(params.tasks, { signal, onUpdate });
			// Envelope (SPEC-subagents-3): runBatch sigue devolviendo SubagentResult[];
				// el wrapper arma {results, summary, payg}. costUsd solo si ALGÚN task lo trae.
			const withCost = results.filter((r) => typeof r.usage?.costUsd === "number");
			const costUsd =
				withCost.length > 0 ? withCost.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0) : undefined;
			const payg = batchPayg(params.tasks);
			const envelope = {
				results,
				summary: formatBatchSummary({
					n: results.length,
					wallMs: runtime.now() - t0,
					sumMs: results.reduce((s, r) => s + r.durationMs, 0),
					costUsd,
					payg,
					skipped: results.filter((r) => r.skipped === "budget").length,
				}),
				payg,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(envelope) }],
				details: envelope,
			};
		},
	});

	pi.registerTool({
		name: "subagents_status",
		label: "Subagents status",
		description: "Lista subagentes background running + últimos completados (+totals de costo/tiempo del ring, best-effort). No bloquea.",
		promptSnippet: "Estado de subagentes background (running + completados)",
		parameters: Type.Object({}),
		async execute() {
			const s = runtime.status();
			return { content: [{ type: "text", text: JSON.stringify(s) }], details: s };
		},
	});

	pi.on("session_shutdown", async () => {
		shutdown = true; // corta deliverResult ANTES de matar
		runtime.killAll(); // foreground + background; los running pasan a completed con state "killed"
	});
}

export default function (pi: ExtensionAPI): void {
	installSubagents(pi);
}
