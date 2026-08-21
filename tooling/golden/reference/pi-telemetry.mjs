#!/usr/bin/env node
/**
 * pi-telemetry.mjs — Analizador de telemetría para sesiones del agente de coding "pi".
 * Issue Linear ID01-451. Node >= 20, sin dependencias externas.
 *
 * ESQUEMA REAL DERIVADO DE LOS FIXTURES (fixtures/session-small.jsonl,
 * fixtures/session-small2.jsonl, fixtures/session-big-head.txt):
 *
 * Archivo JSONL: una entrada JSON por línea. Tipos de entrada (campo `type`):
 *
 * - {"type":"session","version":3,"id","timestamp","cwd"}
 *     Primera línea. Marca el inicio de la sesión.
 * - {"type":"model_change","id","parentId","timestamp","provider","modelId"}
 *     Cambio de modelo. Puede haber varios; el último es el modelo vigente.
 * - {"type":"thinking_level_change","id","parentId","timestamp","thinkingLevel"}
 *     Nivel de thinking ("medium", "minimal", "low", ...). El último es el vigente.
 * - {"type":"message","id","parentId","timestamp","message":{...}}
 *     El timestamp ISO está en la entrada (nivel superior); `message.timestamp`
 *     es epoch-ms. Roles de `message.role`:
 *
 *     - "user":       content: [{"type":"text","text"}]
 *     - "assistant":  content: mezcla de
 *                       {"type":"thinking","thinking","thinkingSignature"}
 *                       {"type":"text","text"}
 *                       {"type":"toolCall","id","name","arguments":{...}}
 *                   Además: api, provider, model, stopReason ("toolUse"|"stop"),
 *                   responseId, rawStopReason, y usage:
 *                     usage: {input, output, cacheRead, cacheWrite, totalTokens,
 *                             cost:{input,output,cacheRead,cacheWrite,total},
 *                             cacheWrite1h?, reasoning?}
 *                   OJO: `totalTokens` es el tamaño del contexto en ese punto
 *                   (crece monótonamente), NO es aditivo — no se suma entre
 *                   mensajes. input/output/cacheRead/cacheWrite/reasoning sí
 *                   se acumulan por mensaje.
 *     - "toolResult": {role:"toolResult","toolCallId","toolName",
 *                      content:[{"type":"text","text"}], details?,
 *                      isError:boolean,  <-- MARCA DE ERROR del tool result
 *                      timestamp}
 *                   Un tool result es error iff `isError === true` (el texto
 *                   puede contener "Command exited with code N" pero la marca
 *                   autoritativa es isError).
 *
 * Turno: par user -> assistant. Se cuenta un turno por cada mensaje user que
 * tiene al menos un mensaje assistant posterior en la sesión.
 *
 * editRetries: un call al tool "edit" con resultado isError:true, seguido
 * (dentro de los 2 mensajes assistant siguientes) por otro call "edit" al
 * mismo archivo (arguments.path), cuenta como 1 retry.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';

const EDIT_TOOL = 'edit';

function warn(msg) {
  process.stderr.write(`warning: ${msg}\n`);
}

/** Recolecta archivos .jsonl de paths (archivos o directorios, recursivo). */
export function collectJsonlFiles(paths) {
  const files = [];
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      warn(`no se pudo acceder a ${p}, se omite`);
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else if (p.endsWith('.jsonl')) {
      files.push(p);
    }
  };
  for (const p of paths) walk(p);
  return files.sort();
}

function emptyToolStats() {
  return { calls: 0, errors: 0 };
}

