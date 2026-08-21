#!/usr/bin/env bash
set -u

[ -f purchases.csv ] || { echo "purchases.csv no existe"; exit 1; }

diff -u purchases.csv - <<'EOF'
timestamp,user,duration_ms
2024-03-01T08:02:31Z,luis,210
2024-03-01T08:05:47Z,mia,98
EOF
