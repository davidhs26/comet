#!/usr/bin/env bash
set -u

# El nombre viejo no debe existir en ningun archivo.
if grep -r "getUserName" . >/dev/null 2>&1; then
  echo "todavia existe getUserName"
  exit 1
fi

# El nombre nuevo debe estar en los 3 archivos.
for f in src/lib.mjs src/report.mjs src/greet.mjs; do
  grep -q "displayName" "$f" || { echo "$f no usa displayName"; exit 1; }
done

# Comportamiento intacto.
out="$(node main.mjs 2>/dev/null)" || { echo "main.mjs no corre"; exit 1; }
expected="Usuario: Ada Lovelace
Hola, Ada Lovelace"
[ "$out" = "$expected" ] || { echo "salida distinta: $out"; exit 1; }
exit 0
