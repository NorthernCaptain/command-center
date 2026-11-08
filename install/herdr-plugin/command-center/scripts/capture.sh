#!/usr/bin/env bash
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Quick capture popup: read one line, then `cc add` it with the folder the
# capture was started from as context. An empty line (or Ctrl-D) cancels.
# The popup closes when this script exits.
#
# The `cc` CLI is run from this repo (the plugin is a symlink into
# install/herdr-plugin/), not from PATH: on macOS `cc` is the C compiler.
# Overrides: CC_BIN (a cc executable), CC_NODE (node binary).
set -uo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -P "$script_dir/../../../.." && pwd)"
cwd="${CC_CAPTURE_CWD:-$PWD}"

run_cc() {
    if [ -n "${CC_BIN:-}" ]; then
        "$CC_BIN" "$@"
    else
        "${CC_NODE:-node}" "$repo/cli/cc.js" "$@"
    fi
}

printf 'Quick capture → Command Center\n'
printf 'Context: %s\n' "$cwd"
printf '(Enter to save, empty line or Ctrl-D to cancel)\n\n'

text=""
if ! IFS= read -r -e -p "> " text; then
    exit 0
fi
# trim surrounding whitespace
text="$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -z "$text" ]; then
    exit 0
fi

body="$text

Captured in herdr from: $cwd"

if run_cc add -- "$body"; then
    sleep 1
    exit 0
fi
printf '\nCapture failed. Press Enter to close.'
IFS= read -r _ || true
exit 1
