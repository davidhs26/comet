#!/usr/bin/env bash
set -euo pipefail

mkdir -p src

cat > README.md <<'EOF'
# mini-users

Libreria minima de usuarios.

## API

### createUser(name, age)

Crea un usuario con `name` (string) y `age` (number).

Ejemplo:

```js
createUser("Ana", 34);
```
EOF

cat > src/api.mjs <<'EOF'
// Firma NUEVA (v2): recibe un unico objeto. role es requerido.
export function createUser({ name, age, role }) {
  if (role !== 'admin' && role !== 'member') {
    throw new Error('role debe ser "admin" o "member"');
  }
  return { name, age, role };
}
EOF
