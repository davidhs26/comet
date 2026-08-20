import assert from "node:assert/strict";
import { test } from "node:test";
import {
	EXCERPT_CAP_BYTES,
	buildCoachMessage,
	findClosestMatch,
} from "./edit-core.mjs";

test("indentation: mismo contenido, distinta indentación", () => {
	const file = ["header();", "    const x = 1;", "    return x;", "footer();", ""].join("\n");
	const oldString = "  const x = 1;\n  return x;";
	const r = findClosestMatch(file, oldString);
	assert.equal(r.found, true);
	assert.equal(r.lineStart, 2);
	assert.equal(r.lineEnd, 3);
	assert.equal(r.score, 1);
	assert.equal(r.diagnosis, "indentation");
	assert.match(r.excerpt, /2 \|     const x = 1;/);
	assert.match(r.miniDiff, /-  const x = 1;/);
	assert.match(r.miniDiff, /\+    const x = 1;/);
	const msg = buildCoachMessage("Could not find the exact text in f.js.", r, { path: "f.js" });
	assert.match(msg, /^Could not find the exact text in f\.js\./);
	assert.match(msg, /difiere SOLO en la indentación/);
	assert.match(msg, /\[edit-coach\]/);
});

test("whitespace: difiere solo en espacios internos", () => {
	const file = "const  x = 1;\nconst y = 2;\n";
	const r = findClosestMatch(file, "const x = 1;");
	assert.equal(r.found, true);
	assert.equal(r.lineStart, 1);
	assert.equal(r.diagnosis, "whitespace");
	const msg = buildCoachMessage("err", r);
	assert.match(msg, /difiere SOLO en whitespace/);
});

test("contenido movido y con drift: localiza el bloque y diagnostica content-drift", () => {
	const file = [
		"import a;",
		"import b;",
		"function foo() {",
		"  return 2;",
		"}",
		"const z = 9;",
		"",
	].join("\n");
	// El modelo cree que foo devuelve 1 (el archivo cambió a 2)
	const oldString = "function foo() {\n  return 1;\n}";
	const r = findClosestMatch(file, oldString);
	assert.equal(r.found, true);
	assert.equal(r.lineStart, 3);
	assert.equal(r.lineEnd, 5);
	assert.equal(r.diagnosis, "content-drift");
	assert.match(r.miniDiff, /-  return 1;/);
	assert.match(r.miniDiff, /\+  return 2;/);
	const msg = buildCoachMessage("err", r);
	assert.match(msg, /el contenido real difiere/);
});

test("no-existe: nada parecido → not-found", () => {
	const file = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
	const r = findClosestMatch(file, "completamente distinto\nnada que ver\nzzz");
	assert.equal(r.found, false);
	assert.equal(r.diagnosis, "not-found");
	const msg = buildCoachMessage("err", r, { path: "x.ts" });
	assert.match(msg, /^err/);
	assert.match(msg, /no hay ningún bloque parecido/);
});

test("archivo enorme: excerpt capped a 2KB", () => {
	const longLine = "x".repeat(180);
	const fileLines = Array.from({ length: 500 }, (_, i) => `${longLine}${i}`);
	const file = fileLines.join("\n");
	// oldString: 40 líneas reales del medio, con una cambiada
	const oldLines = fileLines.slice(100, 140);
	oldLines[10] = "LINEA-CAMBIADA";
	const r = findClosestMatch(file, oldLines.join("\n"));
	assert.equal(r.found, true);
	assert.equal(r.lineStart, 101);
	const bytes = Buffer.byteLength(r.excerpt, "utf8");
	assert.ok(bytes <= EXCERPT_CAP_BYTES + 80, `excerpt ${bytes} bytes excede cap + marcador`);
	assert.match(r.excerpt, /excerpt truncado a 2048 bytes/);
});

test("empate: gana la PRIMERA ventana y se reporta multiple-partial", () => {
	const block = "const a = 1;\nconst b = 2;";
	const file = ["// primero", block, "// medio", block, "// ultimo", ""].join("\n");
	const r = findClosestMatch(file, block);
	assert.equal(r.found, true);
	assert.equal(r.lineStart, 2); // primera ventana empatada, no la segunda (línea 5)
	assert.equal(r.score, 1);
	assert.equal(r.candidateCount, 2);
	assert.equal(r.diagnosis, "multiple-partial");
	// Determinismo: misma entrada → misma salida
	const r2 = findClosestMatch(file, block);
	assert.deepEqual(r2, r);
	const msg = buildCoachMessage("err", r);
	assert.match(msg, /varios bloques parcialmente iguales/);
	assert.match(msg, /2 candidatos empatados/);
});

test("bordes: oldString vacío o archivo más corto que oldString", () => {
	assert.equal(findClosestMatch("a\nb\n", "").found, false);
	assert.equal(findClosestMatch("a\nb\n", "   \n  ").found, false);
	const r = findClosestMatch("una linea\n", "l1\nl2\nl3\nl4");
	assert.equal(r.found, false);
	assert.equal(r.diagnosis, "not-found");
});

test("CRLF: se normaliza antes de comparar", () => {
	const file = "header();\r\n    const x = 1;\r\n    return x;\r\n";
	const r = findClosestMatch(file, "  const x = 1;\n  return x;");
	assert.equal(r.found, true);
	assert.equal(r.diagnosis, "indentation");
});
