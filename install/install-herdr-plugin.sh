#!/usr/bin/env bash
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Install the Command Center herdr plugin (Quick capture action).
#
# Usage:
#   install/install-herdr-plugin.sh [--dry-run]              install / repair
#   install/install-herdr-plugin.sh --uninstall [--dry-run]  unlink + remove
#
# Symlinks install/herdr-plugin/command-center to
# $CC_HERDR_PLUGIN_DIR/command-center (default ~/.config/herdr/local-plugins)
# and registers it with `herdr plugin link`. Idempotent: a correct symlink
# and an already linked plugin are left alone; a symlink pointing elsewhere
# is replaced; a real file or folder in the way is an error.
# --dry-run prints what would be done without changing anything.
# Env overrides: CC_HERDR_BIN (herdr binary), CC_HERDR_PLUGIN_DIR.
# Bind the action in herdr afterwards (plugin "command-center", action
# "quick-capture").

set -euo pipefail

PLUGIN_ID="command-center"
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/herdr-plugin/$PLUGIN_ID"
LINK_DIR="${CC_HERDR_PLUGIN_DIR:-$HOME/.config/herdr/local-plugins}"
LINK="$LINK_DIR/$PLUGIN_ID"
HERDR="${CC_HERDR_BIN:-herdr}"

DRY_RUN=0
MODE="install"

die() {
    echo "error: $*" >&2
    exit 1
}

usage() {
    sed -n '5,9p' "$0" | sed 's/^# \{0,1\}//'
}

# Print, and run unless --dry-run.
run() {
    echo "+ $*"
    if [ "$DRY_RUN" -eq 0 ]; then
        "$@"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run | -n) DRY_RUN=1 ;;
        --uninstall) MODE="uninstall" ;;
        -h | --help)
            usage
            exit 0
            ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
    shift
done

have_herdr() {
    command -v "$HERDR" >/dev/null 2>&1
}

# True when herdr lists the plugin id.
is_linked() {
    have_herdr || return 1
    "$HERDR" plugin list 2>/dev/null | grep -Eq "^- $PLUGIN_ID( |$)"
}

# True when herdr lists the plugin id as disabled.
is_disabled() {
    have_herdr || return 1
    "$HERDR" plugin list 2>/dev/null | grep -Eq "^- $PLUGIN_ID .* disabled( |$)"
}

install_plugin() {
    [ -f "$SRC/herdr-plugin.toml" ] || die "plugin manifest not found: $SRC"

    for f in "$SRC"/scripts/*.sh; do
        [ -x "$f" ] || run chmod +x "$f"
    done

    if [ ! -d "$LINK_DIR" ]; then
        run mkdir -p "$LINK_DIR"
    fi

    if [ -L "$LINK" ]; then
        local target
        target="$(readlink "$LINK")"
        if [ "$target" = "$SRC" ]; then
            echo "symlink ok: $LINK -> $SRC"
        else
            echo "symlink points to $target; replacing"
            run ln -sfn "$SRC" "$LINK"
        fi
    elif [ -e "$LINK" ]; then
        die "$LINK exists and is not a symlink; move it away first"
    else
        run ln -s "$SRC" "$LINK"
    fi

    if ! have_herdr; then
        echo "herdr not found; link it later with: herdr plugin link $LINK"
        return 0
    fi
    if is_linked; then
        echo "herdr plugin already linked: $PLUGIN_ID"
    else
        # Not `link --enabled <path>`: herdr 0.9.5 rejects an existing path
        # after that flag ("unknown option: <path>"). Link, then enable.
        run "$HERDR" plugin link "$LINK"
    fi
    if is_disabled; then
        run "$HERDR" plugin enable "$PLUGIN_ID"
    fi
    echo "done. Bind herdr action \"$PLUGIN_ID\" / \"quick-capture\" to a key."
}

uninstall_plugin() {
    if is_linked; then
        run "$HERDR" plugin unlink "$PLUGIN_ID"
    else
        echo "herdr plugin not linked: $PLUGIN_ID"
    fi
    if [ -L "$LINK" ]; then
        run rm "$LINK"
    elif [ -e "$LINK" ]; then
        die "$LINK is not a symlink; not removing it"
    else
        echo "no symlink at $LINK"
    fi
}

if [ "$DRY_RUN" -eq 1 ]; then
    echo "(dry run: nothing is changed)"
fi
case "$MODE" in
    install) install_plugin ;;
    uninstall) uninstall_plugin ;;
esac
