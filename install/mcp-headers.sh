#!/usr/bin/env bash
# Copyright NorthernCaptain, 2026
# MIT license.
#
# headersHelper for the command-center MCP server in Claude Code
# (registered by install/register-mcp.sh). Prints the request headers as
# JSON: the bearer token from <config dir>/token (or $CC_TOKEN) and, when
# the worker runs inside a command-center workspace, X-CC-Task from
# $CC_TASK_ID so the server rejects writes to another task. A PR review
# agent gets X-CC-Review from $CC_REVIEW_ID instead.
#
# Env: CC_CONFIG_DIR (default ~/.config/command-center), CC_TOKEN, CC_TASK_ID,
# CC_REVIEW_ID.

set -euo pipefail

config_dir="${CC_CONFIG_DIR:-$HOME/.config/command-center}"
token="${CC_TOKEN:-}"
if [ -z "$token" ]; then
    if [ ! -r "$config_dir/token" ]; then
        echo "mcp-headers: cannot read $config_dir/token (is the command center running?)" >&2
        exit 1
    fi
    token="$(tr -d '[:space:]' < "$config_dir/token")"
fi
if ! printf '%s' "$token" | grep -Eq '^[A-Za-z0-9._~+/=-]+$'; then
    echo "mcp-headers: token has unexpected characters" >&2
    exit 1
fi

task="${CC_TASK_ID:-}"
review="${CC_REVIEW_ID:-}"
if [ -n "$task" ] && printf '%s' "$task" | grep -Eq '^(T-)?[0-9]{1,9}$'; then
    printf '{"Authorization":"Bearer %s","X-CC-Task":"%s"}\n' "$token" "$task"
elif [ -n "$review" ] && printf '%s' "$review" | grep -Eq '^[0-9]{1,9}$'; then
    printf '{"Authorization":"Bearer %s","X-CC-Review":"%s"}\n' "$token" "$review"
else
    printf '{"Authorization":"Bearer %s"}\n' "$token"
fi
