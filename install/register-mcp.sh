#!/usr/bin/env bash
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Register the command-center MCP server and the worker skill for Claude
# Code and Codex. Idempotent; backs up every file it changes; never prints
# the token.
#
# Usage: install/register-mcp.sh [--dry-run] [--no-claude] [--no-codex]
#                                [--url http://127.0.0.1:7788/mcp]
#                                [--home DIR] [--token-file FILE]
#
#   Claude: ~/.claude.json mcpServers."command-center" (http + headersHelper
#           install/mcp-headers.sh), skill symlink ~/.claude/skills/command-center
#   Codex:  marked block in ~/.codex/config.toml (0600, holds the token),
#           skill symlink ~/.codex/skills/command-center
#
# The logic lives in install/register-mcp.mjs (tested); this is a wrapper.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v node >/dev/null 2>&1 || {
    echo "error: node not found" >&2
    exit 1
}

for arg in "$@"; do
    case "$arg" in
        -h|--help)
            sed -n '4,17p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
    esac
done

dry=0
for arg in "$@"; do
    [ "$arg" = "--dry-run" ] && dry=1
done

if [ "$dry" -eq 0 ] && [ ! -x "$SCRIPT_DIR/mcp-headers.sh" ]; then
    chmod 0755 "$SCRIPT_DIR/mcp-headers.sh"
    echo "made executable: $SCRIPT_DIR/mcp-headers.sh"
fi

exec node "$SCRIPT_DIR/register-mcp.mjs" --repo "$REPO" "$@"
