#!/usr/bin/env node
/**
 * golden/run.mjs — Runner de la golden suite de regresión del harness pi.
 * Issue Linear ID01-452. Node >= 20, sin dependencias externas.
 *
 * Uso:
 *   node golden/run.mjs [--matrix path] [--tasks id1,id2] [--models i1,i2]
 *                       [--tasks-dir path] [--json] [--out report.json]
 *
 * Por cada tarea x config de matrix:
 *   1. mkdtemp workspace + `bash setup.sh` dentro.
 *   2. Spawn de pi (PI_BIN o "pi") con --provider/--model/--thinking/-p.
 *      CRITICO: stdin "ignore" — si queda abierto, pi se cuelga.
 *      NO se usa --no-session: queremos el session file para los tokens.
 *      Timeout por tarea (default 300s; SIGTERM y a los 10s SIGKILL).
 *   3. `bash gate.sh` en el workspace -> pass/fail.
 *   4. Tokens desde el session file mas nuevo de
 *      ~/.pi/agent/sessions/<dir-cwd>/ via parseSession (reference/pi-telemetry.mjs).
 *      Si no hay session file -> tokens null, NO falla.
 *   5. Registra {task, model, pass, gateExit, timedOut, durationMs, tokens, editFailures}.
 *
 * Exit 0 si corrio toda la matriz (aunque haya gates fallidos);
 * exit 1 solo ante error del runner (args invalidos, matrix rota, tarea inexistente).
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseSession } from '../reference/pi-telemetry.mjs';

const RUN_MJS = fileURLToPath(import.meta.url);
const GOLDEN_DIR = dirname(RUN_MJS);

const DEFAULT_TIMEOUT_MS = 300_000;
const SIGKILL_AFTER_MS = 10_000;
const OUTPUT_CAP = 64_000; // cap de stdout/stderr capturados por corrida

function usage() {
  process.stderr.write(
    [
      'uso: node golden/run.mjs [opciones]',
      '  --matrix path     JSON con [{provider,model,thinking},...] (default: golden/matrix.json)',
      '  --tasks id1,id2   solo esas tareas (default: todas las de --tasks-dir)',
      '  --models i1,i2    indices 1-based dentro del matrix (default: todos)',
      '  --tasks-dir path  directorio de tareas (default: golden/tasks)',
      '  --json            imprime el reporte JSON ademas de la tabla',
      '  --out path        escribe el reporte JSON a un archivo',
      '',
    ].join('\n'),
  );
}

/**
 * Directorio de sesiones de pi para un cwd: cada "/" se reemplaza por "-"
 * y se envuelve en "--". Ej: /home/david/comet -> --home-david-comet--.
 * (Ademas se normalizan "\\" y ":" para que sea usable en Windows.)
 */
export function sessionDirFor(cwd) {
  const slug = cwd.replaceAll('\\', '/').replaceAll(':', '').replaceAll('/', '-');
  // Naming real verificado en la Beelink: /tmp/x -> "--tmp-x--" (prefijo "-" +
  // slug con "-" inicial por la barra raiz + sufijo "--").
  return join(homedir(), '.pi', 'agent', 'sessions', `-${slug}--`);
}

const toBashPath = (p) => p.replaceAll('\\', '/');

/** Ejecuta un comando capturando salida; nunca lanza, devuelve {code, stdout, stderr, spawnError}. */
function runCmd(cmd, args, { cwd } = {}) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      res({ code: null, stdout: '', stderr: '', spawnError: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_CAP) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      res({ code: null, stdout, stderr, spawnError: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      res({ code, stdout, stderr, spawnError: null });
    });
  });
}

const bash = (script, cwd) => runCmd('bash', [toBashPath(script)], { cwd });