/** Parsea un archivo de sesión JSONL y devuelve sus métricas. */
export function parseSession(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');

  const s = {
    file: path,
    sessionId: null,
    cwd: null,
    malformedLines: 0,
    entries: 0,
    turns: 0,
    messages: { total: 0, user: 0, assistant: 0, toolResult: 0, other: 0 },
    durationMs: 0,
    model: null,
    provider: null,
    thinking: null,
    tools: {}, // name -> {calls, errors}
    edit: { calls: 0, errors: 0, failureRate: null, retries: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messagesWithUsage: 0 },
  };

  let firstTs = null;
  let lastTs = null;

  // Secuencia cronológica de calls y resultados para editRetries.
  // callEvents: [{assistantIndex, name, file, id}]
  const callEvents = [];
  const resultErrors = new Map(); // toolCallId -> isError
  const roles = []; // secuencia de roles, para contar turnos
  let assistantIndex = -1;

  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      s.malformedLines++;
      warn(`${path}:${i + 1}: línea malformada, se omite`);
      return;
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.type !== 'string') {
      s.malformedLines++;
      warn(`${path}:${i + 1}: entrada sin "type", se omite`);
      return;
    }
    s.entries++;

    const ts = Date.parse(entry.timestamp);
    if (!Number.isNaN(ts)) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    switch (entry.type) {
      case 'session':
        s.sessionId = entry.id ?? null;
        s.cwd = entry.cwd ?? null;
        break;
      case 'model_change':
        s.provider = entry.provider ?? s.provider;
        s.model = entry.modelId ?? s.model;
        break;
      case 'thinking_level_change':
        s.thinking = entry.thinkingLevel ?? s.thinking;
        break;
      case 'message': {
        const m = entry.message;
        if (!m || typeof m !== 'object') break;
        s.messages.total++;
        const role = m.role;
        roles.push(role);
        if (role === 'user') s.messages.user++;
        else if (role === 'assistant') s.messages.assistant++;
        else if (role === 'toolResult') s.messages.toolResult++;
        else s.messages.other++;

        if (role === 'assistant') {
          assistantIndex++;
          if (m.usage && typeof m.usage === 'object') {
            const u = m.usage;
            s.tokens.messagesWithUsage++;
            for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
              if (typeof u[k] === 'number') s.tokens[k] += u[k];
            }
          }
          for (const part of m.content ?? []) {
            if (part?.type === 'toolCall') {
              const name = part.name ?? 'unknown';
              const stats = (s.tools[name] ??= emptyToolStats());
              stats.calls++;
              if (name === EDIT_TOOL) s.edit.calls++;
              callEvents.push({
                assistantIndex,
                name,
                id: part.id,
                file: part.arguments?.path ?? part.arguments?.file_path ?? null,
              });
            }
          }
        } else if (role === 'toolResult') {
          const isError = m.isError === true;
          if (m.toolCallId != null) resultErrors.set(m.toolCallId, isError);
        }
        break;
      }
      default:
        break; // otros tipos de entrada se ignoran
    }
  });

  if (firstTs !== null && lastTs !== null) s.durationMs = lastTs - firstTs;

  // Turnos: mensajes user con al menos un assistant posterior.
  {
    let assistantsSeen = 0;
    const suffixHasAssistant = new Array(roles.length).fill(false);
    for (let i = roles.length - 1; i >= 0; i--) {
      if (roles[i] === 'assistant') assistantsSeen++;
      suffixHasAssistant[i] = assistantsSeen > 0;
    }
    let turns = 0;
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] === 'user' && suffixHasAssistant[i]) turns++;
    }
    s.turns = turns;
  }

  // Errores por tool: cruzar resultados con calls por toolCallId.
  for (const call of callEvents) {
    if (resultErrors.get(call.id) === true) {
      const stats = s.tools[call.name];
      if (stats) stats.errors++;
      if (call.name === EDIT_TOOL) s.edit.errors++;
    }
  }
  s.edit.failureRate = s.edit.calls > 0 ? (s.edit.errors / s.edit.calls) * 100 : null;

  // editRetries: edit fallido seguido (dentro de los 2 mensajes assistant
  // siguientes) por otro edit al mismo archivo.
  for (const call of callEvents) {
    if (call.name !== EDIT_TOOL || resultErrors.get(call.id) !== true || call.file == null) continue;
    const retry = callEvents.some(
      (other) =>
        other.name === EDIT_TOOL &&
        other.file === call.file &&
        other.assistantIndex > call.assistantIndex &&
        other.assistantIndex <= call.assistantIndex + 2,
    );
    if (retry) s.edit.retries++;
  }

  // % de fallo por tool.
  for (const stats of Object.values(s.tools)) {
    stats.failureRate = stats.calls > 0 ? (stats.errors / stats.calls) * 100 : null;
  }

  return s;
}

