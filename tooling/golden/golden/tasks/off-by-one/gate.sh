#!/usr/bin/env bash
set -u

node range.test.mjs >/dev/null 2>&1 || { echo "range.test.mjs falla"; exit 1; }
exit 0
