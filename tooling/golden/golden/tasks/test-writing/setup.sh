#!/usr/bin/env bash
set -euo pipefail

mkdir -p src

cat > src/grade.mjs <<'EOF'
// Convierte nota numerica (0-100) a letra.
export function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
EOF
