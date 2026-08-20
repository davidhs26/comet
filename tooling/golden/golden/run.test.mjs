// golden/run.test.mjs — Tests del runner de la golden suite (ID01-452).
// Usa un PI FALSO (script node escrito acá, seteado vía PI_BIN) con 3
// comportamientos seleccionables por FAKE_PI_BEHAVIOR:
//   pass  -> resuelve la tarea read-answer (escribe answer.txt) y deja session file
//   noop  -> no hace nada (gate falla, no hay session file -> tokens null)
//   sleep -> duerme 60s (para probar timeout con timeoutMs chico)
// Node >= 20, sin deps externas. Correr: node --test golden/run.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GOLDEN = dirname(fileURLToPath(import.meta.url));
const RUN = join(GOLDEN, 'run.mjs');
const REAL_TASKS = join(GOLDEN, 'tasks');

const SCRATCH = mkdtempSync(join(tmpdir(), 'pi-golden-test-'));
const FAKE_HOME = join(SCRATCH, 'home');
const FAKE_PI = join(SCRATCH, 'fake-pi.mjs');
const MATRIX = join(SCRATCH, 'matrix.json');

mkdirSync(FAKE_HOME, { recursive: true });
writeFileSync(MATRIX, JSON.stringify([{ provider: 'test', model: 'fake/model-x', thinking: 'low' }]));

// El pi falso importa sessionDirFor del runner para escribir el session file
// en el mismo lugar donde el runner lo va a buscar.
writeFileSync(
  FAKE_PI,
  `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDirFor } from ${JSON.stringify(pathToFileURL(RUN).href)};

const behavior = process.env.FAKE_PI_BEHAVIOR || 'noop';

function writeSession() {
  const dir = sessionDirFor(process.cwd());
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { type: 'session', version: 3, id: 'fake', timestamp: ts, cwd: process.cwd() },
    { type: 'message', id: '1', parentId: null, timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
    { type: 'message', id: '2', parentId: '1', timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        usage: { input: 111, output: 22, cacheRead: 5 } } },
  ];
  writeFileSync(join(dir, 'fake-session.jsonl'), lines.map(JSON.stringify).join('\\n') + '\\n');
}

if (behavior === 'sleep') {
  setTimeout(() => {}, 60_000);
} else if (behavior === 'pass') {
  const lines = readFileSync('sales.csv', 'utf8').trim().split('\\n').slice(1);
  const totals = {};
  for (const l of lines) {
    const [r, a] = l.split(',');
    totals[r] = (totals[r] || 0) + Number(a);
  }
  const best = Object.keys(totals).sort().reduce((b, r) => (totals[r] > totals[b] ? r : b));
  writeFileSync('answer.txt', \`\${best} \${totals[best]}\\n\`);
  writeSession();
  console.log('fake pi: done');
}
// 'noop': no hace nada (ni session file).
`,
);

/** Corre el runner como subproceso y devuelve {status, stdout, stderr, report}. */
function runGolden({ behavior, args, tasksDir }) {
  const out = join(SCRATCH, `report-${behavior}-${Math.random().toString(36).slice(2)}.json`);
  const fullArgs = [RUN, '--matrix', MATRIX, '--json', '--out', out, ...args];
  if (tasksDir) fullArgs.push('--tasks-dir', tasksDir);
  const r = spawnSync(process.execPath, fullArgs, {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PI_BIN: FAKE_PI,
      FAKE_PI_BEHAVIOR: behavior,
      // HOME (POSIX) y USERPROFILE (Windows) para que el session file caiga en FAKE_HOME.
      HOME: FAKE_HOME,
      USERPROFILE: FAKE_HOME,
    },
  });
  assert.equal(r.error, undefined, `spawn del runner fallo: ${r.error?.message}`);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    report: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
  };
}

