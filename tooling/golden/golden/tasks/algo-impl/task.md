# Implementar LRU cache

Implementá un LRU cache según esta spec:

- Archivo: `lru.mjs` (en la raíz del workspace; tenés que crearlo).
- Export nombrado: `class LRUCache`.
- `new LRUCache(capacity)` — capacidad máxima de claves.
- `get(key)` — devuelve el valor o `-1` si la clave no está. Cuenta como uso.
- `put(key, value)` — inserta o actualiza. Cuenta como uso. Si al insertar se supera `capacity`, se expulsa la clave **menos recientemente usada**.

Hay tests visibles en `lru.test.mjs`. Terminá cuando `node lru.test.mjs` imprima `ok` y salga con código 0. No modifiques el test.
