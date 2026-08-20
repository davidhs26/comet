// SPEC-ID01-502 §6.1 — tabla de casos del gate+flatten.
// Correr: node --test tools/pi-acp-forward-custom.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardCustomText } from "./pi-acp-forward-custom.mjs";

const base = { role: "custom", display: true };

// §4.1 gate: content string → emite con prefijo
test("content string con customType → prefijo + texto", () => {
  assert.equal(forwardCustomText({ ...base, customType: "subagents.result", content: "hola" }), "[subagents.result]\nhola");
});

// §4.2 flatten: array solo-texto (2+ items) → unidos con \n
test("array de 2 textos → unidos con \\n", () => {
  const r = forwardCustomText({
    ...base,
    customType: "t",
    content: [{ type: "text", text: "línea 1" }, { type: "text", text: "línea 2" }]
  });
  assert.equal(r, "[t]\nlínea 1\nlínea 2");
});

// array mixto texto+imagen → imagen omitida
test("array mixto texto+imagen → imagen omitida", () => {
  const r = forwardCustomText({
    ...base,
    content: [{ type: "text", text: "antes" }, { type: "image", data: "xxx" }, { type: "text", text: "después" }]
  });
  assert.equal(r, "antes\ndespués");
});

test("array solo imágenes → no emite", () => {
  assert.equal(forwardCustomText({ ...base, content: [{ type: "image", data: "x" }] }), null);
});

test("array con null y texto → null filtrado", () => {
  assert.equal(
    forwardCustomText({ ...base, content: [null, { type: "text", text: "x" }, "no-obj"] }),
    "x",
  );
});

// §4.1 gate display
test("display:false → no emite", () => {
  assert.equal(forwardCustomText({ ...base, display: false, content: "x" }), null);
});

test("display faltante → no emite", () => {
  assert.equal(forwardCustomText({ role: "custom", content: "x" }), null);
});

test("display truthy no-true ('true') → no emite", () => {
  assert.equal(forwardCustomText({ ...base, display: "true", content: "x" }), null);
});

// §7 no-regresión: message_end de roles no-custom NUNCA emite
test("role assistant → no emite", () => {
  assert.equal(forwardCustomText({ role: "assistant", display: true, content: "respuesta" }), null);
});

test("role user → no emite", () => {
  assert.equal(forwardCustomText({ role: "user", display: true, content: "prompt" }), null);
});

// §4.2 prefijo
test("customType vacío → sin prefijo", () => {
  assert.equal(forwardCustomText({ ...base, customType: "", content: "texto" }), "texto");
});

test("customType faltante → sin prefijo", () => {
  assert.equal(forwardCustomText({ ...base, content: "texto" }), "texto");
});

test("customType no-string (5) → sin prefijo", () => {
  assert.equal(forwardCustomText({ ...base, customType: 5, content: "texto" }), "texto");
});

// vacíos → no emite (sin burbujas vacías)
test("content string vacío → no emite", () => {
  assert.equal(forwardCustomText({ ...base, content: "" }), null);
});

test("content solo whitespace → no emite", () => {
  assert.equal(forwardCustomText({ ...base, customType: "t", content: "   \n  " }), null);
});

test("content array vacío → no emite", () => {
  assert.equal(forwardCustomText({ ...base, content: [] }), null);
});

test("content array con item text vacío → no emite", () => {
  assert.equal(forwardCustomText({ ...base, content: [{ type: "text", text: "" }] }), null);
});

test("content faltante → no emite", () => {
  assert.equal(forwardCustomText({ ...base }), null);
});

test("message null → no emite", () => {
  assert.equal(forwardCustomText(null), null);
});
