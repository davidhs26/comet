#!/usr/bin/env bash
set -u

[ -f answer.txt ] || { echo "answer.txt no existe"; exit 1; }

expected="$(node <<'EOF'
const fs = require('node:fs');
const lines = fs.readFileSync('sales.csv', 'utf8').trim().split('\n').slice(1);
const totals = {};
for (const l of lines) {
  const [r, a] = l.split(',');
  totals[r] = (totals[r] || 0) + Number(a);
}
const best = Object.keys(totals).sort().reduce((b, r) => (totals[r] > totals[b] ? r : b));
console.log(`${best} ${totals[best]}`);
EOF
)"

actual="$(head -n 1 answer.txt | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
[ "$actual" = "$expected" ] || { echo "esperaba '$expected', salio '$actual'"; exit 1; }
exit 0
