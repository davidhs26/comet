#!/usr/bin/env bash
set -u

node clamp.test.mjs >/dev/null 2>&1 || { echo "clamp.test.mjs falla"; exit 1; }
exit 0
