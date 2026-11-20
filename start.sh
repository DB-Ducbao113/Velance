#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 24+ is required on PATH.' >&2
    exit 1
fi
if [ "$#" -eq 0 ]; then
    set -- --port 8080
fi
exec node tools/p7/free-staging.mjs --mode review "$@"
