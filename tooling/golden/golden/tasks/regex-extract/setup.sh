#!/usr/bin/env bash
set -euo pipefail

cat > app.log <<'EOF'
2024-03-01T08:00:12Z INFO user=ana action=login duration_ms=45
2024-03-01T08:02:31Z INFO user=luis action=purchase duration_ms=210
2024-03-01T08:03:05Z ERROR user=ana action=logout duration_ms=12
2024-03-01T08:05:47Z INFO user=mia action=purchase duration_ms=98
2024-03-01T08:07:20Z INFO user=luis action=login duration_ms=30
2024-03-01T08:09:44Z WARN user=mia action=purchase_cancelled duration_ms=5
EOF
