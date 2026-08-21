#!/usr/bin/env bash
set -euo pipefail

cat > lru.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import { LRUCache } from './lru.mjs';

const c = new LRUCache(2);
c.put('a', 1);
c.put('b', 2);
assert.equal(c.get('a'), 1);      // a queda reciente; b es el LRU
c.put('c', 3);                     // expulsa b
assert.equal(c.get('b'), -1);
assert.equal(c.get('a'), 1);
c.put('d', 4);                     // expulsa c
assert.equal(c.get('c'), -1);
assert.equal(c.get('d'), 4);
c.put('a', 9);                     // update no crece ni expulsa
assert.equal(c.get('a'), 9);
assert.equal(c.get('d'), 4);

const one = new LRUCache(1);
one.put('x', 10);
one.put('y', 20);
assert.equal(one.get('x'), -1);
assert.equal(one.get('y'), 20);
console.log('ok');
EOF
