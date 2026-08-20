# Refactor: renombrar función

En este workspace la función `getUserName` está definida en `src/lib.mjs` y se usa en `src/report.mjs` y `src/greet.mjs`.

1. Renombrala a `displayName`: cambiá la definición en `src/lib.mjs` y **todos** los usos en `src/report.mjs` y `src/greet.mjs`.
2. No debe quedar **ninguna** ocurrencia de `getUserName` en el workspace.
3. No cambies el comportamiento: `node main.mjs` debe seguir imprimiendo exactamente lo mismo que antes.
