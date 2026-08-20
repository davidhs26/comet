#!/usr/bin/env bash
set -euo pipefail

mkdir -p src

cat > src/range.mjs <<'EOF'
// Devuelve los indices [start, end] (ambos inclusive, 0-based) de la pagina
// `page` (1-based) con `perPage` elementos por pagina.
// Ej: pageRange(1, 10) -> [0, 9]; pageRange(2, 10) -> [10, 19].
export function pageRange(page, perPage) {
  const start = (page - 1) * perPage;
  const end = start + perPage; // BUG: deberia ser start + perPage - 1
  return [start, end];
}
EOF

cat > range.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import { pageRange } from './src/range.mjs';

assert.deepEqual(pageRange(1, 10), [0, 9]);
assert.deepEqual(pageRange(2, 10), [10, 19]);
assert.deepEqual(pageRange(3, 5), [10, 14]);
assert.deepEqual(pageRange(1, 1), [0, 0]);
console.log('ok');
EOF
