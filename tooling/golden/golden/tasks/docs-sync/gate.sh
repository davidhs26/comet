#!/usr/bin/env bash
set -u

grep -qF 'createUser({ name, age, role })' README.md || { echo "falta la firma nueva"; exit 1; }
grep -qi 'role' README.md || { echo "no menciona role"; exit 1; }
grep -q 'admin' README.md || { echo "no menciona admin"; exit 1; }
grep -q 'member' README.md || { echo "no menciona member"; exit 1; }
if grep -qF 'createUser(name, age)' README.md; then
  echo "todavia esta la firma vieja"
  exit 1
fi
exit 0
