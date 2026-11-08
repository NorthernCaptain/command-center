#!/usr/bin/env bash
#
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Install the command center as a per-user LaunchAgent.
#
# Usage:
#   install/install-launchd.sh [install]   render plist, (re)load the agent
#   install/install-launchd.sh print       print the rendered plist only
#   install/install-launchd.sh uninstall   unload and remove the plist
#   install/install-launchd.sh status      show launchd state
#
# Env overrides: CC_NODE (node binary), CC_REPO (repo dir),
# CC_LAUNCHD_PATH (PATH for the service; default: current PATH),
# CC_LAUNCHD_AGENTS_DIR and CC_LAUNCHCTL (tests).
# Idempotent: an already loaded agent is booted out before bootstrap.
# Legacy installs: any other *.command-center.plist in the LaunchAgents dir
# whose WorkingDirectory is exactly this checkout (an earlier label) is stopped and removed by
# install and uninstall, so two services never run against the same data.

set -euo pipefail

LABEL="local.command-center"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${CC_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
AGENTS_DIR="${CC_LAUNCHD_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${CC_LAUNCHCTL:-launchctl}"
PLIST="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="$REPO/data/logs"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

die() {
    echo "error: $*" >&2
    exit 1
}

resolve_node() {
    local node="${CC_NODE:-}"
    if [ -z "$node" ]; then
        node="$(command -v node || true)"
    fi
    [ -n "$node" ] && [ -x "$node" ] || die "node not found (set CC_NODE)"
    # Resolve symlinks portably (no GNU readlink -f).
    node="$(cd "$(dirname "$node")" && pwd -P)/$(basename "$node")"
    local major
    major="$("$node" -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 22 ] || die "node >= 22 required, found $("$node" -v) at $node"
    echo "$node"
}

render() {
    local node="$1"
    [ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"
    local svc_path="${CC_LAUNCHD_PATH:-$(dirname "$node"):$PATH}"
    # perl does the substitution so paths with / & | are safe; values are
    # XML-escaped.
    CC_T_LABEL="$LABEL" CC_T_NODE="$node" CC_T_REPO="$REPO" \
        CC_T_PATH="$svc_path" CC_T_HOME="$HOME" CC_T_LOG_DIR="$LOG_DIR" \
        perl -pe '
            sub x { my $v = shift; $v =~ s/&/&amp;/g; $v =~ s/</&lt;/g;
                    $v =~ s/>/&gt;/g; return $v }
            s/__(LABEL|NODE|REPO|PATH|HOME|LOG_DIR)__/x($ENV{"CC_T_$1"})/ge
        ' "$TEMPLATE"
}

is_loaded() {
    "$LAUNCHCTL" print "$DOMAIN/${1:-$LABEL}" >/dev/null 2>&1
}

# bootout_if_loaded [label]: stop the agent (default: ours) if it is loaded.
bootout_if_loaded() {
    local label="${1:-$LABEL}"
    if is_loaded "$label"; then
        echo "stopping loaded $label"
        "$LAUNCHCTL" bootout "$DOMAIN/$label" 2>/dev/null || true
        # bootout is asynchronous; wait up to ~10s for it to disappear.
        local i=0
        while is_loaded "$label" && [ "$i" -lt 20 ]; do
            sleep 0.5
            i=$((i + 1))
        done
        is_loaded "$label" && die "$label is still loaded after bootout"
    fi
    return 0
}

# Canonical path of a directory (empty when it does not exist).
canon() {
    (cd "$1" 2>/dev/null && pwd -P) || true
}

# Other *.command-center.plist files that run this checkout (earlier labels):
# their WorkingDirectory is exactly this checkout (not a sibling such as
# command-center-other).
legacy_plists() {
    local p wd here
    here="$(canon "$REPO")"
    for p in "$AGENTS_DIR"/*.command-center.plist; do
        [ -f "$p" ] || continue
        [ "$p" = "$PLIST" ] && continue
        wd="$(plutil -extract WorkingDirectory raw -o - "$p" 2>/dev/null || true)"
        [ -n "$wd" ] || continue
        [ "$wd" = "$REPO" ] || [ "$(canon "$wd")" = "$here" ] || continue
        echo "$p"
    done
    return 0
}

# Stop and remove legacy agents of this checkout.
remove_legacy() {
    local p label
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        label="$(basename "$p" .plist)"
        bootout_if_loaded "$label"
        "$LAUNCHCTL" disable "$DOMAIN/$label" 2>/dev/null || true
        rm -f "$p"
        echo "removed legacy $label ($p)"
    done < <(legacy_plists)
}

cmd="${1:-install}"
case "$cmd" in
    print)
        render "$(resolve_node)"
        ;;
    install)
        [ -f "$REPO/server/src/index.js" ] ||
            echo "warning: $REPO/server/src/index.js does not exist yet" >&2
        node="$(resolve_node)"
        mkdir -p "$AGENTS_DIR" "$LOG_DIR"
        tmp="$(mktemp "$AGENTS_DIR/.$LABEL.XXXXXX")"
        trap 'rm -f "$tmp"' EXIT
        render "$node" >"$tmp"
        plutil -lint "$tmp" >/dev/null || die "rendered plist is invalid"
        chmod 0644 "$tmp"
        mv "$tmp" "$PLIST"
        trap - EXIT
        remove_legacy
        bootout_if_loaded
        "$LAUNCHCTL" enable "$SERVICE" 2>/dev/null || true
        "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
        echo "installed $PLIST"
        echo "node: $node"
        echo "logs: $LOG_DIR"
        ;;
    uninstall)
        remove_legacy
        bootout_if_loaded
        rm -f "$PLIST"
        echo "uninstalled $LABEL"
        ;;
    status)
        if is_loaded; then
            "$LAUNCHCTL" print "$SERVICE" | awk '/state =|pid =|last exit code/'
        else
            echo "$LABEL is not loaded"
        fi
        ;;
    *)
        die "usage: $0 [install|print|uninstall|status]"
        ;;
esac
