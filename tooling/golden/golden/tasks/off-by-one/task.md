# Bugfix: off-by-one

En este workspace hay una función con un off-by-one (`src/range.mjs`) y un test (`range.test.mjs`) que falla.

1. Corré `node range.test.mjs` para ver el fallo.
2. Corregí el off-by-one **solo en `src/range.mjs`**. No modifiques el test.
3. Terminá cuando `node range.test.mjs` imprima `ok` y salga con código 0.
