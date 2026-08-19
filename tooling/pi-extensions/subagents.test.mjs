/**
 * Unit tests — subagents (ID01-432 + ID01-433, SPEC-subagents-1/2).
 * Sin framework: `node tooling/pi-extensions/subagents.test.mjs`
 * E2E (caro/quota, NO gate): `SUBAGENTS_E2E=1 node tooling/pi-extensions/subagents.test.mjs`
 */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

// El harness de subagentes setea PI_SUBAGENT_DEPTH=1; sin esto los tests que
// no inyectan env heredan process.env y canSpawn rechaza el batch.
delete process.env.PI_SUBAGENT_DEPTH;

// ID01-482: los runtimes SIN sessionRoot inyectado no deben crear dirs en el
// homedir real (~/.pi/agent/subagent-transcripts) durante los tests.
process.env.PI_SUBAGENTS_TRANSCRIPT_ROOT = path.join(os.tmpdir(), "pi-subagents-test");

const here = import.meta.dirname;
const mod = await import(url.pathToFileURL(path.join(here, "subagents.ts")).href);
const { resolveRoute, canSpawn, assertReviewerDistinct, trimTail, createSubagentsRuntime, ROUTES, modelKey, chooseDeliverOpts, UTILITY_PROMPT_PREFIX, formatSubagentResult, installSubagents, sumUsage, usageFromSessionJsonl, parseMaxCostUsd, formatBatchSummary, effectiveTimeoutMs, ROLE_TIMEOUT_FLOOR_MS, resolveChildMode, resolveTranscriptRoot, DEFAULT_TRANSCRIPT_ROOT, SESSION_DIR_RM_DELAY_MS, childSessionIdFor, formatSpawnedLine, formatFinishedLine, finishStatusFor, resolveInactivityMs, INACTIVITY_TIMEOUT_MS } = mod;

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		failures.push({ name, err });
		console.log(`FAIL ${name}: ${err.message}`);
	}
}

/**
 * Fake de child_process.spawn: cuenta concurrencia, exit manual.
 * ID01-461: captura stdin (stdinWrites) y, si los args son `--mode rpc`,
 * simula el protocolo: finishProc emite el stream JSONL (delta + message_end +
 * agent_settled) y el proceso sale solo cuando el runtime cierra stdin.
 */
function makeFakeSpawn({ hangOnTerm = false, hangOnClose = false } = {}) {
	const state = { spawned: 0, concurrent: 0, maxConcurrent: 0, procs: [], cmds: [], argss: [] };
	state.spawnFn = (cmd, args, opts) => {
		state.spawned++;
		state.concurrent++;
		state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
		state.cmds.push(cmd);
		state.argss.push(args);
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.exited = false;
		proc.spawnOpts = opts;
		proc.rpc = args.includes("--mode") && args.includes("rpc");
		proc.stdinWrites = [];
		proc.killSignals = [];
		// stdin como EventEmitter (fiel al real): permite testear EPIPE async.
		proc.stdin = new EventEmitter();
		proc.stdin.write = (s) => {
			proc.stdinWrites.push(String(s));
			if (proc.stdinBroken) {
				// EPIPE llega ASÍNCRONO, no como throw
				setImmediate(() => proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
				return false;
			}
			return true;
		};
		// cierre limpio rpc: stdin.end() → el proceso sale solo, salvo hangOnClose
		proc.stdin.end = () => {
			proc.stdinEnded = true;
			if (proc.rpc && !hangOnClose) state.exitProc(proc, 0);
		};
		proc.kill = (signal) => {
			proc.killSignals.push(signal);
			if (proc.killSignals.length === 1) proc.writesAtFirstKill = proc.stdinWrites.length;
			if (hangOnTerm && signal === "SIGTERM") return true; // simula proceso que ignora TERM
			state.exitProc(proc, null, signal);
			return true;
		};
		state.procs.push(proc);
		return proc;
	};
	state.exitProc = (proc, code = 0, signal = null) => {
		if (proc.exited) return;
		proc.exited = true;
		state.concurrent--;
		proc.emit("exit", code, signal);
	};
	/** Emite UNA línea JSONL por el stdout del fake. */
	state.emitRpc = (proc, obj) => proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
	state.finishProc = (proc, code = 0, signal = null, out = "ok") => {
		if (proc.exited) return;
		if (proc.rpc && !signal && code === 0) {
			// stream rpc feliz; el exit lo dispara stdin.end() del runtime
			if (out) {
				state.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: out } });
				state.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: out }] } });
			}
			state.emitRpc(proc, { type: "agent_settled" });
			return;
		}
		if (out) proc.stdout.emit("data", Buffer.from(out));
		state.exitProc(proc, code, signal);
	};
	return state;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------- resolveRoute ----------
await test("routing role→modelo (tabla del spec)", () => {
	assert.deepEqual(
		[modelKey(ROUTES.research), ROUTES.research.thinking],
		["alibaba/qwen3.8-max", "low"],
	);
	assert.deepEqual([modelKey(ROUTES.grunt), ROUTES.grunt.thinking], ["alibaba/qwen3.8-max", "low"]);
	assert.deepEqual([modelKey(ROUTES.implement), ROUTES.implement.thinking], ["zai/glm-5.3", "medium"]);
	assert.deepEqual([modelKey(ROUTES.review), ROUTES.review.thinking], ["kimi-coding/k3", "high"]);
	assert.deepEqual(
		[modelKey(ROUTES.hard), ROUTES.hard.thinking],
		["deepseek-payg/deepseek/deepseek-v4-pro", "medium"],
	);
});

await test("resolveRoute default role=grunt", () => {
	assert.equal(modelKey(resolveRoute()), "alibaba/qwen3.8-max");
});

await test("model override: split en el PRIMER slash", () => {
	const r = resolveRoute("hard", "deepseek-payg/deepseek/deepseek-v4-pro");
	assert.equal(r.provider, "deepseek-payg");
	assert.equal(r.model, "deepseek/deepseek-v4-pro");
	assert.equal(r.thinking, "medium"); // thinking del rol se mantiene
	const r2 = resolveRoute("implement", "kimi-coding/k3");
	assert.equal(r2.provider, "kimi-coding");
	assert.equal(r2.model, "k3");
});

await test("model override sin slash → error", () => {
	assert.throws(() => resolveRoute("implement", "glm-5.3"), /model override inválido/);
	assert.throws(() => resolveRoute("implement", "zai/"), /model override inválido/);
});

await test("thinking override explícito", () => {
	assert.equal(resolveRoute("implement", undefined, "high").thinking, "high");
});

// ---------- canSpawn ----------
await test("canSpawn: depth <1 ok, >=1 rechaza, basura tolerada", () => {
	assert.equal(canSpawn({}), true);
	assert.equal(canSpawn({ PI_SUBAGENT_DEPTH: "0" }), true);
	assert.equal(canSpawn({ PI_SUBAGENT_DEPTH: "abc" }), true);
	assert.equal(canSpawn({ PI_SUBAGENT_DEPTH: "1" }), false);
	assert.equal(canSpawn({ PI_SUBAGENT_DEPTH: "2" }), false);
});

await test("runBatch rechaza por depth ANTES de spawnear", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, env: { PI_SUBAGENT_DEPTH: "1" } });
	await assert.rejects(() => rt.runBatch([{ prompt: "x" }]), /PI_SUBAGENT_DEPTH/);
	assert.equal(fake.spawned, 0);
});

// ---------- assertReviewerDistinct ----------
await test("review+implement default (modelos distintos) → pasa", () => {
	const items = [
		{ role: "implement", route: resolveRoute("implement") },
		{ role: "review", route: resolveRoute("review") },
	];
	assert.doesNotThrow(() => assertReviewerDistinct(items));
});

await test("revisor=implementador mismo modelo → fail antes de spawn", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const tasks = [
		{ role: "implement", prompt: "x", model: "zai/glm-5.3" },
		{ role: "review", prompt: "y", model: "zai/glm-5.3" },
	];
	await assert.rejects(() => rt.runBatch(tasks), /mismo modelo/);
	assert.equal(fake.spawned, 0);
});

await test("batch sin mezcla review+implement no valida cruce", () => {
	const items = [
		{ role: "review", route: resolveRoute("review", "zai/glm-5.3") },
		{ role: "research", route: resolveRoute("research") },
	];
	assert.doesNotThrow(() => assertReviewerDistinct(items));
});

// ---------- trimTail ----------
await test("trimTail: corto igual; largo queda en 8KB tail con marcador", () => {
	assert.equal(trimTail("hola"), "hola");
	const big = "x".repeat(20 * 1024) + "FIN_DEL_TAIL";
	const out = trimTail(big);
	assert.ok(out.startsWith("[…"), "marcador de recorte");
	assert.ok(out.endsWith("FIN_DEL_TAIL"));
	assert.ok(Buffer.byteLength(out) <= 8 * 1024 + 80, `cap ~8KB, got ${Buffer.byteLength(out)}`);
	// el tail conservado es el final del original
	assert.equal(out.slice(out.indexOf("\n") + 1), big.slice(-out.slice(out.indexOf("\n") + 1).length));
});

