/**
 * subagents — tool foreground de subagentes pi (ID01-432, SPEC-subagents-1).
 *
 * Despacha N hijos `pi` en paralelo (cap 4, cola), espera a TODOS y devuelve
 * {id, role, model, exitCode, durationMs, output} por task. Reemplaza el
 * patrón `pi … & wait` del AGENTS.md para tandas paralelas.
 *
 * v2 (ID01-433): `background:true` despacha y retorna YA con {dispatched, note};
 * los resultados llegan solos como mensajes `subagent-result` vía pi.sendMessage
 * (chooseDeliverAs: steer si el agente está vivo, nextTurn si idle — jamás
 * triggerTurn). Tool nueva `subagents_status` (running + ring de 20 completados).
 * Background NO es durable: el store vive en el proceso pi, no sobrevive restart.
 *
 * - Copia versionada: /home/david/comet/tooling/pi-extensions/subagents.ts
 * - Copia runtime:    ~/.pi/agent/extensions/subagents.ts (mismos bytes)
 *
 * No toca el engine.
 */
import { spawn, type ChildProcess } from "node:child_process";
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
 * Entrega de subagent-result (ID01-433, decisión congelada):
 * agente vivo → "steer" (entra antes de la próxima llamada al LLM);
 * idle → "nextTurn" (encolado al próximo prompt; NO dispara turno).
 * `triggerTurn` está PROHIBIDO en v1 (turno SELF-CONTINUED en Zeron idle).
 */
export function chooseDeliverAs(agentLive: boolean): "steer" | "nextTurn" {
	return agentLive ? "steer" : "nextTurn";
}

