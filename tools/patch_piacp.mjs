// Patch pi-acp 0.0.33 (fork Zeron) — DOS partes, idempotentes POR-PARTE:
//
//  1. `_session/steering`  (steering mid-turn → RPC nativo {type:"steer"} de pi).
//     Tres inserciones con anchors únicos. Idéntico al histórico ~/tools/patch_piacp.mjs.
//  2. `ZERON-CUSTOM-FORWARD` (ID01-502): case `message_end` en handlePiEvent que
//     forwardea custom messages con display:true como UN agent_message_chunk
//     (el engine ya los convierte a burbuja assistant). Gate+flatten viven en
//     tools/pi-acp-forward-custom.mjs y se inlinean desde acá en runtime —
//     ese módulo es la única fuente de verdad (tests + dist comparten lógica).
//
// Reglas: backup SIEMPRE index.js.orig-0.0.33 creado solo si no existe (jamás
// se pisa el virgen); todas las validaciones corren ANTES del writeFileSync
// único; verificación sintáctica con node --check al final.
//
// Target override para sandbox: PIACP_FILE=/tmp/copia/index.js node tools/patch_piacp.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FILE = process.env.PIACP_FILE ?? process.env.HOME + "/.zeron/adapters/pi-acp/0.0.33/node_modules/pi-acp/dist/index.js";
const BAK = FILE + ".orig-0.0.33";

let src = fs.readFileSync(FILE, "utf8");
const done = [];

function assertOnce(anchor, label) {
  const first = src.indexOf(anchor);
  const last = src.lastIndexOf(anchor);
  if (first < 0) throw new Error(`anchor NO encontrado (${label})`);
  if (first !== last) throw new Error(`anchor NO único (${label})`);
  return first;
}

// ── PARTE 1: _session/steering (histórico, sin cambios) ───────────────
function applySteering() {
  // 1a. initialize: anunciar la extensión
  const A1 = "protocolVersion: requested === supportedVersion ? requested : supportedVersion,";
  assertOnce(A1, "initialize/protocolVersion");
  src = src.replace(
    A1,
    A1 +
      "\n      // Zeron steering extension: advertised so the host injects steers\n" +
      "      // mid-turn via `_session/steering` instead of waiting for turn end.\n" +
      "      _meta: { steering: { supported: true } },"
  );

  // 1b. RPC client: método steer
  const A2 = 'async abort() {\n    const res = await this.request({ type: "abort" });';
  assertOnce(A2, "client/abort");
  src = src.replace(
    A2,
    'async steer(message, images = []) {\n' +
      '    const res = await this.request({ type: "steer", message, images });\n' +
      '    if (!res.success) throw new Error(`pi steer failed: ${res.error ?? JSON.stringify(res.data)}`);\n' +
      "  }\n  " +
      A2
  );

  // 1c. ACP agent: extMethod para `_session/steering`
  const A3 = "  async initialize(params) {\n    const supportedVersion = 1;";
  assertOnce(A3, "agent/initialize");
  const EXT =
    "  // ACP extension methods (SDK routes unknown requests here). Implements\n" +
    "  // the Zeron `_session/steering` contract: inject into a LIVE turn via\n" +
    "  // pi's native RPC steer (delivered before the next LLM call) and answer\n" +
    "  // `injected`; with no running turn answer `promptRequired` so the host\n" +
    "  // redelivers the text as a normal `session/prompt` it can track.\n" +
    "  async extMethod(method, params) {\n" +
    '    if (method === "_session/steering") {\n' +
    "      const session = await this.restoreSession(params.sessionId);\n" +
    "      const { message, images } = promptToPiMessage(params.prompt ?? []);\n" +
    "      if (!session.pendingTurn) {\n" +
    '        if (params?._meta?.steering?.idleBehavior === "promptRequired") {\n' +
    '          return { outcome: "promptRequired", reason: "noRunningTurn" };\n' +
    "        }\n" +
    "        this.prompt({ sessionId: params.sessionId, prompt: params.prompt }).catch(() => {\n" +
    "        });\n" +
    '        return { outcome: "startedNewTurn" };\n' +
    "      }\n" +
    "      await session.proc.steer(message, images);\n" +
    '      return { outcome: "injected" };\n' +
    "    }\n" +
    "    throw RequestError3.methodNotFound(method);\n" +
    "  }\n";
  src = src.replace(A3, EXT + A3);

  for (const need of ["promptToPiMessage", "restoreSession", "RequestError3", "pendingTurn", ".proc."]) {
    if (!src.includes(need)) throw new Error(`dependencia steering ausente en bundle: ${need}`);
  }
  done.push("steering");
}

