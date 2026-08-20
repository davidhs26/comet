/**
 * Test de integración del wrapper: registra la tool vía un mock mínimo de
 * ExtensionAPI y ejecuta contra el built-in REAL (createEditToolDefinition)
 * sobre archivos temporales.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import editCoach from "./edit-coach.ts";

function createMockPi() {
	const tools = new Map();
	return {
		tools,
		pi: {
			registerTool(def) {
				tools.set(def.name, def);
			},
		},
	};
}

async function withTempDir(fn) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "edit-coach-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("la extensión registra una tool llamada 'edit' (override del built-in)", () => {
	const { tools, pi } = createMockPi();
	editCoach(pi);
	const tool = tools.get("edit");
	assert.ok(tool, "no se registró la tool edit");
	assert.equal(tool.name, "edit");
	assert.equal(typeof tool.execute, "function");
	assert.match(tool.description, /exact text replacement/);
});

test("edit exitoso: comportamiento INTACTO (mismo resultado, archivo modificado)", async () => {
	await withTempDir(async (dir) => {
		const { tools, pi } = createMockPi();
		editCoach(pi);
		const tool = tools.get("edit");
		const file = path.join(dir, "ok.js");
		await writeFile(file, "const a = 1;\nconst b = 2;\n");
		const result = await tool.execute(
			"t1",
			{ path: "ok.js", edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(result.content[0].text, /Successfully replaced 1 block\(s\) in ok\.js\./);
		assert.ok(result.details.patch);
		assert.equal(await readFile(file, "utf8"), "const a = 42;\nconst b = 2;\n");
	});
});

test("mismatch: el error se enriquece con closest match + diagnóstico", async () => {
	await withTempDir(async (dir) => {
		const { tools, pi } = createMockPi();
		editCoach(pi);
		const tool = tools.get("edit");
		await writeFile(file_path(dir), "header();\n    const x = 1;\n    return x;\nfooter();\n");
		const err = await tool
			.execute(
				"t2",
				{
					path: "code.js",
					edits: [{ oldText: "  const x = 1;\n  return x;", newText: "return 0;" }],
				},
				undefined,
				undefined,
				{ cwd: dir },
			)
			.then(() => null, (e) => e);
		assert.ok(err instanceof Error);
		// Mensaje original preservado al inicio
		assert.match(err.message, /^Could not find the exact text in code\.js\./);
		// Bloque coach
		assert.match(err.message, /\[edit-coach\] Bloque más parecido en code\.js \(líneas 2-3/);
		assert.match(err.message, /2 \|     const x = 1;/);
		assert.match(err.message, /-  const x = 1;/);
		assert.match(err.message, /\+    const x = 1;/);
		assert.match(err.message, /Diagnóstico: indentation/);
	});

	function file_path(dir) {
		return path.join(dir, "code.js");
	}
});

test("mismatch multi-edit: usa el oldText del edits[i] que falló", async () => {
	await withTempDir(async (dir) => {
		const { tools, pi } = createMockPi();
		editCoach(pi);
		const tool = tools.get("edit");
		await writeFile(
			path.join(dir, "multi.js"),
			"const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
		);
		const err = await tool
			.execute(
				"t3",
				{
					path: "multi.js",
					edits: [
						{ oldText: "const a = 1;", newText: "const a = 10;" },
						{ oldText: "const c = 3;\nconst d = 999;", newText: "const c = 30;" },
					],
				},
				undefined,
				undefined,
				{ cwd: dir },
			)
			.then(() => null, (e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Could not find edits\[1\] in multi\.js\./);
		assert.match(err.message, /\[edit-coach\] Bloque más parecido en multi\.js \(líneas 3-4/);
		assert.match(err.message, /-const d = 999;/);
		assert.match(err.message, /\+const d = 4;/);
		assert.match(err.message, /Diagnóstico: content-drift/);
	});
});

test("error NO-mismatch pasa intacto (archivo inexistente)", async () => {
	await withTempDir(async (dir) => {
		const { tools, pi } = createMockPi();
		editCoach(pi);
		const tool = tools.get("edit");
		const err = await tool
			.execute(
				"t4",
				{ path: "no-existe.js", edits: [{ oldText: "x", newText: "y" }] },
				undefined,
				undefined,
				{ cwd: dir },
			)
			.then(() => null, (e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Could not edit file: no-existe\.js\./);
		assert.doesNotMatch(err.message, /edit-coach/);
	});
});

test("mismatch sin nada parecido: coach reporta not-found, sin romper", async () => {
	await withTempDir(async (dir) => {
		const { tools, pi } = createMockPi();
		editCoach(pi);
		const tool = tools.get("edit");
		await writeFile(path.join(dir, "plain.js"), "alpha\nbeta\ngamma\n");
		const err = await tool
			.execute(
				"t5",
				{ path: "plain.js", edits: [{ oldText: "zzz\nyyy\nxxx", newText: "n" }] },
				undefined,
				undefined,
				{ cwd: dir },
			)
			.then(() => null, (e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Could not find the exact text in plain\.js\./);
		assert.match(err.message, /\[edit-coach\] No se encontró ningún bloque similar/);
	});
});
