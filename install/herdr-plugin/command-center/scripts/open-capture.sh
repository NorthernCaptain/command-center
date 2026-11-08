#!/usr/bin/env bash
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Quick capture action: find the cwd of the pane the action was invoked
# from, then open the plugin's capture popup with that folder as its cwd and
# in CC_CAPTURE_CWD. The cwd comes from, in order: CC_CAPTURE_CWD,
# HERDR_PLUGIN_CONTEXT_JSON (foreground_cwd / cwd of the pane), the pane in
# HERDR_PANE_ID (`herdr pane get`), the focused pane (`herdr pane list`),
# then $HOME.
#
# herdr injects $HERDR_BIN_PATH; fall back to `herdr` on PATH.
set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
plugin_id="${HERDR_PLUGIN_ID:-command-center}"
node_bin="${CC_NODE:-node}"

# Print the first foreground_cwd (else cwd) found in the JSON on stdin.
# $1 = "focused" to look only at the focused pane of a pane list.
json_cwd() {
    "$node_bin" -e '
let raw = ""
process.stdin.on("data", (c) => (raw += c))
process.stdin.on("end", () => {
    let data
    try { data = JSON.parse(raw) } catch { return }
    const focusedOnly = process.argv[1] === "focused"
    const found = { foreground_cwd: null, cwd: null }
    const walk = (v, focused) => {
        if (!v || typeof v !== "object") return
        if (Array.isArray(v)) return v.forEach((x) => walk(x, focused))
        const ok = !focusedOnly || focused || v.focused === true
        for (const k of ["foreground_cwd", "cwd"])
            if (ok && !found[k] && typeof v[k] === "string" && v[k].startsWith("/"))
                found[k] = v[k]
        for (const x of Object.values(v))
            walk(x, focused || v.focused === true)
    }
    walk(data, false)
    const out = found.foreground_cwd || found.cwd
    if (out) process.stdout.write(out)
})' "${1:-any}" 2>/dev/null
}

resolve_cwd() {
    local dir=""
    if [ -n "${CC_CAPTURE_CWD:-}" ]; then
        printf '%s' "$CC_CAPTURE_CWD"
        return
    fi
    if [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
        dir="$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | json_cwd any)"
    fi
    if [ -z "$dir" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
        dir="$("$herdr_bin" pane get "$HERDR_PANE_ID" 2>/dev/null | json_cwd any)"
    fi
    if [ -z "$dir" ]; then
        dir="$("$herdr_bin" pane list 2>/dev/null | json_cwd focused)"
    fi
    if [ -z "$dir" ] || [ ! -d "$dir" ]; then
        dir="$HOME"
    fi
    printf '%s' "$dir"
}

cwd="$(resolve_cwd)"

if [ "${CC_CAPTURE_DRY_RUN:-}" = "1" ]; then
    printf '%s\n' "$cwd"
    exit 0
fi

exec "$herdr_bin" plugin pane open \
    --plugin "$plugin_id" \
    --entrypoint capture \
    --cwd "$cwd" \
    --env "CC_CAPTURE_CWD=$cwd" \
    --focus
