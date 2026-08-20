#!/usr/bin/env bash
set -euo pipefail

cat > config.json <<'EOF'
{"metric": "top_region_by_total_sales"}
EOF

cat > sales.csv <<'EOF'
region,amount
norte,120
sur,80
norte,30
este,150
sur,50
EOF
