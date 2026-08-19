/**
 * Unit tests — utility-guard (ID01-491).
 * Sin framework: `node tooling/pi-extensions/utility-guard.test.mjs`
 */
import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as url from "node:url";

const here = import.meta.dirname;
const mod = await import(url.pathToFileURL(path.join(here, "utility-guard.ts")).href);
const { installUtilityGuard, UTILITY_PROMPT_PREFIX, BLOCK_REASON } = mod;

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		failures.push({ name, err });
		console.log(`FAIL ${name}`);
	}
}

function makeFakePi() {
	const handlers = {};
	const pi = {
		on(ev, fn) {
			handlers[ev] = fn;
		},
	};
	return { pi, handlers };
}

function install() {
	const { pi, handlers } = makeFakePi();
	installUtilityGuard(pi);
	return { pi, handlers };
}

const TITLE_PROMPT = `${UTILITY_PROMPT_PREFIX} in Title Case (no quotes, no punctuation) for a coding session that begins with this request:\n\nImplementá el issue ID01-488...`;

await test("sesión de titulado: TODO tool_call se bloquea SIN terminate (el modelo debe converger al texto)", () => {
	const { handlers } = install();
	handlers.input({ text: TITLE_PROMPT, source: "rpc" });
	for (const toolName of ["bash", "edit", "write", "subagents", "read"]) {
		const r = handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName, input: {} });
		assert.equal(r.block, true, `${toolName} bloqueada`);
		assert.equal(r.terminate, undefined, `${toolName} sin terminate: título vacío si corta el turno (hallazgo k3)`);
		assert.equal(r.reason, BLOCK_REASON);
	}
});

await test("sesión normal: tool_call pasa (undefined)", () => {
	const { handlers } = install();
	handlers.input({ text: "Implementá el issue ID01-488 como hablamos", source: "rpc" });
	const r = handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "bash", input: {} });
	assert.equal(r, undefined);
});

await test("first-input-only: el prefijo en un mensaje POSTERIOR no envenena", () => {
	const { handlers } = install();
	handlers.input({ text: "Arranquemos con el issue", source: "rpc" });
	handlers.input({ text: `${UTILITY_PROMPT_PREFIX} for this PR`, source: "rpc" });
	const r = handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "edit", input: {} });
	assert.equal(r, undefined, "gate no activado por el segundo mensaje");
});

await test("session_start resetea el estado: /new tras un titulado re-evalúa su primer input", () => {
	const { handlers } = install();
	handlers.session_start({ type: "session_start" });
	handlers.input({ text: TITLE_PROMPT, source: "rpc" });
	assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "bash", input: {} }).block, true);
	// nueva sesión en el MISMO proceso → estado limpio
	handlers.session_start({ type: "session_start" });
	handlers.input({ text: "Tarea real de usuario", source: "rpc" });
	assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "bash", input: {} }), undefined);
	// y al revés: sesión normal → /new → titulado, el gate se activa
	handlers.session_start({ type: "session_start" });
	handlers.input({ text: TITLE_PROMPT, source: "rpc" });
	assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "edit", input: {} }).block, true);
});

await test("tool_call ANTES de cualquier input pasa; input sin text no rompe", () => {
	const { handlers } = install();
	assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "bash", input: {} }), undefined);
	handlers.input({ images: [], source: "rpc" }); // sin text
	assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName: "bash", input: {} }), undefined);
});

await test("superficie: registra exactamente session_start, input y tool_call", () => {
	const { handlers } = install();
	assert.deepEqual(Object.keys(handlers).sort(), ["input", "session_start", "tool_call"]);
});

await test("anti-drift: el prefijo es idéntico al del gate interno de subagents.ts", async () => {
	const sib = await import(url.pathToFileURL(path.join(here, "subagents.ts")).href);
	assert.equal(UTILITY_PROMPT_PREFIX, sib.UTILITY_PROMPT_PREFIX, "los dos espejos de TITLE_PROMPT_PREFIX deben coincidir");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.error(failures.map((f) => `  ${f.name}: ${f.err.stack}`).join("\n"));
	process.exit(1);
}