/** Crea una tarea mínima en un tasks-dir temporal. */
function makeTask(tasksDir, id, { setup, gate, task = 'hace algo\n', taskJson = null }) {
  const dir = join(tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.md'), task);
  writeFileSync(join(dir, 'setup.sh'), setup);
  writeFileSync(join(dir, 'gate.sh'), gate);
  if (taskJson) writeFileSync(join(dir, 'task.json'), JSON.stringify(taskJson));
}

test('pass: pi falso resuelve read-answer, shape del JSON y tokens del session file', () => {
  const { status, report } = runGolden({ behavior: 'pass', args: ['--tasks', 'read-answer'] });
  assert.equal(status, 0);
  assert.equal(report.runs.length, 1);
  const run = report.runs[0];

  for (const k of ['task', 'model', 'pass', 'gateExit', 'timedOut', 'durationMs', 'tokens', 'editFailures']) {
    assert.ok(k in run, `falta la clave ${k} en el run`);
  }
  assert.equal(run.task, 'read-answer');
  assert.equal(run.model, 'fake/model-x');
  assert.equal(run.pass, true);
  assert.equal(run.gateExit, 0);
  assert.equal(run.timedOut, false);
  assert.ok(run.durationMs >= 0);
  assert.deepEqual(run.tokens, { input: 111, output: 22, cacheRead: 5 });
  assert.equal(run.editFailures, 0);

  const m = report.summary.porModelo['fake/model-x'];
  assert.ok(m, 'summary.porModelo debe tener el modelo');
  assert.equal(m.passRate, 1);
  assert.deepEqual(m.tokens, { input: 111, output: 22, cacheRead: 5 });
  assert.ok(m.wallClock >= 0);
});

test('noop: gate falla, session ausente -> tokens null, runner igualmente exit 0', () => {
  const { status, report } = runGolden({ behavior: 'noop', args: ['--tasks', 'read-answer'] });
  assert.equal(status, 0);
  const run = report.runs[0];
  assert.equal(run.pass, false);
  assert.equal(run.gateExit, 1);
  assert.equal(run.tokens, null);
  assert.equal(run.editFailures, null);
  assert.equal(report.summary.porModelo['fake/model-x'].passRate, 0);
});

test('timeout: pi que duerme es matado y queda timedOut=true', () => {
  const tasksDir = join(SCRATCH, 'tasks-timeout');
  makeTask(tasksDir, 'lento', {
    setup: '#!/usr/bin/env bash\nexit 0\n',
    gate: '#!/usr/bin/env bash\nexit 1\n',
    taskJson: { timeoutMs: 1500 },
  });
  const { status, report } = runGolden({ behavior: 'sleep', args: ['--tasks', 'lento'], tasksDir });
  assert.equal(status, 0);
  const run = report.runs[0];
  assert.equal(run.timedOut, true);
  assert.equal(run.pass, false);
  assert.ok(run.durationMs < 30_000, `tardo demasiado: ${run.durationMs}ms`);
});

test('setup roto: reporta error en ese run sin tumbar el resto', () => {
  const tasksDir = join(SCRATCH, 'tasks-setup');
  makeTask(tasksDir, 'badsetup', {
    setup: '#!/usr/bin/env bash\nexit 3\n',
    gate: '#!/usr/bin/env bash\nexit 0\n',
  });
  makeTask(tasksDir, 'oktask', {
    setup: '#!/usr/bin/env bash\nexit 0\n',
    gate: '#!/usr/bin/env bash\nexit 0\n',
  });
  const { status, report } = runGolden({ behavior: 'noop', args: [], tasksDir });
  assert.equal(status, 0);
  assert.equal(report.runs.length, 2);
  const bad = report.runs.find((r) => r.task === 'badsetup');
  const ok = report.runs.find((r) => r.task === 'oktask');
  assert.match(bad.error, /setup\.sh fallo/);
  assert.equal(bad.pass, false);
  assert.equal(ok.error, null);
  assert.equal(ok.pass, true);
});

test('tarea inexistente -> error del runner, exit 1', () => {
  const { status } = runGolden({ behavior: 'noop', args: ['--tasks', 'no-existe'] });
  assert.equal(status, 1);
});

test('matrix default existe y las 12 tareas reales estan completas', () => {
  const matrix = JSON.parse(readFileSync(join(GOLDEN, 'matrix.json'), 'utf8'));
  assert.equal(matrix.length, 2);
  assert.deepEqual(matrix[0], { provider: 'zai', model: 'glm-5.3', thinking: 'medium' });
  const tasks = readdirSync(REAL_TASKS, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(tasks.length, 12);
  for (const t of tasks) {
    for (const f of ['task.md', 'setup.sh', 'gate.sh']) {
      assert.ok(existsSync(join(REAL_TASKS, t.name, f)), `${t.name}: falta ${f}`);
    }
  }
});