// ---------- cap de concurrencia ----------
await test("cap 4 vivos: 8 tasks, nunca más de 4 procesos simultáneos", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 1}`, role: "research", prompt: `p${i}` }));
	let done = false;
	const batch = rt.runBatch(tasks).then((res) => {
		done = true;
		return res;
	});
	// Drenar la cola a medida que arrancan (workers toman de a 1)
	for (let i = 0; i < 40 && !done; i++) {
		const pending = fake.procs.find((p) => !p.exited);
		if (pending) fake.finishProc(pending, 0, null, `out-${i}`);
		await tick();
	}
	const results = await batch;
	assert.equal(fake.maxConcurrent, 4, `max concurrent ${fake.maxConcurrent}, esperado 4`);
	assert.equal(results.length, 8);
	assert.deepEqual(
		results.map((r) => r.id),
		["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
	);
	assert.ok(results.every((r) => r.exitCode === 0));
});

await test("spawn args: PI absoluto + --session-dir (no --no-session) + env hijo PI_SUBAGENT_DEPTH=1", async () => {
	const fake = makeFakeSpawn();
	// childMode "print": este test fija el contrato de args del modo -p (461: el default es rpc)
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/sessions",
		now: () => 5000,
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		childMode: "print",
	});
	const batch = rt.runBatch([{ role: "review", prompt: "mirá" }]);
	await tick();
	const proc = fake.procs[0];
	fake.finishProc(proc, 0);
	await batch;
	assert.equal(fake.cmds[0], "/fake/pi");
	assert.deepEqual(fake.argss[0], [
		"--provider", "kimi-coding",
		"--model", "k3",
		"--thinking", "high",
		"-p", "--session-dir", path.join("/fake/sessions", `t1-${process.pid}-5000-1`), "mirá",
	]);
	assert.ok(!fake.argss[0].includes("--no-session"), "434: ya no se pasa --no-session");
	assert.equal(proc.spawnOpts.env.PI_SUBAGENT_DEPTH, "1");
	assert.equal(proc.spawnOpts.stdio[0], "ignore");
});

// ---------- timeout ----------
await test("timeout: TERM ignorado → KILL → exitCode ≠ 0 y el batch sigue", async () => {
	const fake = makeFakeSpawn({ hangOnTerm: true });
	// timeoutFloorsMs: {} deshabilita el clamp por rol para poder testear con ms.
	// childMode "print": este test fija el mensaje de timeout del modo -p (461: el de rpc difiere)
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 20, timeoutFloorsMs: {}, childMode: "print" });
	const batch = rt.runBatch([
		{ id: "slow", prompt: "colgado", timeoutMs: 25 },
		{ id: "fast", prompt: "rápido" },
	]);
	await tick(); // ambos spawnearon
	const fast = fake.procs.find((p) => !fake.argss[fake.procs.indexOf(p)].includes("colgado"));
	fake.finishProc(fast, 0);
	const results = await batch;
	const slow = results.find((r) => r.id === "slow");
	assert.equal(slow.exitCode, 124); // ≠ 0
	assert.ok(slow.durationMs >= 25);
	assert.ok(slow.output.includes("timeout tras"), "mensaje honesto de timeout");
	assert.ok(slow.output.includes("-p"), "explica que el output de -p llega al final");
	assert.equal(results.find((r) => r.id === "fast").exitCode, 0, "un fallo no tumba el batch");
});

// ---------- pisos del CAP duro por rol (ID01-484: la inactividad es el asesino primario) ----------
await test("effectiveTimeoutMs: clamp al piso del rol; sin pedido usa default", () => {
	assert.equal(effectiveTimeoutMs("review", 300_000), 1_800_000, "review no puede bajar de 30 min");
	assert.equal(effectiveTimeoutMs("implement", 300_000), 3_600_000, "implement no puede bajar de 60 min");
	assert.equal(effectiveTimeoutMs("grunt", 60_000), 900_000, "grunt no puede bajar de 15 min");
	assert.equal(effectiveTimeoutMs("review", 2_400_000), 2_400_000, "subir sí se puede");
	assert.equal(effectiveTimeoutMs("grunt", undefined), 900_000, "sin pedido → max(default, piso)");
	assert.equal(effectiveTimeoutMs("review", 25, {}), 25, "floors {} deshabilita el clamp (tests)");
	assert.equal(ROLE_TIMEOUT_FLOOR_MS.hard, 3_600_000);
});

// ---------- heartbeat (directiva 2026-08-18: reporte ≤25s) ----------
await test("heartbeat: emite progreso con tasks vivas y elapsed mientras corren", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, heartbeatMs: 10, timeoutFloorsMs: {} });
	const updates = [];
	const batch = rt.runBatch([{ id: "lento", role: "review", prompt: "review largo" }], {
		onUpdate: (u) => updates.push(u.content[0].text),
	});
	await tick(40); // varios heartbeats con el hijo vivo
	const beats = updates.filter((t) => t.includes("⏳"));
	assert.ok(beats.length >= 1, `esperaba >=1 heartbeat, hubo ${beats.length}`);
	assert.ok(beats[0].includes("lento"), "el heartbeat nombra la task");
	assert.ok(beats[0].includes("review"), "el heartbeat trae el rol");
	assert.ok(beats[0].includes("0/1 done"), "el heartbeat trae el progreso del batch");
	fake.finishProc(fake.procs[0], 0);
	const results = await batch;
	assert.equal(results[0].exitCode, 0);
	assert.ok(
		updates.some((t) => t.includes("done") && !t.includes("⏳")),
		"al completar sigue saliendo la línea done por task",
	);
});

await test("heartbeat: no emite sin tasks vivas ni después de terminar el batch", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, heartbeatMs: 10, timeoutFloorsMs: {} });
	const updates = [];
	const batch = rt.runBatch([{ id: "x", prompt: "rápido" }], {
		onUpdate: (u) => updates.push(u.content[0].text),
	});
	await tick();
	fake.finishProc(fake.procs[0], 0);
	await batch;
	const count = updates.length;
	await tick(40); // el interval quedó cleareado en finally
	assert.equal(updates.length, count, "sin heartbeats después del batch");
});

// ---------- spawn error ----------
await test("spawn error (ENOENT-like) → exitCode -1, batch completo", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const batch = rt.runBatch([{ id: "a", prompt: "1" }, { id: "b", prompt: "2" }]);
	await tick();
	fake.procs[0].emit("error", new Error("spawn ENOENT"));
	await tick();
	fake.finishProc(fake.procs[1], 0);
	const results = await batch;
	assert.equal(results.find((r) => r.id === "a").exitCode, -1);
	assert.ok(/spawn ENOENT/.test(results.find((r) => r.id === "a").output));
	assert.equal(results.length, 2);
});

// ---------- abort ----------
await test("signal abort → mata todo y el batch falla", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const ac = new AbortController();
	const batch = rt.runBatch([{ id: "a", prompt: "1" }], { signal: ac.signal });
	await tick();
	ac.abort();
	await assert.rejects(() => batch, /abortado/);
});

// ---------- ID01-433: background + status ----------
await test("background: dispatch resuelve YA sin esperar exit de los procs", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const dispatched = await rt.dispatchBackground([{ id: "t1", role: "research", prompt: "x" }]);
	assert.deepEqual(dispatched, [{ id: "t1", role: "research", model: "alibaba/qwen3.8-max" }]);
	assert.equal(fake.spawned, 1);
	assert.equal(fake.procs[0].exited, false, "el proc sigue vivo cuando dispatch ya resolvió");
	fake.finishProc(fake.procs[0], 0);
	await tick();
	assert.equal(rt.status().completed.length, 1);
});

await test("onComplete: 1 call por task, en orden de completado (t2 antes que t1)", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const calls = [];
	const done = new Promise((resolve) => {
		let n = 0;
		rt.dispatchBackground(
			[
				{ id: "t1", prompt: "a" },
			{ id: "t2", prompt: "b" },
			],
			{
				onComplete: (r) => {
					calls.push(r.id);
					if (++n === 2) resolve();
				},
			},
		);
	});
	await tick();
	assert.equal(fake.spawned, 2, "ambos corriendo en paralelo (cap 4)");
	fake.finishProc(fake.procs[1], 0, null, "b"); // t2 termina primero
	fake.finishProc(fake.procs[0], 0, null, "a");
	await done;
	assert.deepEqual(calls, ["t2", "t1"], "orden de completado, no de dispatch");
});

await test("chooseDeliverOpts: agente vivo → steer, idle → triggerTurn (revisión 2026-08-19: nextTurn era agujero negro)", () => {
	assert.deepEqual(chooseDeliverOpts(true), { deliverAs: "steer" });
	assert.deepEqual(chooseDeliverOpts(false), { triggerTurn: true });
});

await test("formatSubagentResult: formato congelado del spec (434: costBit)", () => {
	assert.equal(
		formatSubagentResult({ id: "t1", role: "review", model: "kimi-coding/k3", exitCode: 0, durationMs: 1234, output: "hola", usage: { input: 10, output: 20, cacheRead: 5, costUsd: 0.01 } }),
		"[subagent t1 · review · kimi-coding/k3 · 1.2s · exit 0 · ~$0.01]\nhola",
	);
});

await test("status: running con elapsed ≥ 0 → done con exitCode presente", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	rt.dispatchBackground([{ id: "s1", role: "grunt", prompt: "x" }]);
	await tick();
	let s = rt.status();
	assert.equal(s.running.length, 1);
	assert.equal(s.running[0].id, "s1");
	assert.equal(s.running[0].state, "running");
	assert.equal(s.running[0].model, "alibaba/qwen3.8-max");
	assert.ok(s.running[0].elapsed >= 0);
	assert.equal(s.completed.length, 0);
	fake.finishProc(fake.procs[0], 0);
	await tick();
	s = rt.status();
	assert.equal(s.running.length, 0);
	assert.equal(s.completed.length, 1);
	assert.equal(s.completed[0].state, "done");
	assert.equal(s.completed[0].exitCode, 0);
	assert.ok(s.completed[0].elapsed >= 0);
	assert.ok(Number.isFinite(s.completed[0].finishedAt));
});

await test("ráfaga: 3 completes → 3 onComplete separados (nunca 1 concatenada)", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const calls = [];
	const done = new Promise((resolve) => {
		let n = 0;
		rt.dispatchBackground(
			[
				{ id: "a", prompt: "1" },
			{ id: "b", prompt: "2" },
			{ id: "c", prompt: "3" },
			],
			{
				onComplete: (r) => {
					calls.push(r.id);
					if (++n === 3) resolve();
				},
			},
		);
	});
	await tick();
	fake.procs.forEach((p, i) => fake.finishProc(p, i === 1 ? 1 : 0));
	await done;
	assert.equal(calls.length, 3);
	assert.deepEqual([...calls].sort(), ["a", "b", "c"]);
	assert.equal(rt.status().completed.find((c) => c.id === "b").state, "error");
	assert.equal(rt.status().completed.filter((c) => c.state === "done").length, 2);
});

await test("killAll con background vivo → completed state killed, no queda en running", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 1 });
	rt.dispatchBackground([
		{ id: "k1", prompt: "x" },
		{ id: "k2", prompt: "y" },
	]);
	await tick();
	rt.killAll();
	await tick(10);
	const s = rt.status();
	assert.equal(s.running.length, 0);
	assert.equal(s.completed.length, 2);
	assert.ok(s.completed.every((c) => c.state === "killed"), JSON.stringify(s.completed));
});

await test("killAll no es sticky: un batch nuevo después puede completar done", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 1 });
	rt.dispatchBackground([{ id: "t1", prompt: "old" }]);
	await tick();
	rt.killAll();
	await tick(10);
	assert.equal(rt.status().running.length, 0);
	// reusa el mismo id: el sweep del batch viejo no lo puede marcar killed
	const calls = [];
	const done = new Promise((resolve) => {
		rt.dispatchBackground([{ id: "t1", prompt: "new" }], {
			onComplete: (r) => {
				calls.push(r.id);
				resolve();
			},
		});
	});
	await tick();
	const neu = fake.procs.find((p) => !p.exited);
	assert.ok(neu, "el batch nuevo tiene que haber spawnado");
	fake.finishProc(neu, 0);
	await done;
	const last = rt.status().completed.at(-1);
	assert.equal(last.id, "t1");
	assert.equal(last.state, "done", JSON.stringify(rt.status().completed));
	assert.deepEqual(calls, ["t1"]);
});

await test("onComplete que lanza no duplica el completed ni tumba el runtime", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	let calls = 0;
	rt.dispatchBackground([{ id: "x", prompt: "p" }], {
		onComplete: () => {
			calls++;
			throw new Error("boom deliverResult");
		},
	});
	await tick();
	fake.finishProc(fake.procs[0], 0);
	await tick(20);
	assert.equal(calls, 1, "onComplete se llamó una sola vez (aunque lanzó)");
	assert.equal(rt.status().completed.length, 1, "sin entrada duplicada en completed");
	assert.equal(rt.status().completed[0].state, "done");
});

await test("killAll con viejo que cuelga en SIGTERM + reuso de id → nuevo queda done", async () => {
	const fake = makeFakeSpawn({ hangOnTerm: true });
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 5 });
	rt.dispatchBackground([{ id: "t1", prompt: "old" }]);
	await tick();
	rt.killAll(); // SIGTERM ignorado; SIGKILL llega en ~5ms
	await tick(30); // SIGKILL dispara → viejo finaliza killed; sweep ya corrió
	assert.equal(rt.status().running.length, 0);
	const calls = [];
	const done = new Promise((resolve) => {
		rt.dispatchBackground([{ id: "t1", prompt: "new" }], {
			onComplete: (r) => {
				calls.push(r.id);
				resolve();
			},
		});
	});
	await tick();
	const neu = fake.procs.find((p) => !p.exited);
	assert.ok(neu, "el batch nuevo tiene que haber spawnado");
	fake.finishProc(neu, 0);
	await done;
	const completed = rt.status().completed;
	assert.ok(completed.some((c) => c.id === "t1" && c.state === "killed"), "viejo quedó killed");
	assert.ok(completed.some((c) => c.id === "t1" && c.state === "done"), "nuevo quedó done");
	assert.deepEqual(calls, ["t1"]);
});

await test("id ya en running → rechaza el batch entero, 0 spawn extra", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	await rt.dispatchBackground([{ id: "dup", prompt: "x" }]);
	assert.equal(fake.spawned, 1);
	await assert.rejects(
		() => rt.dispatchBackground([{ id: "dup", prompt: "y" }, { id: "otro", prompt: "z" }]),
		/ya está running/,
	);
	assert.equal(fake.spawned, 1, "ni \"otro\" spawnó: batch rechazado entero");
	assert.equal(rt.status().running.length, 1);
	// limpieza para no dejar timers vivos
	fake.finishProc(fake.procs[0], 0);
	await tick();
});

await test("background valida igual que foreground: depth, review=implement, ≥1 task", async () => {
	const fakeDepth = makeFakeSpawn();
	const rtDepth = createSubagentsRuntime({ spawnFn: fakeDepth.spawnFn, env: { PI_SUBAGENT_DEPTH: "1" } });
	await assert.rejects(() => rtDepth.dispatchBackground([{ prompt: "x" }]), /PI_SUBAGENT_DEPTH/);
	assert.equal(fakeDepth.spawned, 0);

	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	await assert.rejects(
		() =>
			rt.dispatchBackground([
				{ role: "implement", prompt: "x", model: "zai/glm-5.3" },
			{ role: "review", prompt: "y", model: "zai/glm-5.3" },
			]),
		/mismo modelo/,
	);
	assert.equal(fake.spawned, 0);
	await assert.rejects(() => rt.dispatchBackground([]), /al menos un task/);
});

await test("foreground: ids duplicados en el batch se rechazan antes de spawn", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	await assert.rejects(
		() => rt.runBatch([{ id: "t2", prompt: "a" }, { prompt: "b" }, { prompt: "c" }]),
		/repetido en el batch/,
	);
	assert.equal(fake.spawned, 0);
});

await test("killAll frena cola foreground: no spawn extra post-shutdown", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, concurrency: 2, killGraceMs: 1 });
	const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `f${i + 1}`, prompt: `p${i}` }));
	const batch = rt.runBatch(tasks);
	const rejected = assert.rejects(() => batch, /abortado/);
	await tick();
	assert.equal(fake.spawned, 2);
	rt.killAll();
	await rejected;
	assert.equal(fake.spawned, 2, "no se spawnan los 4 que quedaban en cola");
});

await test("background: signal ya abortado → reject, 0 spawn, 0 running", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(
		() => rt.dispatchBackground([{ id: "x", prompt: "no" }], { signal: ac.signal }),
		/signal abortado/,
	);
	assert.equal(fake.spawned, 0);
	assert.equal(rt.status().running.length, 0);
	assert.equal(rt.status().completed.length, 0);
});

await test("status: cap 1 → 1 running + 1 queued", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, concurrency: 1 });
	rt.dispatchBackground([
		{ id: "a", prompt: "1" },
		{ id: "b", prompt: "2" },
	]);
	await tick();
	const s = rt.status();
	assert.equal(s.running.length, 2);
	assert.equal(s.running.find((r) => r.id === "a").state, "running");
	assert.equal(s.running.find((r) => r.id === "b").state, "queued");
	fake.finishProc(fake.procs[0], 0);
	await tick();
	const s2 = rt.status();
	assert.equal(s2.running.find((r) => r.id === "b")?.state, "running");
	fake.finishProc(fake.procs[1], 0);
	await tick();
});

function makeFakePi() {
	const tools = {};
	const handlers = {};
	const sent = [];
	const pi = {
		on(ev, fn) {
			handlers[ev] = fn;
		},
		registerTool(t) {
			tools[t.name] = t;
		},
		sendMessage(msg, opts) {
			sent.push({ msg, opts });
		},
	};
	return { pi, tools, handlers, sent };
}

await test("installSubagents: steer si live, triggerTurn si idle, nada post-shutdown", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const { pi, tools, handlers, sent } = makeFakePi();
	installSubagents(pi, rt);
	assert.ok(tools.subagents);
	assert.ok(tools.subagents_status);

	handlers.agent_start();
	const live = tools.subagents.execute(
		"tc1",
		{ background: true, tasks: [{ id: "live1", prompt: "x" }] },
		undefined,
		undefined,
	);
	await tick();
	fake.finishProc(fake.procs[0], 0, null, "out-live");
	await tick();
	await live;
	assert.equal(sent.length, 1);
	assert.equal(sent[0].opts.deliverAs, "steer");
	assert.equal(sent[0].opts.triggerTurn, undefined);
	assert.equal(sent[0].msg.customType, "subagent-result");
	assert.equal(sent[0].msg.display, true);
	assert.match(sent[0].msg.content, /subagent live1/);

	handlers.agent_settled();
	const idle = tools.subagents.execute(
		"tc2",
		{ background: true, tasks: [{ id: "idle1", prompt: "y" }] },
		undefined,
		undefined,
	);
	await tick();
	fake.finishProc(fake.procs[1], 0, null, "out-idle");
	await tick();
	await idle;
	assert.equal(sent.length, 2);
	assert.equal(sent[1].opts.triggerTurn, true, "idle → despierta el turno para reportar");
	assert.equal(sent[1].opts.deliverAs, undefined);

	handlers.session_shutdown();
	const after = tools.subagents.execute(
		"tc3",
		{ background: true, tasks: [{ id: "dead1", prompt: "z" }] },
		undefined,
		undefined,
	);
	await tick();
	const leftover = fake.procs.find((p) => !p.exited);
	if (leftover) fake.finishProc(leftover, 0);
	await tick();
	await after.catch(() => {});
	assert.equal(sent.length, 2, "post-shutdown no manda sendMessage");
});

await test("gate de utilería: sesión de titulado NO spawnea subagentes (incidente 2026-08-19)", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const { pi, tools, handlers } = makeFakePi();
	installSubagents(pi, rt);
	// El engine manda el prompt de titulado con la tarea del usuario embebida.
	handlers.input({
		text: `${UTILITY_PROMPT_PREFIX} in Title Case (no quotes, no punctuation) for a coding session that begins with this request:\n\nLanzá DOS subagentes en paralelo...`,
		source: "rpc",
	});
	const r = await tools.subagents.execute("tc-util", { tasks: [{ id: "t1", prompt: "x" }] }, undefined, undefined);
	assert.match(r.content[0].text, /utilería/, "rechaza con explicación");
	assert.equal(fake.procs.length, 0, "cero spawns en sesión de utilería");
	// Un input normal NO activa el gate (sesión nueva).
	const fake2 = makeFakeSpawn();
	const rt2 = createSubagentsRuntime({ spawnFn: fake2.spawnFn });
	const { pi: pi2, tools: tools2, handlers: handlers2 } = makeFakePi();
	installSubagents(pi2, rt2);
	handlers2.input({ text: "Lanzá dos subagentes de verdad", source: "rpc" });
	const p = tools2.subagents.execute("tc-real", { tasks: [{ id: "t1", prompt: "x" }] }, undefined, undefined);
	await tick();
	assert.equal(fake2.procs.length, 1, "sesión real sí spawnea");
	fake2.finishProc(fake2.procs[0], 0, null, "ok");
	await p;
});

await test("gate de utilería SOLO evalúa el primer input: un mensaje posterior con el prefijo no envenena la sesión (hallazgo k3)", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	const { pi, tools, handlers } = makeFakePi();
	installSubagents(pi, rt);
	handlers.input({ text: "Implementá el issue 490 como hablamos", source: "rpc" });
	handlers.input({ text: `${UTILITY_PROMPT_PREFIX} for this PR`, source: "rpc" }); // usuario legítimo, mensaje 2
	const p = tools.subagents.execute("tc-post", { tasks: [{ id: "t1", prompt: "x" }] }, undefined, undefined);
	await tick();
	assert.equal(fake.procs.length, 1, "el gate no se activó: spawnea normal");
	fake.finishProc(fake.procs[0], 0, null, "ok");
	await p;
});

// ---------- ID01-434: usage/costo + presupuesto + envelope ----------

await test("usageFromSessionJsonl: suma assistant+toolResult+compaction; costUsd solo si hay cost.total", () => {
	const jsonl = [
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } } } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", usage: { input: 10, output: 0, cacheRead: 0 } } }),
		JSON.stringify({ type: "compaction", usage: { input: 1, output: 2, cacheRead: 3 } }),
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 1, cost: { total: 0.02 } } } }),
		JSON.stringify({ type: "message", message: { role: "user" } }), // sin usage → ignorado
		"línea no-json", // ignorada
	].join("\n");
	const u = usageFromSessionJsonl(jsonl);
	assert.equal(u.input, 112);
	assert.equal(u.output, 23);
	assert.equal(u.cacheRead, 9);
	assert.ok(Math.abs(u.costUsd - 0.03) < 1e-9, `costUsd ${u.costUsd}`);
	// sin ningún cost.total → SIN costUsd (no 0 mintiendo)
	const sinCost = usageFromSessionJsonl(
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 5, output: 5, cacheRead: 5 } } }),
	);
	assert.deepEqual(sinCost, { input: 5, output: 5, cacheRead: 5 });
});

await test("usageFromSessionJsonl vacío / sin usage → ceros sin costUsd (fallback en runTask)", async () => {
	assert.deepEqual(usageFromSessionJsonl(""), { input: 0, output: 0, cacheRead: 0 });
	assert.deepEqual(usageFromSessionJsonl("basura\n\n{nope}"), { input: 0, output: 0, cacheRead: 0 });
	// default readSessionUsage (walk real, sin jsonl) → undefined → fallback chars
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, mkdirSessionDir: () => {}, rmSessionDir: () => {} });
	const batch = rt.runBatch([{ id: "t1", prompt: "x" }]);
	await tick();
	fake.finishProc(fake.procs[0], 0, null, "hola");
	const [r] = await batch;
	assert.deepEqual(r.usage, { input: 0, output: 0, cacheRead: 0, chars: 4 }); // "hola".length
});

await test("sumUsage: [] → ceros; costUsd solo si ALGUNA part lo trae", () => {
	assert.deepEqual(sumUsage([]), { input: 0, output: 0, cacheRead: 0 });
	assert.deepEqual(
		sumUsage([{ input: 1, output: 2, cacheRead: 3 }, { input: 10, output: 20, cacheRead: 30, costUsd: 0.5 }, { chars: 5 }]),
		{ input: 11, output: 22, cacheRead: 33, costUsd: 0.5 },
	);
});

await test("parseMaxCostUsd: ausente/''/NaN/negativo → undefined; '0.5' → 0.5", () => {
	assert.equal(parseMaxCostUsd({}), undefined);
	assert.equal(parseMaxCostUsd({ PI_SUBAGENTS_MAX_COST_USD: "" }), undefined);
	assert.equal(parseMaxCostUsd({ PI_SUBAGENTS_MAX_COST_USD: "abc" }), undefined);
	assert.equal(parseMaxCostUsd({ PI_SUBAGENTS_MAX_COST_USD: "-1" }), undefined);
	assert.equal(parseMaxCostUsd({ PI_SUBAGENTS_MAX_COST_USD: "0.5" }), 0.5);
	assert.equal(parseMaxCostUsd({ PI_SUBAGENTS_MAX_COST_USD: "0" }), 0);
});

await test("formatBatchSummary: costo, n/d, PAYG, skipped (formato congelado)", () => {
	assert.equal(
		formatBatchSummary({ n: 4, wallMs: 12345, sumMs: 30100, costUsd: 0.31, payg: false }),
		"4 tasks · 12.3s wall · 30.1s cpu · ~$0.31 total",
	);
	assert.equal(
		formatBatchSummary({ n: 3, wallMs: 8000, sumMs: 8000, payg: true }),
		"3 tasks · 8.0s wall · 8.0s cpu · cost n/d · incluye PAYG",
	);
	assert.equal(
		formatBatchSummary({ n: 4, wallMs: 1000, sumMs: 2000, costUsd: 0.5, payg: true, skipped: 1 }),
		"4 tasks · 1.0s wall · 2.0s cpu · ~$0.50 total · incluye PAYG · 1 skipped (presupuesto)",
	);
});

await test("runBatch: usage inyectado en cada result; execute foreground arma envelope con summary", async () => {
	const fake = makeFakeSpawn();
	const usage = { input: 100, output: 50, cacheRead: 10, costUsd: 0.01 };
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, readSessionUsage: () => usage });
	const { pi, tools } = makeFakePi();
	installSubagents(pi, rt);
	const updates = [];
	const exec = tools.subagents.execute(
		"tc",
		{ tasks: [{ id: "t1", role: "research", prompt: "x" }] },
		undefined,
		(u) => updates.push(u.content[0].text),
	);
	await tick();
	fake.finishProc(fake.procs[0], 0, null, "hola");
	const out = await exec;
	const env = JSON.parse(out.content[0].text);
	assert.equal(env.results.length, 1);
	assert.deepEqual(env.results[0].usage, usage);
	assert.match(env.summary, /^1 tasks · [\d.]+s wall · [\d.]+s cpu · ~\$0\.01 total$/);
	assert.equal(env.payg, false);
	assert.equal(out.details.summary, env.summary);
	// 461: updates[0] puede ser un update inmediato de actividad (rpc); la línea done sigue saliendo
	assert.match(updates.find((t) => t.includes("/1 done")), /t1\/1 done · exit 0 · [\d.]+s · \$0\.01 · alibaba\/qwen3\.8-max/);
});

await test("presupuesto foreground: acumulado >= max → el próximo NO spawnea (exit 125, skipped budget)", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		concurrency: 1,
		env: { PI_SUBAGENTS_MAX_COST_USD: "0.01" },
		readSessionUsage: () => ({ input: 100, output: 10, cacheRead: 0, costUsd: 0.02 }),
	});
	const batch = rt.runBatch([{ id: "t1", prompt: "caro" }, { id: "t2", prompt: "barato" }]);
	await tick(); // t1 spawnea (única vía de cost)
	fake.finishProc(fake.procs[0], 0);
	const results = await batch;
	assert.equal(fake.argss.length, 1, "solo t1 spawnó");
	assert.equal(results[0].usage.costUsd, 0.02);
	assert.equal(results[1].skipped, "budget");
	assert.equal(results[1].exitCode, 125);
	assert.equal(results[1].durationMs, 0);
	assert.match(results[1].output, /PI_SUBAGENTS_MAX_COST_USD/);
	assert.match(results[1].output, /\$0\.02 >= \$0\.01/);
	assert.deepEqual(results[1].usage, { input: 0, output: 0, cacheRead: 0 });
});

await test("presupuesto no pisa vivos: concurrency=2, ambos spawned → 0 skipped", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		concurrency: 2,
		env: { PI_SUBAGENTS_MAX_COST_USD: "0.01" },
		readSessionUsage: () => ({ input: 1, output: 1, cacheRead: 0, costUsd: 0.02 }),
	});
	const batch = rt.runBatch([{ id: "a", prompt: "1" }, { id: "b", prompt: "2" }]);
	await tick(); // ambos spawned ANTES de que llegue cualquier usage
	fake.finishProc(fake.procs[0], 0);
	fake.finishProc(fake.procs[1], 0);
	const results = await batch;
	assert.equal(fake.argss.length, 2);
	assert.ok(results.every((r) => r.skipped === undefined), "ninguno skipped");
});

await test("presupuesto background: skipped → onComplete SÍ + state 'skipped' + totals", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		concurrency: 1,
		env: { PI_SUBAGENTS_MAX_COST_USD: "0.01" },
		readSessionUsage: () => ({ input: 1, output: 1, cacheRead: 0, costUsd: 0.02 }),
	});
	const calls = [];
	const done = new Promise((resolve) => {
		let n = 0;
		rt.dispatchBackground([{ id: "a", prompt: "1" }, { id: "b", prompt: "2" }], {
			onComplete: (r) => {
				calls.push(r);
				if (++n === 2) resolve();
			},
		});
	});
	await tick();
	fake.finishProc(fake.procs[0], 0);
	await done;
	assert.equal(fake.argss.length, 1, "solo 'a' spawnó");
	const b = calls.find((r) => r.id === "b");
	assert.equal(b.skipped, "budget");
	assert.equal(b.exitCode, 125);
	const s = rt.status();
	assert.equal(s.running.length, 0);
	assert.equal(s.completed.find((c) => c.id === "b").state, "skipped");
	assert.ok(Math.abs(s.totals.costUsd - 0.02) < 1e-9, `totals.costUsd ${s.totals.costUsd}`);
	assert.ok(s.totals.sumMs >= 0);
	assert.equal(s.totals.payg, undefined);
});

await test("role hard → payg true: envelope + summary + note background + totals", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, readSessionUsage: () => undefined });
	const { pi, tools } = makeFakePi();
	installSubagents(pi, rt);
	const exec = tools.subagents.execute("tc1", { tasks: [{ id: "h1", role: "hard", prompt: "x" }] }, undefined, undefined);
	await tick();
	fake.finishProc(fake.procs[0], 0, null, "ok");
	const out = await exec;
	const env = JSON.parse(out.content[0].text);
	assert.equal(env.payg, true);
	assert.match(env.summary, / · incluye PAYG$/);
	assert.equal(env.results[0].usage.chars, 2); // "ok".length — fallback sin costUsd
	assert.equal("costUsd" in env.results[0].usage, false);

	const bg = await tools.subagents.execute("tc2", { background: true, tasks: [{ id: "h2", role: "hard", prompt: "y" }] }, undefined, undefined);
	assert.match(JSON.parse(bg.content[0].text).note, /incluye PAYG/);
	fake.finishProc(fake.procs[1], 0);
	await tick();
	assert.equal(rt.status().totals.payg, true);
});

await test("rmSessionDir se llama aunque el child salga ≠ 0 (delay-rm ID01-482)", async () => {
	const rms = [];
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, mkdirSessionDir: () => {}, rmSessionDir: (d) => rms.push(d), sessionRmDelayMs: 5 });
	const batch = rt.runBatch([{ id: "bad", prompt: "x" }]);
	await tick();
	fake.finishProc(fake.procs[0], 3); // exit ≠ 0
	const [r] = await batch;
	assert.equal(r.exitCode, 3);
	assert.equal(rms.length, 0, "ID01-482: el rm es diferido, no inmediato");
	await tick(50);
	assert.ok(rms.some((d) => /[\\/]bad-/.test(d)), `task dir en ${JSON.stringify(rms)}`);
	assert.ok(rms.length >= 1);
});

await test("formatSubagentResult incluye ~$X o cost n/d (nunca nada más)", () => {
	assert.match(
		formatSubagentResult({ id: "t1", role: "grunt", model: "alibaba/qwen3.8-max", exitCode: 0, durationMs: 100, output: "x", usage: { input: 0, output: 0, cacheRead: 0, chars: 1 } }),
		/^\[subagent t1 · grunt · alibaba\/qwen3\.8-max · 0\.1s · exit 0 · cost n\/d\]/,
	);
	assert.match(
		formatSubagentResult({ id: "t2", role: "hard", model: "deepseek-payg/deepseek/deepseek-v4-pro", exitCode: 125, durationMs: 0, output: "skip", usage: { input: 0, output: 0, cacheRead: 0 }, skipped: "budget" }),
		/^\[subagent t2 · hard · deepseek-payg\/deepseek\/deepseek-v4-pro · 0\.0s · exit 125 · cost n\/d\]/,
	);
});

// ---------- ID01-461: modo rpc (streaming real) ----------

await test("resolveChildMode: default rpc, env print, deps gana sobre env", () => {
	assert.equal(resolveChildMode({}, {}), "rpc");
	assert.equal(resolveChildMode({}, { PI_SUBAGENTS_CHILD_MODE: "print" }), "print");
	assert.equal(resolveChildMode({}, { PI_SUBAGENTS_CHILD_MODE: "rpc" }), "rpc");
	assert.equal(resolveChildMode({}, { PI_SUBAGENTS_CHILD_MODE: "basura" }), "rpc", "el env solo reconoce print");
	assert.equal(resolveChildMode({ childMode: "print" }, {}), "print");
	assert.equal(resolveChildMode({ childMode: "rpc" }, { PI_SUBAGENTS_CHILD_MODE: "print" }), "rpc", "deps pisa al env");
	assert.equal(resolveChildMode({ childMode: "print" }, { PI_SUBAGENTS_CHILD_MODE: "rpc" }), "print");
});

await test("rpc feliz: prompt por stdin, args sin -p, output acumulado, exit 0", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
	});
	const batch = rt.runBatch([{ id: "r1", role: "review", prompt: "mirá esto" }]);
	await tick();
	const proc = fake.procs[0];
	assert.equal(proc.rpc, true, "el fake detectó --mode rpc");
	assert.deepEqual(fake.argss[0].slice(0, -1), [
		"--mode", "rpc",
		"--provider", "kimi-coding",
		"--model", "k3",
		"--thinking", "high",
		"--session-dir",
	]);
	assert.ok(!fake.argss[0].includes("-p"), "rpc: sin -p ni prompt por argv");
	assert.equal(proc.spawnOpts.stdio[0], "pipe", "rpc: stdin ES el canal");
	assert.equal(proc.stdinWrites[0], `${JSON.stringify({ type: "prompt", message: "mirá esto" })}\n`);
	fake.emitRpc(proc, { type: "response", command: "prompt", success: true }); // ack
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "primer chunk " } });
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "segundo chunk" } });
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { name: "bash", arguments: {} } } });
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "primer chunk segundo chunk" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0);
	assert.equal(r.output, "primer chunk segundo chunk", "message_end autoritativo");
	assert.ok(proc.exited, "agent_settled → stdin.end() → el proceso sale solo");
});

// El hijo carga las extensiones globales: verify-gate (ID01-454) reinyecta un
// turno de reparación DESPUÉS del agent_settled. Cerrar en el primer settle
// mataría esa reparación a mitad → ventana de gracia (ID01-461).
await test("rpc settle-grace: una reinyección post-settle NO corta el task", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		settleGraceMs: 60,
		settleGraceProbe: () => true, // simula cwd con .pi-verify.json
	});
	const batch = rt.runBatch([{ id: "gate", role: "implement", prompt: "arreglá el bug" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "primer intento" } });
	fake.emitRpc(proc, { type: "agent_settled" }); // gate rojo: acá el runtime NO debe cerrar
	await tick(20); // dentro de la ventana de gracia
	assert.equal(proc.exited, false, "no cerró en el primer settle");
	// verify-gate reinyecta → turno nuevo
	fake.emitRpc(proc, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "[verify-gate] falló" }] } });
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " + reparado" } });
	await tick(100); // la gracia original ya venció: debe haber sido cancelada
	assert.equal(proc.exited, false, "la actividad nueva canceló el cierre");
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "primer intento + reparado" }] } });
	fake.emitRpc(proc, { type: "agent_settled" }); // ahora sí, sin más actividad
	const [r] = await batch;
	assert.equal(r.exitCode, 0);
	assert.equal(r.output, "primer intento + reparado", "conserva el trabajo post-reparación");
	assert.ok(proc.exited, "cerró tras la gracia del segundo settle");
});

await test("rpc sin .pi-verify.json (probe false) → cierra en el primer settle, sin latencia extra", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		settleGraceMs: 60_000, // aunque la gracia sea enorme, el probe la desactiva
		settleGraceProbe: () => false,
	});
	const batch = rt.runBatch([{ id: "x", role: "grunt", prompt: "hola" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0);
	assert.ok(proc.exited);
});

// --- Hallazgos del review adversarial (2026-08-18) ---

await test("rpc: hijo que NO sale al cerrar stdin → reaper TERM→KILL, sin huérfano", async () => {
	const fake = makeFakeSpawn({ hangOnClose: true });
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		killGraceMs: 20,
	});
	const batch = rt.runBatch([{ id: "zombie", role: "grunt", prompt: "p" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "listo" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	await tick(10);
	assert.equal(proc.stdinEnded, true, "cerró stdin");
	assert.equal(proc.exited, false, "el hijo ignora el cierre (simulado)");
	const [r] = await batch; // el reaper lo mata → exit → resuelve
	assert.ok(proc.killSignals.includes("SIGTERM"), `reaper mandó TERM: ${proc.killSignals}`);
	assert.equal(r.exitCode, 0, "exitCode del STREAM, no del proceso terminado");
	assert.equal(r.output, "listo");
});

await test("rpc: EPIPE async al escribir el prompt no tumba el proceso padre", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
	});
	const origSpawn = fake.spawnFn;
	const batch = rt.runBatch([{ id: "epipe", role: "grunt", prompt: "p" }]);
	await tick();
	const proc = fake.procs[0];
	assert.ok(proc.stdin.listenerCount("error") > 0, "hay handler de error en stdin (si no, uncaughtException)");
	proc.stdinBroken = true;
	proc.stdin.write("x"); // dispara EPIPE async
	await tick(5); // si no hubiera handler, acá moriría el proceso
	fake.exitProc(proc, 1);
	const [r] = await batch;
	assert.equal(r.exitCode, 1);
	assert.ok(r.output.includes("PI_SUBAGENTS_CHILD_MODE=print"), "hint de rpc no soportado");
	assert.equal(typeof origSpawn, "function");
});

await test("rpc: settle DESPUÉS del abort por timeout sigue siendo 124, no exit 0", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		killGraceMs: 20,
		timeoutFloorsMs: {},
	});
	const batch = rt.runBatch([{ id: "t", role: "grunt", prompt: "p", timeoutMs: 20 }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "parcial" } });
	await tick(40); // vence el timeout → el runtime manda {"type":"abort"}
	assert.ok(
		proc.stdinWrites.some((w) => w.includes('"abort"')),
		"mandó abort por stdin",
	);
	// el hijo obedece el abort y settlea DENTRO de la ventana previa al SIGTERM
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 124, "el timeout manda por encima del cierre ordenado");
	assert.ok(r.output.includes("timeout tras"), "conserva el mensaje de timeout");
	assert.ok(r.output.includes("parcial"), "y el output parcial del stream");
});

await test("rpc: EPIPE disparado por el propio runtime (abort contra hijo muerto) no rompe nada", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		killGraceMs: 20,
		timeoutFloorsMs: {},
	});
	const batch = rt.runBatch([{ id: "ep", role: "grunt", prompt: "p", timeoutMs: 20 }]);
	await tick();
	const proc = fake.procs[0];
	proc.stdinBroken = true; // el hijo ya no lee: la escritura del runtime dará EPIPE
	await tick(60); // vence el timeout → el RUNTIME escribe el abort → EPIPE async
	fake.exitProc(proc, null, "SIGTERM");
	const [r] = await batch;
	assert.equal(r.exitCode, 124);
	assert.ok(r.output.includes("timeout tras"));
});

await test("rpc: cierre ordenado ANTES del timeout → gana el stream (no 124)", async () => {
	const fake = makeFakeSpawn({ hangOnClose: true });
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		killGraceMs: 30,
		timeoutFloorsMs: {},
	});
	// El task settlea enseguida pero el hijo se cuelga en el shutdown; el timeout
	// vence DESPUÉS de que el cierre ordenado ya arrancó.
	const batch = rt.runBatch([{ id: "slowclose", role: "grunt", prompt: "p", timeoutMs: 40 }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "trabajo completo" }] } });
	fake.emitRpc(proc, { type: "agent_settled" }); // cierre ordenado arranca acá
	const [r] = await batch; // el reaper lo mata tras el timeout
	assert.equal(r.exitCode, 0, "settleó completo antes del timeout: no debe reportarse 124");
	assert.ok(r.output.includes("trabajo completo"));
});

await test("rpc: línea JSONL gigante se descarta sin acumular, y el stream sigue", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
	});
	const batch = rt.runBatch([{ id: "big", role: "grunt", prompt: "p" }]);
	await tick();
	const proc = fake.procs[0];
	// 1.5 MB en una sola línea sin "\n" → supera el cap
	proc.stdout.emit("data", Buffer.from("x".repeat(1_500_000)));
	proc.stdout.emit("data", Buffer.from("basura-final\n")); // cierra la línea gigante
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sigo vivo" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0);
	assert.ok(r.output.includes("sigo vivo"), "el stream siguió tras la línea gigante");
	assert.ok(r.output.includes("descartado"), "el descarte NO es silencioso (se reporta en el output)");
	assert.ok(!r.output.includes("xxxxxxxxxx"), "la línea gigante no entró al output");
});

await test("rpc: error transitorio seguido de mensaje nuevo NO reporta exitCode 1", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
	});
	const batch = rt.runBatch([{ id: "retry", role: "grunt", prompt: "p" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "error", reason: "error", error: { message: "429 rate limit" } } });
	fake.emitRpc(proc, { type: "message_start", message: { role: "assistant", content: [] } }); // pi reintenta
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "salió bien" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0, "el error transitorio no debe marcar el task como fallado");
	assert.equal(r.output, "salió bien");
});

await test("rpc: turno multi-mensaje (post-reparación) conserva TODO el texto", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
	});
	const batch = rt.runBatch([{ id: "multi", role: "grunt", prompt: "p" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "parte 1" }] } });
	fake.emitRpc(proc, { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "ruido de tool" }] } });
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "parte 2" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.output, "parte 1\nparte 2", "acumula assistant, ignora toolResult");
});

await test("rpc: la gracia se cancela con CUALQUIER evento, no solo con los 3 de la whitelist", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		settleGraceMs: 50,
		settleGraceProbe: () => true,
	});
	const batch = rt.runBatch([{ id: "g", role: "implement", prompt: "p" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "agent_settled" });
	await tick(20);
	fake.emitRpc(proc, { type: "tool_execution_end", toolCallId: "1", toolName: "bash" }); // NO estaba en la whitelist vieja
	await tick(60); // la gracia original ya habría vencido
	assert.equal(proc.exited, false, "un evento fuera de la whitelist vieja cancela igual");
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "reparado" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.output, "reparado");
});

await test("rpc parser tolerante: chunk partido a la mitad + línea basura no-JSON", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, mkdirSessionDir: () => {}, rmSessionDir: () => {} });
	const batch = rt.runBatch([{ id: "p1", prompt: "x" }]);
	await tick();
	const proc = fake.procs[0];
	const line = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hola rpc" } });
	proc.stdout.emit("data", Buffer.from(line.slice(0, 15))); // media línea, sin \n
	proc.stdout.emit("data", Buffer.from(line.slice(15) + "\n")); // el resto
	proc.stdout.emit("data", Buffer.from("WARNING pi: basura no json\n")); // warning, skip
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0);
	assert.equal(r.output, "hola rpc");
});

await test("rpc actividad: heartbeat la incluye, update inmediato al cambiar, thinking oculto", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, heartbeatMs: 10, activityThrottleMs: 0, timeoutFloorsMs: {} });
	const updates = [];
	const batch = rt.runBatch([{ id: "act1", role: "review", prompt: "x" }], {
		onUpdate: (u) => updates.push(u.content[0].text),
	});
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "leyendo el parser de jsonl" } });
	// throttle 0 → update inmediato, sin esperar al heartbeat
	assert.ok(
		updates.some((t) => t.includes("act1") && t.includes("— leyendo el parser de jsonl")),
		`update inmediato con actividad, hubo: ${JSON.stringify(updates)}`,
	);
	// thinking_delta NO es actividad
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "PENSAMIENTO SECRETO" } });
	assert.ok(!updates.some((t) => t.includes("PENSAMIENTO")), "el thinking no se muestra");
	await tick(25); // al menos un heartbeat con la actividad rodante
	const beats = updates.filter((t) => t.includes("⏳") && t.includes("done,"));
	assert.ok(beats.some((t) => t.includes("act1") && t.includes("— leyendo el parser de jsonl")), `heartbeat con actividad: ${JSON.stringify(beats)}`);
	// tool en curso → ⚙ nombre
	fake.emitRpc(proc, { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
	assert.ok(updates.some((t) => t.includes("act1") && t.includes("— ⚙ bash")), "actividad de tool");
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "listo" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0);
	assert.equal(r.output, "listo");
});

await test("rpc error: assistantMessageEvent error → exitCode 1 con el motivo", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, mkdirSessionDir: () => {}, rmSessionDir: () => {} });
	const batch = rt.runBatch([{ id: "e1", prompt: "x" }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "arrancó" } });
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "error", error: { message: "boom modelo" } } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 1);
	assert.ok(r.output.includes("boom modelo"), "el motivo va en el output");
	assert.ok(r.output.includes("arrancó"), "el texto parcial se conserva");
});

await test("rpc timeout: abort por stdin ANTES del SIGTERM y output parcial conservado", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 20, timeoutFloorsMs: {} });
	const batch = rt.runBatch([{ id: "slowrpc", prompt: "colgado", timeoutMs: 25 }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "parcial rpc" } });
	const [r] = await batch;
	assert.equal(r.exitCode, 124);
	assert.ok(proc.stdinWrites.includes('{"type":"abort"}\n'), "abort amable por el canal");
	assert.equal(proc.writesAtFirstKill, 2, "prompt + abort escritos antes del SIGTERM");
	assert.deepEqual(proc.killSignals, ["SIGTERM"], "el fake sale con TERM (no cuelga)");
	assert.ok(r.output.includes("parcial rpc"), "en rpc el output parcial SÍ se conserva");
	assert.match(r.output, /timeout tras \d+s/);
	assert.ok(!r.output.includes("modo -p"), "mensaje adaptado a rpc");
});

// ---------- E2E (opt-in) ----------
if (process.env.SUBAGENTS_E2E === "1") {
	await test("E2E: 3 tasks grunt paralelos, exit 0, wall ≈ max no suma", async () => {
		const rt = createSubagentsRuntime();
		const t0 = Date.now();
		const results = await rt.runBatch([
			{ id: "a", role: "grunt", prompt: "respondé solo el número 7" },
			{ id: "b", role: "grunt", prompt: "respondé solo el número 7" },
			{ id: "c", role: "grunt", prompt: "respondé solo el número 7" },
		]);
		const wall = Date.now() - t0;
		const sum = results.reduce((s, r) => s + r.durationMs, 0);
		console.log(`     wall=${wall}ms suma_tasks=${sum}ms`);
		assert.equal(results.length, 3);
		assert.ok(results.every((r) => r.exitCode === 0), JSON.stringify(results.map((r) => [r.id, r.exitCode])));
		assert.ok(wall < sum, "el wall clock debe aproximar el max, no la suma");
	});
} else {
	console.log("skip E2E (SUBAGENTS_E2E != 1)");
}

await test("id con path traversal se rechaza antes de spawn", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn });
	await assert.rejects(
		() => rt.runBatch([{ id: "../../etc", prompt: "x" }]),
		/id ".*" inválido/,
	);
	await assert.rejects(
		() => rt.runBatch([{ id: "a/b", prompt: "x" }]),
		/inválido/,
	);
	assert.equal(fake.argss.length, 0);
});

await test("PI_SUBAGENTS_MAX_COST_USD se relee por batch (no al crear el runtime)", async () => {
	const fake = makeFakeSpawn();
	const env = {};
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		concurrency: 1,
		env,
		readSessionUsage: () => ({ input: 1, output: 1, cacheRead: 0, costUsd: 0.02 }),
	});
	const first = rt.runBatch([{ id: "a1", prompt: "1" }, { id: "a2", prompt: "2" }]);
	await tick();
	fake.finishProc(fake.procs[0], 0);
	await tick();
	fake.finishProc(fake.procs[1], 0);
	const r1 = await first;
	assert.equal(r1.filter((x) => x.skipped).length, 0, "sin tope: los 2 corren");
	env.PI_SUBAGENTS_MAX_COST_USD = "0.01";
	const second = rt.runBatch([{ id: "b1", prompt: "1" }, { id: "b2", prompt: "2" }]);
	await tick();
	fake.finishProc(fake.procs[2], 0);
	const r2 = await second;
	assert.equal(fake.argss.length, 3, "con tope solo spawnó b1 (a1+a2+b1)");
	assert.equal(r2[1].skipped, "budget");
});

// ---------- ID01-482: viz en la app (líneas machine-readable + transcriptRoot) ----------

await test("resolveTranscriptRoot: deps.sessionRoot > PI_SUBAGENTS_TRANSCRIPT_ROOT > default", () => {
	assert.equal(resolveTranscriptRoot({ sessionRoot: "/a" }, { PI_SUBAGENTS_TRANSCRIPT_ROOT: "/b" }), "/a");
	assert.equal(resolveTranscriptRoot({}, { PI_SUBAGENTS_TRANSCRIPT_ROOT: "/b" }), "/b");
	assert.equal(resolveTranscriptRoot({}, { PI_SUBAGENTS_TRANSCRIPT_ROOT: "  " }), DEFAULT_TRANSCRIPT_ROOT, "env vacío → default");
	assert.equal(resolveTranscriptRoot({}, {}), DEFAULT_TRANSCRIPT_ROOT);
	assert.ok(
		DEFAULT_TRANSCRIPT_ROOT.endsWith(path.join(".pi", "agent", "subagent-transcripts")),
		DEFAULT_TRANSCRIPT_ROOT,
	);
	assert.equal(SESSION_DIR_RM_DELAY_MS >= 2500, true, "cubre el drain del engine (6×200ms) + margen");
});

await test("childSessionIdFor + formatSpawnedLine/formatFinishedLine: formato congelado", () => {
	assert.equal(childSessionIdFor("t1", "123-5000-1"), "t1-123-5000-1");
	assert.equal(
		formatSpawnedLine("t1", "research", "alibaba/qwen3.8-max", "t1-123-5000-1"),
		"subagent_spawned: t1 role: research model: alibaba/qwen3.8-max child_session_id: t1-123-5000-1",
	);
	assert.equal(formatFinishedLine("t1", "interrupted"), "subagent_finished: t1 status: interrupted");
});

await test("finishStatusFor: 0→completed, 124→interrupted, 125/budget→interrupted, -1→error, otro→failed", () => {
	assert.equal(finishStatusFor({ exitCode: 0 }), "completed");
	assert.equal(finishStatusFor({ exitCode: 124 }), "interrupted");
	assert.equal(finishStatusFor({ exitCode: 125, skipped: "budget" }), "interrupted");
	assert.equal(finishStatusFor({ exitCode: -1 }), "error");
	assert.equal(finishStatusFor({ exitCode: 3 }), "failed");
});

await test("runBatch: spawned/finished lines + sessionDir {transcriptRoot}/{id}-{batchKey} + progressLine en el mismo update", async () => {
	const fake = makeFakeSpawn();
	const updates = [];
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/tr",
		childMode: "print",
		now: () => 7777,
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
	});
	const batch = rt.runBatch(
		[{ id: "t1", role: "research", prompt: "a" }, { id: "t2", role: "research", prompt: "b" }],
		{ onUpdate: (u) => updates.push(u.content[0].text) },
	);
	for (let i = 0; fake.procs.some((p) => !p.exited) && i < 40; i++) {
		const pending = fake.procs.find((p) => !p.exited);
		if (pending) fake.finishProc(pending, 0);
		await tick();
	}
	const results = await batch;
	const batchKey = `${process.pid}-7777-1`;
	const machineLines = updates.flatMap((t) => t.split("\n").filter((l) => l.startsWith("subagent_")));
	const spawned = machineLines.filter((l) => l.startsWith("subagent_spawned: "));
	assert.deepEqual(spawned, [
		`subagent_spawned: t1 role: research model: alibaba/qwen3.8-max child_session_id: t1-${batchKey}`,
		`subagent_spawned: t2 role: research model: alibaba/qwen3.8-max child_session_id: t2-${batchKey}`,
	], JSON.stringify(updates));
	const finished = machineLines.filter((l) => l.startsWith("subagent_finished: "));
	assert.deepEqual(finished.sort(), [
		"subagent_finished: t1 status: completed",
		"subagent_finished: t2 status: completed",
	].sort());
	// sessionDir: --session-dir = {transcriptRoot}/{child_session_id}
	const dirs = fake.argss.map((a) => a[a.indexOf("--session-dir") + 1]);
	assert.deepEqual(
		[...dirs].sort(),
		[path.join("/fake/tr", `t1-${batchKey}`), path.join("/fake/tr", `t2-${batchKey}`)].sort(),
		JSON.stringify(dirs),
	);
	// finished viaja EN EL MISMO update que el progressLine humano
	const t1done = updates.find((t) => t.includes("subagent_finished: t1"));
	assert.match(t1done, /^subagents: t1\/2 done/);
	// timeout → interrupted
	assert.ok(results.every((r) => r.exitCode === 0));
});

await test("delay-rm: NO inmediato tras el finish; sí tras sessionRmDelayMs", async () => {
	const fake = makeFakeSpawn();
	const rms = [];
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		sessionRoot: "/fake/tr",
		childMode: "print",
		sessionRmDelayMs: 60,
		mkdirSessionDir: () => {},
		rmSessionDir: (d) => rms.push(d),
	});
	const batch = rt.runBatch([{ id: "zz", prompt: "x" }]);
	await tick();
	fake.finishProc(fake.procs[0], 3);
	const [r] = await batch;
	assert.equal(r.exitCode, 3);
	assert.equal(rms.length, 0, "no inmediato: el engine drena el JSONL primero");
	await tick(150);
	assert.ok(rms.some((d) => d.includes(`${path.sep}zz-`)), `delay-rm: ${JSON.stringify(rms)}`);
});

// ---------- ID01-484: timeout por inactividad, no por reloj ----------

await test("484: hijo que EMITE más allá del pedido lowball del LLM no muere (el piso protege el cap)", async () => {
	// Regresión ID01-482: el orquestador pasaba exactamente el piso viejo y el
	// hijo moría trabajando. Con pisos-de-cap generosos, el pedido bajo se
	// clampea y la actividad sostiene al hijo.
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		timeoutFloorsMs: { grunt: 300 },
		inactivityMs: 5_000,
	});
	const batch = rt.runBatch([{ id: "worker", role: "grunt", prompt: "p", timeoutMs: 80 }]);
	await tick();
	const proc = fake.procs[0];
	const feeder = setInterval(() => {
		if (!proc.exited) fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." } });
	}, 20);
	await tick(150); // ya pasó el pedido de 80ms; el cap real es 300 (piso)
	assert.equal(proc.exited, false, "sigue vivo pasado el pedido lowball");
	clearInterval(feeder);
	fake.emitRpc(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "listo" }] } });
	fake.emitRpc(proc, { type: "agent_settled" });
	const [r] = await batch;
	assert.equal(r.exitCode, 0, "terminó bien: la actividad lo sostuvo dentro del cap");
});

await test("484: hijo MUDO muere por inactividad con diagnóstico distinguible", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		timeoutFloorsMs: {},
		inactivityMs: 60,
		killGraceMs: 30,
	});
	const batch = rt.runBatch([{ id: "mudo", role: "grunt", prompt: "p", timeoutMs: 30_000 }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "response", command: "prompt", success: true }); // un evento y silencio
	const [r] = await batch; // inactividad → abort → reap → exit
	assert.equal(r.exitCode, 124);
	assert.ok(r.output.includes("INACTIVIDAD"), `diagnóstico de cuelgue: ${r.output.slice(-160)}`);
	assert.ok(!r.output.includes("cap duro"), "no confunde la causa");
});

await test("484: parlanchín infinito muere al CAP con diagnóstico de cap", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		timeoutFloorsMs: {},
		inactivityMs: 500,
		killGraceMs: 30,
	});
	const batch = rt.runBatch([{ id: "loop", role: "grunt", prompt: "p", timeoutMs: 120 }]);
	await tick();
	const proc = fake.procs[0];
	const feeder = setInterval(() => {
		if (!proc.exited) fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } });
	}, 15);
	const [r] = await batch; // cap 120ms pese a la actividad constante
	clearInterval(feeder);
	assert.equal(r.exitCode, 124);
	assert.ok(r.output.includes("cap duro"), `diagnóstico de cap: ${r.output.slice(-160)}`);
	assert.ok(!r.output.includes("INACTIVIDAD"), "no confunde la causa");
});

// ---------- ID01-484 round 2 (hallazgos del review k3) ----------

await test("484r2: resolveInactivityMs — knob PI_SUBAGENTS_INACTIVITY_MS (0 deshabilita; inválido → default)", () => {
	assert.equal(resolveInactivityMs({}), INACTIVITY_TIMEOUT_MS, "sin env → default");
	assert.equal(resolveInactivityMs({ PI_SUBAGENTS_INACTIVITY_MS: "120000" }), 120_000, "env válido manda");
	assert.equal(resolveInactivityMs({ PI_SUBAGENTS_INACTIVITY_MS: "0" }), 0, "0 = deshabilitar");
	assert.equal(resolveInactivityMs({ PI_SUBAGENTS_INACTIVITY_MS: "banana" }), INACTIVITY_TIMEOUT_MS, "inválido → default");
	assert.equal(resolveInactivityMs({ PI_SUBAGENTS_INACTIVITY_MS: "-5" }), INACTIVITY_TIMEOUT_MS, "negativo → default");
	assert.equal(resolveInactivityMs({ PI_SUBAGENTS_INACTIVITY_MS: "" }), INACTIVITY_TIMEOUT_MS, "vacío → default");
});

await test("484r2: tool en vuelo exime de inactividad — el silencio de un cargo build no mata; el cap sí", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		timeoutFloorsMs: {},
		inactivityMs: 60,
		killGraceMs: 30,
	});
	const batch = rt.runBatch([{ id: "builder", role: "grunt", prompt: "p", timeoutMs: 400 }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "tool_execution_start", toolName: "bash" }); // tool arranca y enmudece
	await tick(200); // 200ms de silencio ≫ inactivityMs=60
	assert.equal(proc.exited, false, "el silencio dentro del tool NO dispara inactividad");
	const [r] = await batch; // el cap (400ms) lo corta
	assert.equal(r.exitCode, 124);
	assert.ok(r.output.includes("cap duro"), `lo mató el cap, no la inactividad: ${r.output.slice(-160)}`);
	assert.ok(!r.output.includes("INACTIVIDAD"), "no confunde la causa");
});

await test("484r2: toolcall_end re-arma la inactividad — silencio POST-tool sí mata", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/s",
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
		timeoutFloorsMs: {},
		inactivityMs: 60,
		killGraceMs: 30,
	});
	const batch = rt.runBatch([{ id: "posttool", role: "grunt", prompt: "p", timeoutMs: 30_000 }]);
	await tick();
	const proc = fake.procs[0];
	fake.emitRpc(proc, { type: "tool_execution_start", toolName: "bash" });
	fake.emitRpc(proc, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash" } } });
	const [r] = await batch; // tool cerrado + silencio → inactividad
	assert.equal(r.exitCode, 124);
	assert.ok(r.output.includes("INACTIVIDAD"), `cuelgue post-tool detectado: ${r.output.slice(-160)}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.error(failures.map((f) => `  ${f.name}: ${f.err.stack}`).join("\n"));
	process.exit(1);
}
