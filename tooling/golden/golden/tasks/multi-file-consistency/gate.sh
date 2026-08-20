#!/usr/bin/env bash
set -u

node check.mjs >/dev/null 2>&1 || { echo "check.mjs no corre"; exit 1; }

node --input-type=module <<'EOF' || exit 1
import { MAX_RETRIES as A } from './config/api.mjs';
import { MAX_RETRIES as W } from './config/worker.mjs';
import { MAX_RETRIES as U } from './config/ui.mjs';
if (A !== 5 || W !== 5 || U !== 5) {
  console.error(`inconsistente: api=${A} worker=${W} ui=${U}`);
  process.exit(1);
}
EOF

exit 0
