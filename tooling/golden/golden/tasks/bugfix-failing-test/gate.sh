#!/usr/bin/env bash
set -u

node cart.test.mjs >/dev/null 2>&1 || { echo "cart.test.mjs falla"; exit 1; }
exit 0
