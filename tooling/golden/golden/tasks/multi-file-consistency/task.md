# Consistencia multi-archivo

La constante `MAX_RETRIES` está definida (duplicada) en tres archivos:

- `config/api.mjs`
- `config/worker.mjs`
- `config/ui.mjs`

Cambiá su valor de `3` a `5` en **los tres** archivos, dejando todo lo demás igual. `node check.mjs` debe seguir corriendo sin errores.
