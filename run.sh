#!/usr/bin/env bash
# Same as ./depthmap (kept for people who look for run.sh).
exec "$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/depthmap" "$@"
