#!/usr/bin/env bash
# Fetches mechanai/deepreview, moves the local vendor branch pointer to its current
# HEAD, and prints the upstream commit range + changed-file list since the last
# recorded sync. Read-only with respect to the working tree: it only ever moves a
# local branch ref and fetches — it never touches main or the current branch.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$SKILL_DIR/state.json"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

UPSTREAM_URL="https://github.com/mechanai/deepreview.git"
UPSTREAM_BRANCH="$(bun -e "console.log(JSON.parse(await Bun.file('$STATE_FILE').text()).upstream_branch)")"
VENDOR_BRANCH="$(bun -e "console.log(JSON.parse(await Bun.file('$STATE_FILE').text()).vendor_branch)")"
OLD_SHA="$(bun -e "console.log(JSON.parse(await Bun.file('$STATE_FILE').text()).last_synced_upstream_sha)")"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
git fetch upstream "$UPSTREAM_BRANCH" --quiet

NEW_SHA="$(git rev-parse "upstream/$UPSTREAM_BRANCH")"

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  echo "STATUS=UP_TO_DATE"
  echo "SHA=$NEW_SHA"
  exit 0
fi

git branch -f "$VENDOR_BRANCH" "$NEW_SHA" >/dev/null

echo "STATUS=CHANGES_AVAILABLE"
echo "OLD_SHA=$OLD_SHA"
echo "NEW_SHA=$NEW_SHA"
echo
echo "--- upstream commits since last sync ---"
git log --oneline "$OLD_SHA..$NEW_SHA"
echo
echo "--- files changed upstream since last sync ---"
git diff --name-status "$OLD_SHA" "$NEW_SHA"
