#!/usr/bin/env bash
set -euo pipefail

mkdir -p src

cat > src/cart.mjs <<'EOF'
// Total del carrito: suma price*qty de cada item.
export function cartTotal(items) {
  let total = 0;
  for (const it of items) {
    total += it.price; // BUG: no multiplica por qty
  }
  return total;
}
EOF

cat > cart.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import { cartTotal } from './src/cart.mjs';

assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 3 }]), 35);
assert.equal(cartTotal([]), 0);
assert.equal(cartTotal([{ price: 7, qty: 1 }]), 7);
assert.equal(cartTotal([{ price: 2, qty: 0 }, { price: 3, qty: 4 }]), 12);
console.log('ok');
EOF