/** Lanza pi con timeout: SIGTERM al vencer y SIGKILL 10s despues. */
function runAgent(prompt, cfg, cwd, timeoutMs) {
  return new Promise((res) => {
    const bin = process.env.PI_BIN || 'pi';
    const piArgs = [
      '--provider', cfg.provider,
      '--model', cfg.model,
      '--thinking', cfg.thinking,
      '-p', prompt,
    ];
    // PI_BIN puede ser un script .js/.mjs (p.ej. el pi falso de los tests):
    // en ese caso se ejecuta con el node actual.
    const isJs = /\.(mjs|cjs|js)$/.test(bin);
    const cmd = isJs ? process.execPath : bin;
    const argv = isJs ? [bin, ...piArgs] : piArgs;

    let child;
    try {
      child = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      res({ code: null, timedOut: false, spawnError: err.message });
      return;
    }
    let timedOut = false;
    let settled = false;
    let hardKill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, SIGKILL_AFTER_MS);
    }, timeoutMs);
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      res({ code, timedOut, spawnError });
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, null));
  });
}

/** Lee tokens y editFailures del session file mas nuevo; null si no hay. */
function readSessionMetrics(cwd) {
  const dir = sessionDirFor(cwd);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return null;
  let newest = null;
  let mtime = -1;
  for (const f of files) {
    const st = statSync(join(dir, f));
    if (st.mtimeMs > mtime) {
      mtime = st.mtimeMs;
      newest = f;
    }
  }
  try {
    const s = parseSession(join(dir, newest));
    return {
      tokens: { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead },
      editFailures: s.edit.errors,
    };
  } catch {
    return null;
  }
}

async function runOne(taskId, cfg, opts) {
  const tdir = join(opts.tasksDir, taskId);
  const tcfg = existsSync(join(tdir, 'task.json'))
    ? JSON.parse(readFileSync(join(tdir, 'task.json'), 'utf8'))
    : {};
  const timeoutMs = tcfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prompt = readFileSync(join(tdir, 'task.md'), 'utf8');
  const ws = mkdtempSync(join(tmpdir(), 'pi-golden-'));

  const run = {
    task: taskId,
    model: cfg.model,
    pass: false,
    gateExit: null,
    timedOut: false,
    durationMs: 0,
    tokens: null,
    editFailures: null,
    error: null,
  };
  const t0 = Date.now();
  process.stderr.write(`[run] ${taskId} x ${cfg.model} (ws: ${ws})\n`);

  // 1. setup
  const setup = await bash(join(tdir, 'setup.sh'), ws);
  if (setup.spawnError || setup.code !== 0) {
    run.error = `setup.sh fallo (exit ${setup.code ?? '-'}: ${setup.spawnError ?? setup.stderr.trim().slice(0, 200)})`;
    run.durationMs = Date.now() - t0;
    if (!process.env.PI_GOLDEN_KEEP) rmSync(ws, { recursive: true, force: true });
    else run.workspace = ws;
    return run;
  }

  // 2. agente
  const agent = await runAgent(prompt, cfg, ws, timeoutMs);
  run.timedOut = agent.timedOut;
  if (agent.spawnError) run.error = `no se pudo lanzar pi: ${agent.spawnError}`;

  // 3. gate (se corre siempre: el pass lo define el gate)
  const gate = await bash(join(tdir, 'gate.sh'), ws);
  run.gateExit = gate.code;
  run.pass = gate.code === 0;

  // 4. tokens (no fatal si no hay session file)
  const metrics = readSessionMetrics(ws);
  if (metrics) {
    run.tokens = metrics.tokens;
    run.editFailures = metrics.editFailures;
  }

  run.durationMs = Date.now() - t0;
  if (!process.env.PI_GOLDEN_KEEP) rmSync(ws, { recursive: true, force: true });
  else run.workspace = ws;
  process.stderr.write(
    `[run] ${taskId} x ${cfg.model}: ${run.pass ? 'PASS' : 'FAIL'} (${(run.durationMs / 1000).toFixed(1)}s)${run.error ? ` ERROR: ${run.error}` : ''}\n`,
  );
  return run;
}

function buildSummary(runs) {
  const porModelo = {};
  for (const r of runs) {
    const m = (porModelo[r.model] ??= {
      runs: 0,
      passed: 0,
      passRate: 0,
      tokens: { input: 0, output: 0, cacheRead: 0 },
      wallClock: 0,
    });
    m.runs++;
    if (r.pass) m.passed++;
    if (r.tokens) {
      m.tokens.input += r.tokens.input;
      m.tokens.output += r.tokens.output;
      m.tokens.cacheRead += r.tokens.cacheRead;
    }
    m.wallClock += r.durationMs;
  }
  for (const m of Object.values(porModelo)) {
    m.passRate = m.runs > 0 ? m.passed / m.runs : 0;
  }
  return { porModelo };
}

