#!/usr/bin/env bash
# The approval.md tool ref must be on approval.md main (B-167N fold 1 M4, review-b's
# refute CLAIMS L18667, lead RULING L18671).
#
# The check compares the overlay's expected.json with the copy approval.md pins
# (scripts/overlay-recipes/expected.json, PIN_EXPECTED in its ci.yml), read from the
# tool checkout. That checkout's commit is chosen in this repo's test.yml, so without
# this step an overlay PR could point it at any approval.md commit carrying matching
# bytes (an unmerged branch, a fork PR's head) and pass. Here the commit actually
# checked out must be an ancestor of approval.md main, so its pinned copy, its check
# and its pins are ones approval.md merged after its own review.
#
# Usage: tool-ref-on-main.sh <tool checkout dir> [<approval.md repo url>]
# Exit: 0 on main, 1 not on main, 2 usage or a fetch that failed.
set -euo pipefail

dir=${1:-}
url=${2:-https://github.com/approval-md/approval.md.git}
[ -n "$dir" ] || { echo "usage: tool-ref-on-main.sh <tool checkout dir> [<approval.md repo url>]" >&2; exit 2; }
ref=$(git -C "$dir" rev-parse --verify -q 'HEAD^{commit}') || { echo "tool-ref-on-main: $dir is no git checkout" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q
# Commits only (no trees, no blobs): enough to walk main's history.
if ! git -C "$work" fetch -q --no-tags --filter=tree:0 "$url" +refs/heads/main:refs/remotes/approval-md/main 2>"$work/fetch.err"; then
  echo "tool-ref-on-main: could not fetch approval.md main from $url: $(head -c 400 "$work/fetch.err")" >&2
  exit 2
fi
main_sha=$(git -C "$work" rev-parse refs/remotes/approval-md/main)
if git -C "$work" merge-base --is-ancestor "$ref" refs/remotes/approval-md/main 2>/dev/null; then
  echo "tool-ref-on-main: approval.md tool ref $ref is on approval.md main (${main_sha:0:12})"
  exit 0
fi
echo "::error::the approval.md tool ref $ref is not on approval.md main (${main_sha:0:12}): the pinned expected.json and the check must be ones approval.md merged. Move the ref in test.yml to a commit on approval.md main (B-167N fold 1 M4)."
exit 1
