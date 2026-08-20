# Escribir tests

En este workspace hay una función en `src/grade.mjs` que convierte una nota numérica (0–100) a letra (`A`/`B`/`C`/`D`/`F`).

Escribí tests en `grade.test.mjs` (en la raíz del workspace) usando `node:test` y `node:assert/strict`:

- Deben cubrir las 5 ramas (una nota típica por letra).
- Deben cubrir los valores borde: `90`, `80`, `70` y `60`.
- Tienen que pasar con `node --test grade.test.mjs`.

No modifiques `src/grade.mjs`.
