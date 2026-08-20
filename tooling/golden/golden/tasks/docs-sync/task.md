# Docs sync: README desactualizado

El código de `src/api.mjs` cambió pero el `README.md` documenta la firma vieja.

La firma nueva es: `createUser({ name, age, role })` — recibe un único objeto; `role` es **requerido** y vale `"admin"` o `"member"`.

Actualizá la sección `## API` del `README.md`:

- La firma documentada debe quedar escrita exactamente como `createUser({ name, age, role })`.
- Debe mencionar que `role` es requerido y sus valores posibles (`"admin"` o `"member"`).
- No debe quedar la firma vieja `createUser(name, age)`.

No modifiques `src/api.mjs`.
