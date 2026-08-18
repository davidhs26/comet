/**
 * Unit tests — subagents (ID01-432 + ID01-433, SPEC-subagents-1/2).
 * Sin framework: `node tooling/pi-extensions/subagents.test.mjs`
 * E2E (caro/quota, NO gate): `SUBAGENTS_E2E=1 node tooling/pi-extensions/subagents.test.mjs`
 */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as url from "node:url";

// El harness de subagentes setea PI_SUBAGENT_DEPTH=1; sin esto los tests que
// no inyectan env heredan process.env y canSpawn rechaza el batch.
delete process.env.PI_SUBAGENT_DEPTH;

const here = import.meta.dirname;
const mod = await import(url.pathToFileURL(path.join(here, "subagents.ts")).href);
const { resolveRoute, canSpawn, assertReviewerDistinct, trimTail, createSubagentsRuntime, ROUTES, modelKey, chooseDeliverAs, formatSubagentResult, installSubagents, sumUsage, usageFromSessionJsonl, parseMaxCostUsd, formatBatchSummary, effectiveTimeoutMs, ROLE_TIMEOUT_FLOOR_MS } = mod;

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

/** Fake de child_process.spawn: cuenta concurrencia, exit manual. */
function makeFakeSpawn({ hangOnTerm = false } = {}) {
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
		proc.kill = (signal) => {
			if (hangOnTerm && signal === "SIGTERM") return true; // simula proceso que ignora TERM
			if (!proc.exited) state.finishProc(proc, null, signal);
			return true;
		};
		state.procs.push(proc);
		return proc;
	};
	state.finishProc = (proc, code = 0, signal = null, out = "ok") => {
		if (proc.exited) return;
		if (out) proc.stdout.emit("data", Buffer.from(out));
		proc.exited = true;
		state.concurrent--;
		proc.emit("exit", code, signal);
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
	const rt = createSubagentsRuntime({
		spawnFn: fake.spawnFn,
		piBin: "/fake/pi",
		sessionRoot: "/fake/sessions",
		now: () => 5000,
		mkdirSessionDir: () => {},
		rmSessionDir: () => {},
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
		"-p", "--session-dir", `/fake/sessions/${process.pid}-5000-1/t1`, "mirá",
	]);
	assert.ok(!fake.argss[0].includes("--no-session"), "434: ya no se pasa --no-session");
	assert.equal(proc.spawnOpts.env.PI_SUBAGENT_DEPTH, "1");
	assert.equal(proc.spawnOpts.stdio[0], "ignore");
});

// ---------- timeout ----------
await test("timeout: TERM ignorado → KILL → exitCode ≠ 0 y el batch sigue", async () => {
	const fake = makeFakeSpawn({ hangOnTerm: true });
	// timeoutFloorsMs: {} deshabilita el clamp por rol para poder testear con ms.
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 20, timeoutFloorsMs: {} });
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

// ---------- pisos de timeout por rol (directiva 2026-08-18) ----------
await test("effectiveTimeoutMs: clamp al piso del rol; sin pedido usa default", () => {
	assert.equal(effectiveTimeoutMs("review", 300_000), 600_000, "review no puede bajar de 10 min");
	assert.equal(effectiveTimeoutMs("implement", 300_000), 900_000, "implement no puede bajar de 15 min");
	assert.equal(effectiveTimeoutMs("grunt", 60_000), 300_000, "grunt no puede bajar de 5 min");
	assert.equal(effectiveTimeoutMs("review", 1_200_000), 1_200_000, "subir sí se puede");
	assert.equal(effectiveTimeoutMs("grunt", undefined), 900_000, "sin pedido → default 15 min");
	assert.equal(effectiveTimeoutMs("review", 25, {}), 25, "floors {} deshabilita el clamp (tests)");
	assert.equal(ROLE_TIMEOUT_FLOOR_MS.hard, 900_000);
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

await test("chooseDeliverAs: agente vivo → steer, idle → nextTurn", () => {
	assert.equal(chooseDeliverAs(true), "steer");
	assert.equal(chooseDeliverAs(false), "nextTurn");
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

await test("installSubagents: steer si live, nextTurn si idle, nada post-shutdown", async () => {
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
	assert.equal(sent[1].opts.deliverAs, "nextTurn");

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
	assert.match(updates[0], /t1\/1 done · exit 0 · [\d.]+s · \$0\.01 · alibaba\/qwen3\.8-max/);
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

await test("rmSessionDir se llama aunque el child salga ≠ 0", async () => {
	const rms = [];
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, mkdirSessionDir: () => {}, rmSessionDir: (d) => rms.push(d) });
	const batch = rt.runBatch([{ id: "bad", prompt: "x" }]);
	await tick();
	fake.finishProc(fake.procs[0], 3); // exit ≠ 0
	const [r] = await batch;
	assert.equal(r.exitCode, 3);
	assert.ok(rms.some((d) => /[\\/]bad$/.test(d)), `task dir en ${JSON.stringify(rms)}`);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.error(failures.map((f) => `  ${f.name}: ${f.err.stack}`).join("\n"));
	process.exit(1);
}
