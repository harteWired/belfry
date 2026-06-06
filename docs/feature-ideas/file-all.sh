#!/usr/bin/env bash
# Files every issue body in this directory as a GitHub issue on harteWired/belfry.
# Run after `gh auth login`. Idempotency: re-running creates duplicates — open
# issues yourself and remove the corresponding .md before re-running, or use
# --dry-run to preview.
#
# Usage:
#   ./file-all.sh             # files all 5 issues
#   ./file-all.sh --dry-run   # prints what would be filed, exits

set -euo pipefail

cd "$(dirname "$0")"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh not found. Install GitHub CLI: https://cli.github.com" >&2
  exit 1
fi

# --dry-run shouldn't need auth — the user is just previewing.
if [[ "$DRY" == "0" ]] && ! gh auth status >/dev/null 2>&1; then
  echo "error: gh not authenticated. Run \`gh auth login\` first." >&2
  exit 1
fi

REPO="harteWired/belfry"
filed=0
for f in *.md; do
  [[ "$f" == "README.md" ]] && continue
  # Title is the first HTML comment of the form <!-- title: ... -->
  title=$(grep -m1 -oE '<!-- title: .* -->' "$f" | sed -E 's/<!-- title: (.*) -->/\1/')
  if [[ -z "$title" ]]; then
    echo "skip: $f has no <!-- title: ... --> marker" >&2
    continue
  fi
  if [[ "$DRY" == "1" ]]; then
    echo "DRY: gh issue create --repo $REPO --title \"$title\" --body-file $f"
    continue
  fi
  echo "filing: $title"
  gh issue create --repo "$REPO" --title "$title" --body-file "$f"
  filed=$((filed + 1))
done

if [[ "$DRY" == "0" ]]; then
  echo "filed $filed issue(s)"
fi
