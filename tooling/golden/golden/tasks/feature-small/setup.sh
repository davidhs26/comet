#!/usr/bin/env bash
set -euo pipefail

cat > clamp.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import { clamp } from './src/clamp.mjs';

assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(11, 0, 10), 10);
assert.equal(clamp(3, 3, 3), 3);
assert.equal(clamp(-4.5, -2, 2), -2);
console.log('ok');
EOF
