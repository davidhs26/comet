#!/usr/bin/env bash
set -u

[ -f grade.test.mjs ] || { echo "grade.test.mjs no existe"; exit 1; }

# 1. Los tests del agente pasan contra el codigo original.
node --test grade.test.mjs >/dev/null 2>&1 || { echo "los tests no pasan"; exit 1; }

# 2. Inyectamos un bug (>= pasa a >) y los tests deben detectarlo.
cp src/grade.mjs src/grade.mjs.gatebak
trap 'mv -f src/grade.mjs.gatebak src/grade.mjs' EXIT
sed -i 's/>=/>/g' src/grade.mjs

if node --test grade.test.mjs >/dev/null 2>&1; then
  echo "los tests NO detectan la mutacion (cobertura insuficiente)"
  exit 1
fi
exit 0
