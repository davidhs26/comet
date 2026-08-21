# Script bash: contar errores

En este workspace hay un directorio `logs/` con varios archivos `.log` (y algún archivo que no es `.log`).

Escribí un script `count_errors.sh` (en la raíz del workspace) que:

- Reciba como `$1` un directorio.
- Cuente el **total de líneas que contienen** `ERROR` en todos los archivos `*.log` de ese directorio (no recursivo; solo `*.log`).
- Imprima exactamente una línea: `errors: N` (con N el total, sin espacios extra).

Ejemplo: `bash count_errors.sh logs` debe imprimir `errors: 7`.