/** Formato congelado del mensaje subagent-result (SPEC-subagents-2). */
export function formatSubagentResult(result: SubagentResult): string {
	const secs = (result.durationMs / 1000).toFixed(1);
	return `[subagent ${result.id} · ${result.role} · ${result.model} · ${secs}s · exit ${result.exitCode}]\n${result.output}`;
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

export type CompletedState = "done" | "error" | "killed";

export interface CompletedEntry {
	id: string;
	role: Role;
	model: string;
	state: CompletedState;
	elapsed: number;
	exitCode: number;
	finishedAt: number;
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
	const concurrency: number = deps.concurrency ?? MAX_CONCURRENCY;
	const killGraceMs: number = deps.killGraceMs ?? KILL_GRACE_MS;
	const piBin: string = deps.piBin ?? defaultPiBin();
	const baseEnv: NodeJS.ProcessEnv = deps.env ?? process.env;
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

	async function runTask(task: ResolvedTask): Promise<SubagentResult> {
		const startedAt = now();
		let stdout = "";
		let stderr = "";
		return new Promise<SubagentResult>((resolve) => {
			let settled = false;
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let child: ChildProcess;
			const finish = (exitCode: number, extraErr?: string) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (killTimer) {
					clearTimeout(killTimer);
					pendingKills.delete(killTimer);
				}
				live.delete(child);
				const parts = [stdout];
				if (stderr) parts.push(`[stderr]\n${stderr}`);
				if (extraErr) parts.push(extraErr);
				resolve({
					id: task.id,
					role: task.role,
					model: modelKey(task.route),
					exitCode,
					durationMs: Math.max(0, now() - startedAt),
					output: trimTail(parts.filter(Boolean).join("\n")),
				});
			};
			child = spawnFn(
				piBin,
				[
					"--provider",
					task.route.provider,
					"--model",
					task.route.model,
					"--thinking",
					task.route.thinking,
					"-p",
					"--no-session",
					task.prompt,
				],
				{
					cwd: task.cwd ?? deps.cwdDefault ?? process.cwd(),
					env: { ...baseEnv, PI_SUBAGENT_DEPTH: "1" },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			live.add(child);
			timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGTERM");
				} catch {
					/* noop */
				}
				killTimer = setTimeout(() => {
					pendingKills.delete(killTimer!);
					try {
						child.kill("SIGKILL");
					} catch {
						/* noop */
					}
				}, killGraceMs);
				pendingKills.add(killTimer);
			}, task.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			child.stdout?.on("data", (d: Buffer) => {
				stdout = trimTail(stdout + d.toString("utf8"));
			});
			child.stderr?.on("data", (d: Buffer) => {
				stderr = trimTail(stderr + d.toString("utf8"));
			});
			child.on("error", (err: Error) => finish(-1, `spawn error: ${err.message}`));
			child.on("exit", (code: number | null) => {
				finish(timedOut ? TIMEOUT_EXIT_CODE : (code ?? -1));
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
		const worker = async (): Promise<void> => {
			while (queue.length > 0 && !aborted) {
				if (killEpoch !== myEpoch) {
					aborted = true;
					break;
				}
				const next = queue.shift();
				if (!next) break;
				const r = await runTask(next.task);
				results[next.index] = r;
				opts?.onUpdate?.({
					content: [
						{
							type: "text",
							text: `subagents: ${r.id}/${resolved.length} done · exit ${r.exitCode} · ${(r.durationMs / 1000).toFixed(1)}s · ${r.model}`,
						},
					],
				});
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, worker));
		} finally {
			opts?.signal?.removeEventListener("abort", onAbort);
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
			const state: CompletedState = killed ? "killed" : r.exitCode === 0 ? "done" : "error";
			pushCompleted({
				id: r.id,
				role: r.role,
				model: r.model,
				state,
				elapsed: r.durationMs,
				exitCode: r.exitCode,
				finishedAt: now(),
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
				try {
					entry.spawned = true;
					const r = await runTask(task);
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
			}
		})().catch(() => {
			// los workers ya tragan todo; esto evita unhandledRejection si algo escapa
		});
		return dispatched;
	}

	/** Snapshot sin bloquear: running + últimos completados (más reciente último). */
	function status(): {
		running: Array<{ id: string; state: "queued" | "running"; elapsed: number; role: Role; model: string }>;
		completed: CompletedEntry[];
	} {
		return {
			running: [...running.values()].map((e) => ({
				id: e.id,
				state: (e.spawned ? "running" : "queued") as "queued" | "running",
				elapsed: Math.max(0, now() - e.startedAt),
				role: e.role,
				model: e.model,
			})),
			completed: completed.slice(),
		};
	}

	return { runBatch, dispatchBackground, status, killAll };
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

/** Wiring testeable: inyectá runtime (spawn/now) y un `pi` mock. */
export function installSubagents(pi: ExtensionAPI, runtime = createSubagentsRuntime()): void {
	let agentLive = false; // agent_start → true, agent_settled → false (no agent_end: hay retries/compaction)
	let shutdown = false;

	pi.on("agent_start", () => {
		agentLive = true;
	});
	pi.on("agent_settled", () => {
		agentLive = false;
	});

	/** Entrega un resultado como subagent-result (1 sendMessage por task, sin concatenar). */
	const deliverResult = (result: SubagentResult): void => {
		if (shutdown) return; // tras session_shutdown no mandamos sendMessage
		pi.sendMessage(
			{ customType: "subagent-result", content: formatSubagentResult(result), display: true, details: result },
			{ deliverAs: chooseDeliverAs(agentLive) }, // jamás triggerTurn
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
			"Usala para subtareas INDEPENDIENTES en paralelo; dependientes van secuencial. Devuelve por task: {id, role, model, exitCode, durationMs, output}.",
		promptSnippet: "Despachar subagentes pi paralelos por rol (research/implement/review/hard/grunt)",
		promptGuidelines: [
			"Usá subagents para subtareas independientes en paralelo en lugar de múltiples bash con `pi … &`; los prompts deben ser auto-contenidos y deterministas.",
			"Con background:true no esperes con sleeps: los resultados llegan como subagent-result; chequeá subagents_status si necesitás el estado.",
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
					timeoutMs: Type.Optional(Type.Number({ description: "timeout por task; default 900000 (15 min)" })),
				}),
				{ minItems: 1 },
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"si true, retorna YA con {dispatched, note}; los resultados llegan como mensajes subagent-result (default false: foreground)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (params.background) {
				const dispatched = await runtime.dispatchBackground(params.tasks, {
					signal,
					onComplete: deliverResult,
				});
				const payload = { dispatched, note: "los resultados llegan como subagent-result" };
				return { content: [{ type: "text", text: JSON.stringify(payload) }], details: { dispatched } };
			}
			const results = await runtime.runBatch(params.tasks, { signal, onUpdate });
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				details: { results },
			};
		},
	});

	pi.registerTool({
		name: "subagents_status",
		label: "Subagents status",
		description: "Lista subagentes background running + últimos completados. No bloquea.",
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