function printTable(runs, summary) {
  const rows = runs.map((r) => [
    r.task,
    r.model,
    r.pass ? 'PASS' : 'FAIL',
    r.gateExit === null ? '-' : String(r.gateExit),
    r.timedOut ? 'si' : 'no',
    `${(r.durationMs / 1000).toFixed(1)}s`,
    r.tokens ? String(r.tokens.input) : '-',
    r.tokens ? String(r.tokens.output) : '-',
    r.tokens ? String(r.tokens.cacheRead) : '-',
    r.editFailures === null ? '-' : String(r.editFailures),
    r.error ?? '',
  ]);
  const header = ['task', 'model', 'pass', 'gate', 'timeout', 'dur', 'tokIn', 'tokOut', 'cacheRead', 'editFail', 'error'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('');
  for (const [model, m] of Object.entries(summary.porModelo)) {
    console.log(
      `${model}: passRate ${(m.passRate * 100).toFixed(1)}% (${m.passed}/${m.runs})  ` +
        `tokIn:${m.tokens.input} tokOut:${m.tokens.output} cacheRead:${m.tokens.cacheRead}  ` +
        `wallClock:${(m.wallClock / 1000).toFixed(1)}s`,
    );
  }
}

function parseArgs(argv) {
  const opts = {
    matrix: join(GOLDEN_DIR, 'matrix.json'),
    tasks: null,
    models: null,
    tasksDir: join(GOLDEN_DIR, 'tasks'),
    json: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--matrix') opts.matrix = resolve(argv[++i]);
    else if (a === '--tasks') opts.tasks = argv[++i].split(',');
    else if (a === '--models') opts.models = argv[++i].split(',').map(Number);
    else if (a === '--tasks-dir') opts.tasksDir = resolve(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      usage();
      throw new Error(`argumento desconocido: ${a}`);
    }
  }
  return opts;
}

export async function main(argv) {
  const opts = parseArgs(argv);

  let matrix;
  try {
    matrix = JSON.parse(readFileSync(opts.matrix, 'utf8'));
  } catch (err) {
    throw new Error(`no se pudo leer el matrix ${opts.matrix}: ${err.message}`);
  }
  if (!Array.isArray(matrix) || matrix.length === 0) throw new Error('matrix vacio o invalido');
  for (const [i, c] of matrix.entries()) {
    if (!c || typeof c.provider !== 'string' || typeof c.model !== 'string' || typeof c.thinking !== 'string') {
      throw new Error(`matrix[${i}] invalido: se espera {provider,model,thinking}`);
    }
  }

  const available = readdirSync(opts.tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) =>
      ['task.md', 'setup.sh', 'gate.sh'].every((f) => existsSync(join(opts.tasksDir, name, f))),
    )
    .sort();
  const tasks = opts.tasks ?? available;
  for (const t of tasks) {
    if (!available.includes(t)) throw new Error(`tarea desconocida o incompleta: ${t}`);
  }

  let configs = matrix;
  if (opts.models) {
    configs = opts.models.map((i) => {
      if (!Number.isInteger(i) || i < 1 || i > matrix.length) {
        throw new Error(`indice de modelo fuera de rango: ${i} (matrix tiene ${matrix.length})`);
      }
      return matrix[i - 1];
    });
  }

  const runs = [];
  for (const task of tasks) {
    for (const cfg of configs) {
      runs.push(await runOne(task, cfg, opts));
    }
  }

  const summary = buildSummary(runs);
  const report = { runs, summary };
  printTable(runs, summary);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2));
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  return 0;
}

// Ejecutar como CLI solo si es el entrypoint (no al importar desde tests).
const invokedAs = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedAs === RUN_MJS) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`runner error: ${err.message}\n`);
      process.exit(1);
    });
}
