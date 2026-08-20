#!/usr/bin/env bash
set -u

[ -f output.json ] || { echo "output.json no existe"; exit 1; }

node <<'EOF' || exit 1
const assert = require('node:assert/strict');
const fs = require('node:fs');
let out;
try {
  out = JSON.parse(fs.readFileSync('output.json', 'utf8'));
} catch (err) {
  console.error(`output.json no es JSON valido: ${err.message}`);
  process.exit(1);
}
assert.deepEqual(out, {
  adults: ['Ana', 'Eli', 'Mia'],
  byCity: { Lima: 2, Cusco: 2, Arequipa: 1 },
});
EOF

exit 0