// ── PARTE 2: ZERON-CUSTOM-FORWARD (ID01-502) ──────────────────────────
function applyCustomForward() {
  // Inline del módulo puro (única fuente de verdad: tests + dist comparten lógica).
  const modPath = fileURLToPath(new URL("./pi-acp-forward-custom.mjs", import.meta.url));
  const mod = fs.readFileSync(modPath, "utf8");
  const start = mod.indexOf("export function forwardCustomText");
  if (start < 0) throw new Error(`módulo ${modPath}: no se encontró export function forwardCustomText`);
  const method = mod
    .slice(start)
    .replace(/^export function /, "")
    .trimEnd()
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
  // sanity: el cuerpo inlineado conserva el gate §4.1 (protege contra refactor del módulo)
  for (const need of ['role !== "custom"', 'display !== true', "customType"]) {
    if (!method.includes(need)) throw new Error(`módulo ${modPath}: gate §4.1 incompleto (falta ${need})`);
  }

  // Anchor: `default: break` final del switch de handlePiEvent + handleExtensionUiRequest (único en el archivo)
  const ANCHOR =
    "      default:\n" +
    "        break;\n" +
    "    }\n" +
    "  }\n" +
    "  async handleExtensionUiRequest(ev) {";
  assertOnce(ANCHOR, "custom-forward/default-break");

  // Case nuevo inmediatamente antes del `default:`; método inmediatamente después de handlePiEvent.
  const CASE =
    '      case "message_end": {\n' +
    "        // ZERON-CUSTOM-FORWARD (ID01-502): custom messages de pi (p.ej. resultados\n" +
    "        // de subagentes) con display:true llegan a iOS como burbuja assistant vía\n" +
    "        // UN único agent_message_chunk. Gate+flatten: this.forwardCustomText\n" +
    "        // (inlinado de tools/pi-acp-forward-custom.mjs — misma lógica que los tests).\n" +
    "        const zeronForwardText = this.forwardCustomText(ev.message);\n" +
    "        if (zeronForwardText !== null) {\n" +
    "          this.emit({\n" +
    '            sessionUpdate: "agent_message_chunk",\n' +
    '            content: { type: "text", text: zeronForwardText }\n' +
    "          });\n" +
    "        }\n" +
    "        break;\n" +
    "      }\n" +
    "      default:\n" +
    "        break;\n" +
    "    }\n" +
    "  }\n" +
    method + "\n" +
    "  async handleExtensionUiRequest(ev) {";
  src = src.replace(ANCHOR, CASE);

  // sanity: shape §4.3 presente y sin case message_start (§7)
  if (!src.includes('case "message_end"')) throw new Error("sanity: case message_end ausente tras inserción");
  if (src.includes("case \"message_start\"")) throw new Error("sanity: case message_start NO debe existir");
  done.push("custom-forward");
}

// ── orquestación por-parte ────────────────────────────────────────────
const parts = [];
if (src.includes("_session/steering")) console.log("steering: marcador presente — salteado");
else parts.push(applySteering);
if (src.includes("ZERON-CUSTOM-FORWARD")) console.log("custom-forward: marcador presente — salteado");
else parts.push(applyCustomForward);

if (parts.length === 0) {
  console.log("PATCH YA APLICADO (ambas partes) — nada que hacer ·", FILE);
} else {
  // backup del virgen solo si no existe — JAMÁS pisarlo
  const bakPreexisting = fs.existsSync(BAK);
  if (!bakPreexisting) fs.copyFileSync(FILE, BAK);
  for (const p of parts) p(); // todas las validaciones/anchors ANTES del write único
  fs.writeFileSync(FILE, src);
  console.log(`PATCH OK (${done.join(" + ")}) ·`, FILE);
  console.log("backup:", BAK, bakPreexisting ? "(preexistente, no tocado)" : "(creado)");
}

// verificación sintáctica siempre (node --check exige extensión .js)
const checkFile = FILE.endsWith(".js")
  ? FILE
  : FILE + ".syntax-check.js";
if (checkFile !== FILE) fs.copyFileSync(FILE, checkFile);
try {
  execFileSync(process.execPath, ["--check", checkFile], { stdio: "inherit" });
} finally {
  if (checkFile !== FILE) fs.unlinkSync(checkFile);
}
console.log("SYNTAX OK");
