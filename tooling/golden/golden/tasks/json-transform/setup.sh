#!/usr/bin/env bash
set -euo pipefail

cat > data.json <<'EOF'
[
  {"name": "Ana", "age": 34, "city": "Lima"},
  {"name": "Luis", "age": 15, "city": "Cusco"},
  {"name": "Mia", "age": 22, "city": "Lima"},
  {"name": "Noa", "age": 17, "city": "Cusco"},
  {"name": "Eli", "age": 41, "city": "Arequipa"}
]
EOF
