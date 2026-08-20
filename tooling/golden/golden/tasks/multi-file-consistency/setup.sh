#!/usr/bin/env bash
set -euo pipefail

mkdir -p config

cat > config/api.mjs <<'EOF'
export const MAX_RETRIES = 3;
export const API_TIMEOUT_MS = 2000;
EOF

cat > config/worker.mjs <<'EOF'
export const MAX_RETRIES = 3;
export const QUEUE_NAME = 'jobs';
EOF

cat > config/ui.mjs <<'EOF'
export const MAX_RETRIES = 3;
export const THEME = 'dark';
EOF

cat > check.mjs <<'EOF'
import { MAX_RETRIES as A, API_TIMEOUT_MS } from './config/api.mjs';
import { MAX_RETRIES as W, QUEUE_NAME } from './config/worker.mjs';
import { MAX_RETRIES as U, THEME } from './config/ui.mjs';

if (API_TIMEOUT_MS !== 2000 || QUEUE_NAME !== 'jobs' || THEME !== 'dark') {
  throw new Error('se tocaron constantes que no correspondia');
}
console.log(`retries: api=${A} worker=${W} ui=${U}`);
EOF
