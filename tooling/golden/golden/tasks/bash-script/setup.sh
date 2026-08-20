#!/usr/bin/env bash
set -euo pipefail

mkdir -p logs

cat > logs/a.log <<'EOF'
INFO arranque
ERROR fallo conexion
INFO retry
ERROR timeout
ERROR abortado
EOF

cat > logs/b.log <<'EOF'
WARN disco lento
ERROR permiso denegado
ERROR permiso denegado
ERROR permiso denegado
ERROR permiso denegado
INFO fin
EOF

cat > logs/c.log <<'EOF'
INFO todo bien
INFO sin errores
EOF

# Distractor: no es .log, no debe contarse.
cat > logs/notas.txt <<'EOF'
ERROR esto no se cuenta
EOF
