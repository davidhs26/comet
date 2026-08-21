# Feature: función clamp

Implementá una función nueva según esta spec:

- Archivo: `src/clamp.mjs` (tenés que crearlo; `src/` puede no existir).
- Export nombrado: `clamp(value, min, max)`.
- Devuelve `value` acotado al rango `[min, max]`:
  - si `value < min` devuelve `min`
  - si `value > max` devuelve `max`
  - si no, devuelve `value`

Hay tests visibles en `clamp.test.mjs`. Terminá cuando `node clamp.test.mjs` imprima `ok` y salga con código 0. No modifiques el test.