/** Agrega métricas de varias sesiones. */
export function aggregate(sessions) {
  const agg = {
    sessions: sessions.length,
    turns: 0,
    messages: { total: 0, user: 0, assistant: 0, toolResult: 0, other: 0 },
    durationMs: 0,
    malformedLines: 0,
    tools: {},
    edit: { calls: 0, errors: 0, failureRate: null, retries: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messagesWithUsage: 0 },
  };
  for (const s of sessions) {
    agg.turns += s.turns;
    agg.durationMs += s.durationMs;
    agg.malformedLines += s.malformedLines;
    for (const k of Object.keys(agg.messages)) agg.messages[k] += s.messages[k];
    for (const k of Object.keys(agg.tokens)) agg.tokens[k] += s.tokens[k];
    for (const [name, st] of Object.entries(s.tools)) {
      const a = (agg.tools[name] ??= emptyToolStats());
      a.calls += st.calls;
      a.errors += st.errors;
    }
    agg.edit.calls += s.edit.calls;
    agg.edit.errors += s.edit.errors;
    agg.edit.retries += s.edit.retries;
  }
  for (const st of Object.values(agg.tools)) {
    st.failureRate = st.calls > 0 ? (st.errors / st.calls) * 100 : null;
  }
  agg.edit.failureRate = agg.edit.calls > 0 ? (agg.edit.errors / agg.edit.calls) * 100 : null;
  return agg;
}

function fmtDuration(ms) {
  if (ms >= 3600_000) return `${(ms / 3600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(x) {
  return x === null ? '-' : `${x.toFixed(1)}%`;
}

function fmtTools(tools) {
  const names = Object.keys(tools).sort();
  if (names.length === 0) return '-';
  return names
    .map((n) => `${n}:${tools[n].calls} (${tools[n].errors} err, ${fmtPct(tools[n].failureRate)})`)
    .join(' ');
}

function printTable(sessions, agg) {
  const rows = sessions.map((s) => [
    basename(s.file),
    String(s.turns),
    String(s.messages.total),
    fmtDuration(s.durationMs),
    s.model ?? '-',
    s.provider ?? '-',
    s.thinking ?? '-',
    fmtTools(s.tools),
    `${fmtPct(s.edit.failureRate)} (r${s.edit.retries})`,
    String(s.tokens.input),
    String(s.tokens.output),
    String(s.tokens.cacheRead),
    String(s.malformedLines),
  ]);
  const header = ['file', 'turns', 'msgs', 'dur', 'model', 'provider', 'thinking', 'tools(calls/err/%)', 'editFail%', 'tokIn', 'tokOut', 'cacheRead', 'badLines'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('');
  console.log(
    `AGGREGATE  sessions:${agg.sessions}  turns:${agg.turns}  msgs:${agg.messages.total}  ` +
      `dur:${fmtDuration(agg.durationMs)}  tools: ${fmtTools(agg.tools)}  ` +
      `editFail:${fmtPct(agg.edit.failureRate)} retries:${agg.edit.retries}  ` +
      `tokIn:${agg.tokens.input} tokOut:${agg.tokens.output} cacheRead:${agg.tokens.cacheRead} ` +
      `cacheWrite:${agg.tokens.cacheWrite} reasoning:${agg.tokens.reasoning}  badLines:${agg.malformedLines}`,
  );
}

export function main(argv) {
  const args = [...argv];
  const jsonMode = args.includes('--json');
  const paths = args.filter((a) => a !== '--json');
  if (paths.length === 0) {
    process.stderr.write('uso: node pi-telemetry.mjs [--json] <path...>\n');
    return 1;
  }

  const files = collectJsonlFiles(paths);
  if (files.length === 0) {
    warn('no se encontraron archivos .jsonl');
    return 1;
  }

  const sessions = [];
  for (const f of files) {
    let s;
    try {
      s = parseSession(f);
    } catch (err) {
      warn(`${f}: no se pudo leer (${err.message}), se omite`);
      continue;
    }
    if (s.entries === 0) {
      warn(`${f}: sin entradas válidas, se omite`);
      continue;
    }
    sessions.push(s);
  }

  if (sessions.length === 0) {
    warn('ninguna sesión pudo parsearse');
    return 1;
  }

  const agg = aggregate(sessions);
  if (jsonMode) {
    console.log(JSON.stringify({ sessions, aggregate: agg }, null, 2));
  } else {
    printTable(sessions, agg);
  }
  return 0;
}

// Ejecutar como CLI solo si es el entrypoint (no al importar desde tests).
const invokedAs = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href : '';
if (invokedAs === import.meta.url || process.argv[1]?.endsWith('pi-telemetry.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
