#!/usr/bin/env bash
set -u

node lru.test.mjs >/dev/null 2>&1 || { echo "lru.test.mjs falla"; exit 1; }
exit 0
