#!/usr/bin/env bash
# Report and (optionally) dry-run this fork's sync onto upstream/master.
# Never auto-pushes and never touches the checked-out working tree.
# Resolution guidance lives in docs/upstream-sync.md.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git fetch upstream

INCOMING=$(git rev-list --count main..upstream/master)
LOCAL=$(git rev-list --count upstream/master..main)

echo "upstream: $(git rev-parse --short upstream/master)  ($INCOMING commits ahead of main)"
echo "local:    $(git rev-parse --short main)  ($LOCAL commits on top)"
echo
echo "local commits to preserve:"
git log --oneline upstream/master..main
echo
echo "git cherry vs upstream (a '-' prefix = already upstream, safe to drop; '+' = still local-only):"
git cherry upstream/master main || true

if [[ "${1:-}" == "--dry-run" ]]; then
  tmp=$(mktemp -d)
  echo
  echo "dry-run rebase in $tmp ..."
  git worktree add "$tmp" -b sync-dry-run main >/dev/null 2>&1
  (cd "$tmp" && git rebase upstream/master) || true
  git worktree remove "$tmp" --force >/dev/null 2>&1
  git branch -D sync-dry-run >/dev/null 2>&1 || true
  echo
  echo "see docs/upstream-sync.md for how to resolve any conflicts above"
fi
