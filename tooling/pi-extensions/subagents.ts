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
 * Background NO es durable: el store vive en el proceso pi, no sobrevive restart.
 *
 * v3 (ID01-434): usage/costo por task (jsonl de la sesión del hijo en dir
 * descartable; fallback chars), envelope foreground {results, summary, payg},
 * presupuesto PI_SUBAGENTS_MAX_COST_USD (tasks NUEVOS no se despachan; los
 * vivos terminan) y status().totals (best-effort, ring de 20).
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
 * Piso de timeout por rol (directiva David 2026-08-18): el orquestador LLM no
 * puede elegir un timeout menor al piso — reviews @ high e implementaciones
 * reales tardan minutos y matarlas a los 5 min producía "subagentes mudos"
 * (exit 124 con output vacío: en modo -p el output se emite recién al final).
 */
export const ROLE_TIMEOUT_FLOOR_MS: Record<Role, number> = {
	implement: 900_000,
	hard: 900_000,
	review: 600_000,
	research: 300_000,
	grunt: 300_000,
};

/**
 * Timeout efectivo de un task: max(pedido, piso del rol). Sin pedido → default.
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
 * Heartbeat de progreso hacia el padre (directiva David 2026-08-18: el usuario
 * debe ver en qué se trabaja cada ≤25s). Además mantiene vivo el stream ACP:
 * el engine Zeron parkea turnos tras ~30s de silencio (settle window).
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

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

/** Ids de task van a path.join(sessionRoot, batchKey, id). Rechazar traversal. */
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;
export function assertSafeTaskId(id: string): void {
	if (!TASK_ID_RE.test(id) || id === "." || id === "..") {
		throw new Error(`subagents: id "${id}" inválido (solo [A-Za-z0-9._-]+)`);
	}
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
	/** ID01-434: raíz de sesiones de los hijos (default os.tmpdir()/pi-subagents). */
	sessionRoot?: string;
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
	const concurrency: number = deps.concurrency ?? MAX_CONCURRENCY;
	const killGraceMs: number = deps.killGraceMs ?? KILL_GRACE_MS;
	const piBin: string = deps.piBin ?? defaultPiBin();
	const baseEnv: NodeJS.ProcessEnv = deps.env ?? process.env;
	const sessionRoot: string = deps.sessionRoot ?? path.join(os.tmpdir(), "pi-subagents");
	const readSessionUsage: (dir: string) => TaskUsage | undefined =
		deps.readSessionUsage ?? readSessionUsageFromDir;
	const rmSessionDir: (dir: string) => void = deps.rmSessionDir ?? ((d) => fs.rmSync(d, { recursive: true, force: true }));
	const mkdirSessionDir: (dir: string) => void = deps.mkdirSessionDir ?? ((d) => fs.mkdirSync(d, { recursive: true }));
	// batchKey: pid + now + counter — dos procesos pi no pueden colisionar el mismo dir.
	let batchCounter = 0;
	const nextBatchKey = (): string => `${process.pid}-${now()}-${++batchCounter}`;
	const cleanupBatchDir = (batchKey: string): void => {
		try {
			rmSessionDir(path.join(sessionRoot, batchKey));
		} catch {
			/* ya borrado / ENOENT */
		}
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

	async function runTask(task: ResolvedTask, batchKey: string): Promise<SubagentResult> {
		const startedAt = now();
		// ID01-434 (decisión congelada): hijo CON sesión en dir descartable →
		// usage del jsonl; stdout print-mode intacto. Se borra en finish SIEMPRE.
		const sessionDir = path.join(sessionRoot, batchKey, task.id);
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
				const output = trimTail(parts.filter(Boolean).join("\n"));
				// finally (exit/timeout/kill/error): usage del jsonl o fallback chars;
				// el dir se borra SIEMPRE, también en fallo.
				let usage: TaskUsage;
				try {
					usage = readSessionUsage(sessionDir) ?? { input: 0, output: 0, cacheRead: 0, chars: output.length };
				} catch {
					usage = { input: 0, output: 0, cacheRead: 0, chars: output.length };
				}
				try {
					rmSessionDir(sessionDir);
				} catch {
					/* ya borrado */
				}
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
					"--session-dir",
					sessionDir,
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
			}, effectiveTimeoutMs(task.role, task.timeoutMs, timeoutFloorsMs));
			child.stdout?.on("data", (d: Buffer) => {
				stdout = trimTail(stdout + d.toString("utf8"));
			});
			child.stderr?.on("data", (d: Buffer) => {
				stderr = trimTail(stderr + d.toString("utf8"));
			});
			child.on("error", (err: Error) => finish(-1, `spawn error: ${err.message}`));
			child.on("exit", (code: number | null) => {
				if (timedOut) {
					const secs = Math.round(effectiveTimeoutMs(task.role, task.timeoutMs, timeoutFloorsMs) / 1000);
					finish(
						TIMEOUT_EXIT_CODE,
						`subagents: timeout tras ${secs}s — en modo -p el output se emite recién al final; la task probablemente seguía trabajando. Reintentá con timeoutMs mayor o partí la task en pasos más chicos.`,
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
		const inFlight = new Map<string, { role: Role; model: string; startedAt: number }>();
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
					.map(([id, e]) => `${id} (${e.role}·${e.model}) ${Math.round((now() - e.startedAt) / 1000)}s`)
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
				// cola; los vivos terminan. Skip → result sintético exit 125.
				if (maxCostUsd !== undefined && accumulatedCost >= maxCostUsd) {
					const r = budgetSkipResult(next.task, maxCostUsd, accumulatedCost);
					results[next.index] = r;
					emitUpdate(progressLine(r, resolved.length));
					continue;
				}
				inFlight.set(next.task.id, {
					role: next.task.role,
					model: modelKey(next.task.route),
					startedAt: now(),
				});
				let r: SubagentResult;
				try {
					r = await runTask(next.task, batchKey);
				} finally {
					inFlight.delete(next.task.id);
				}
				if (typeof r.usage?.costUsd === "number") accumulatedCost += r.usage.costUsd;
				results[next.index] = r;
				emitUpdate(progressLine(r, resolved.length));
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, worker));
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			opts?.signal?.removeEventListener("abort", onAbort);
			cleanupBatchDir(batchKey);
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
				cleanupBatchDir(batchKey);
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
			"Usala para subtareas INDEPENDIENTES en paralelo; dependientes van secuencial. " +
			"Foreground devuelve {results:[{id, role, model, exitCode, durationMs, output, usage:{input,output,cacheRead,costUsd?}}], summary, payg}.",
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
