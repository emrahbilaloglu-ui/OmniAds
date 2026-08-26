#!/usr/bin/env bash
#
# Whitespace damage, in the working tree and in this branch's own commits.
#
# `git diff --check` is the tool git already ships for this: trailing
# whitespace, space-before-tab, and a file whose last line has no newline. It
# was not in any gate, so a trailing-space line reached a commit and stayed
# there through a full pass of typecheck, lint, Vitest and the browser sweep —
# none of which look at bytes nobody can see.
#
# Two ranges, because they answer different questions:
#
#   * the working tree, so damage is caught before it is committed;
#   * <base>..HEAD as a TREE diff, so the branch is judged on the state it
#     actually proposes rather than on every intermediate commit. A line that
#     was introduced with trailing space and later cleaned reads as clean here,
#     which is correct — history is not what merges.
#
# The base defaults to the merge-base with the default branch. Override with
# WHITESPACE_BASE for a different range; the gate prints whichever it used, so
# a passing run says what it proved rather than just that it passed.
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_BRANCH="${WHITESPACE_DEFAULT_BRANCH:-main}"

if [[ -n "${WHITESPACE_BASE:-}" ]]; then
  base="$WHITESPACE_BASE"
elif base="$(git merge-base "$DEFAULT_BRANCH" HEAD 2>/dev/null)"; then
  :
else
  # A repo with no such branch (a fresh clone of a single branch, a worktree
  # cut from a tag) still deserves the working-tree half rather than an error.
  base=""
fi

status=0

if ! git diff --check; then
  echo "FAIL: the working tree has whitespace damage (shown above)." >&2
  status=1
fi

if ! git diff --check --cached; then
  echo "FAIL: the index has whitespace damage (shown above)." >&2
  status=1
fi

if [[ -n "$base" ]]; then
  if ! git diff --check "$base..HEAD"; then
    echo "FAIL: $(git rev-parse --short "$base")..HEAD introduces whitespace damage (shown above)." >&2
    status=1
  fi
fi

if [[ "$status" -eq 0 ]]; then
  if [[ -n "$base" ]]; then
    echo "PASS: no whitespace damage in the working tree, the index, or $(git rev-parse --short "$base")..$(git rev-parse --short HEAD)."
  else
    echo "PASS: no whitespace damage in the working tree or the index (no base branch to compare against)."
  fi
fi

exit "$status"
