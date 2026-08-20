#!/usr/bin/env bash
set -euo pipefail

mkdir -p src

cat > src/lib.mjs <<'EOF'
export function getUserName(u) {
  return `${u.first} ${u.last}`;
}
EOF

cat > src/report.mjs <<'EOF'
import { getUserName } from './lib.mjs';

export function reportLine(u) {
  return `Usuario: ${getUserName(u)}`;
}
EOF

cat > src/greet.mjs <<'EOF'
import { getUserName } from './lib.mjs';

export function greet(u) {
  return `Hola, ${getUserName(u)}`;
}
EOF

cat > main.mjs <<'EOF'
import { reportLine } from './src/report.mjs';
import { greet } from './src/greet.mjs';

const u = { first: 'Ada', last: 'Lovelace' };
console.log(reportLine(u));
console.log(greet(u));
EOF
