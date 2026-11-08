#!/usr/bin/env bash
#
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Expose the tailnet listener (127.0.0.1:7789) on the tailnet only:
#   https://<mac>.<tailnet>.ts.net:8443  ->  http://127.0.0.1:7789
# Never uses `tailscale funnel` (that would publish it to the internet).
#
# The tailnet listener only answers requests whose Host is the host of
# `publicBaseUrl` (DNS-rebinding guard; `tailscale serve` keeps the
# original Host). Set publicBaseUrl in the config, or CC_PUBLIC_BASE_URL,
# to exactly https://<mac>.<tailnet>.ts.net:<CC_HTTPS_PORT>; without it the
# tailnet listener answers every request with 503.
#
# Usage: install/tailscale-serve.sh [on|status|off]
# Env: TAILSCALE_BIN, CC_TAILNET_PORT (default 7789), CC_HTTPS_PORT (8443).

set -euo pipefail

HTTPS_PORT="${CC_HTTPS_PORT:-8443}"
TARGET="http://127.0.0.1:${CC_TAILNET_PORT:-7789}"
APP_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

die() {
    echo "error: $*" >&2
    exit 1
}

ts_bin() {
    if [ -n "${TAILSCALE_BIN:-}" ]; then
        echo "$TAILSCALE_BIN"
    elif [ -x "$APP_BIN" ]; then
        echo "$APP_BIN"
    elif command -v tailscale >/dev/null 2>&1; then
        command -v tailscale
    else
        die "Tailscale CLI not found (set TAILSCALE_BIN)"
    fi
}

TS="$(ts_bin)"

case "${1:-on}" in
    on | start)
        "$TS" serve --bg --https="$HTTPS_PORT" "$TARGET"
        "$TS" serve status
        echo
        echo "Set publicBaseUrl (or CC_PUBLIC_BASE_URL) to the https URL above,"
        echo "e.g. https://<mac>.<tailnet>.ts.net:${HTTPS_PORT}; other Hosts get 421, none 503."
        ;;
    status)
        "$TS" serve status
        ;;
    off | stop)
        "$TS" serve --https="$HTTPS_PORT" off
        ;;
    *)
        die "usage: $0 [on|status|off]"
        ;;
esac
