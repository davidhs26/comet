# Golden suite de regresión — harness pi (ID01-452)

Suite de regresión: corre las 12 tareas de `golden/tasks/` contra cada config
de `golden/matrix.json` y reporta pass/fail, tokens y wall clock por modelo.

## Requisitos

- Node >= 20 y bash en PATH.
- El binario `pi` en PATH (o setear `PI_BIN`).

## Cómo correr en la Beelink

```bash
# toda la matriz: 12 tareas x 2 configs
node golden/run.mjs

# subset de tareas y/o de configs del matrix (indices 1-based)
node golden/run.mjs --tasks bugfix-failing-test,read-answer --models 1

# reporte JSON (además de la tabla humana)
node golden/run.mjs --json --out report.json

# otro matrix
node golden/run.mjs --matrix mi-matrix.json
```

Notas:

- Timeout por tarea: 300s default; se overridea por tarea con
  `golden/tasks/<id>/task.json` → `{"timeoutMs": ...}`. Al vencer: SIGTERM y
  a los 10s SIGKILL.
- Tokens: se leen del session file más nuevo de `~/.pi/agent/sessions/<dir>/`
  (el dir es el cwd del workspace con `/` → `-`, envuelto en `--`). Si pi no
  dejó session file, `tokens` queda `null` y no es error.
- Exit code: 0 si corrió toda la matriz (aunque haya gates fallidos);
  1 solo ante error del runner.
- Los workspaces efímeros se borran al terminar cada corrida; con
  `PI_GOLDEN_KEEP=1` se conservan (la ruta queda en el run como `workspace`).
- `PI_BIN` puede apuntar a un script `.mjs`/`.js` (se ejecuta con el node
  actual) — así se enchufa el pi falso de los tests.

## Tests del runner (con pi falso, sin red)

```bash
node --test golden/run.test.mjs
```
