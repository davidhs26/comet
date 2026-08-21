#!/usr/bin/env bash
set -u

[ -f count_errors.sh ] || { echo "count_errors.sh no existe"; exit 1; }

bash -n count_errors.sh || { echo "count_errors.sh tiene errores de sintaxis"; exit 1; }

out="$(bash count_errors.sh logs 2>/dev/null)" || { echo "count_errors.sh salio con error"; exit 1; }
[ "$out" = "errors: 7" ] || { echo "esperaba 'errors: 7', salio '$out'"; exit 1; }
exit 0
