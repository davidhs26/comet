/**
 * Unit tests — subagents (ID01-432, SPEC-subagents-1).
 * Sin framework: `node tooling/pi-extensions/subagents.test.mjs`
 * E2E (caro/quota, NO gate): `SUBAGENTS_E2E=1 node tooling/pi-extensions/subagents.test.mjs`
 */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as url from "node:url";

const here = import.meta.dirname;
const mod = await import(url.pathToFileURL(path.join(here, "subagents.ts")).href);
const { resolveRoute, canSpawn, assertReviewerDistinct, trimTail, createSubagentsRuntime, ROUTES, modelKey } = mod;

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

await test("spawn args: PI absoluto + flags del spec + env hijo PI_SUBAGENT_DEPTH=1", async () => {
	const fake = makeFakeSpawn();
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, piBin: "/fake/pi" });
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
		"-p", "--no-session", "mirá",
	]);
	assert.equal(proc.spawnOpts.env.PI_SUBAGENT_DEPTH, "1");
	assert.equal(proc.spawnOpts.stdio[0], "ignore");
});

// ---------- timeout ----------
await test("timeout: TERM ignorado → KILL → exitCode ≠ 0 y el batch sigue", async () => {
	const fake = makeFakeSpawn({ hangOnTerm: true });
	const rt = createSubagentsRuntime({ spawnFn: fake.spawnFn, killGraceMs: 20 });
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
	assert.equal(results.find((r) => r.id === "fast").exitCode, 0, "un fallo no tumba el batch");
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.error(failures.map((f) => `  ${f.name}: ${f.err.stack}`).join("\n"));
	process.exit(1);
}
