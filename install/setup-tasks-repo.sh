#!/usr/bin/env bash
#
# Copyright NorthernCaptain, 2026
# MIT license.
#
# Create the task data repo: a standalone git repo (never part of the code
# repo, so task content can't be pushed with the code). The store commits
# task folders there on one branch and never pushes.
#
# Usage: install/setup-tasks-repo.sh [dir] [branch]
#   dir     default: $CC_TASKS_DIR, else <code repo>/tasks (git-ignored)
#   branch  default: $CC_TASKS_BRANCH, else "tasks"; must match
#           config.json git.branch (default "tasks")
# Idempotent: an existing repo on that branch is left as it is.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
DIR="${1:-${CC_TASKS_DIR:-$CODE_REPO/tasks}}"
BRANCH="${2:-${CC_TASKS_BRANCH:-tasks}}"

die() {
    echo "error: $*" >&2
    exit 1
}

if [ -e "$DIR/.git" ]; then
    top="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || true)"
    [ "$(cd "$top" 2>/dev/null && pwd -P)" = "$(cd "$DIR" && pwd -P)" ] ||
        die "$DIR is inside another git work tree ($top); use a standalone repo"
    # a linked worktree (e.g. the old orphan "tasks" branch of the code repo)
    # shares the code repo's objects and refs: not a separate repo
    git_dir="$(cd "$DIR" && cd "$(git rev-parse --git-dir)" && pwd -P)"
    common_dir="$(cd "$DIR" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
    if [ "$git_dir" != "$common_dir" ]; then
        cat >&2 <<MSG
error: $DIR is a linked worktree of the repo at ${common_dir%/.git}, so task
data shares that repo's history and refs. Move it into a standalone repo:

    install/setup-tasks-repo.sh <new-dir> <branch>
    git -C <new-dir> fetch ${common_dir%/.git} <branch> && git -C <new-dir> checkout -B <branch> FETCH_HEAD
    git -C ${common_dir%/.git} worktree remove $DIR && git -C ${common_dir%/.git} branch -D <branch>

then set tasksDir (and git.branch) in ~/.config/command-center/config.json.
MSG
        exit 1
    fi
    # the code repo itself (or anything sharing its storage) is never the
    # task data repo: task content would be committed into the code repo
    code_common="$(cd "$CODE_REPO" && git rev-parse --git-common-dir 2>/dev/null)" ||
        code_common=""
    if [ -n "$code_common" ]; then
        code_common="$(cd "$CODE_REPO" && cd "$code_common" && pwd -P)"
        [ "$common_dir" = "$code_common" ] &&
            die "$DIR uses the code repo's git storage ($code_common); create a separate repo for task data"
    fi
    current="$(git -C "$DIR" symbolic-ref --short HEAD 2>/dev/null || true)"
    [ "$current" = "$BRANCH" ] ||
        die "$DIR is on branch '${current:-?}', expected '$BRANCH' (set git.branch in config.json)"
    echo "task data repo already present at $DIR (branch $BRANCH)"
    exit 0
fi
if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and is not empty; move it away first"
fi

mkdir -p "$DIR"
git -C "$DIR" init -q -b "$BRANCH"
echo "created task data repo at $DIR (branch $BRANCH)"
if [ "$BRANCH" != "tasks" ]; then
    echo "set \"git\": { \"branch\": \"$BRANCH\" } in ~/.config/command-center/config.json"
fi
case "$DIR" in
    "$CODE_REPO/tasks") ;;
    *) echo "set \"tasksDir\": \"$DIR\" in ~/.config/command-center/config.json (or CC_TASKS_DIR)" ;;
esac
