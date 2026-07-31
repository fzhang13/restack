#!/usr/bin/env bash
#
# Rebuild sandbox-conflict/ from scratch: a three-branch stack whose commits all
# rewrite the same line of shared.txt, so reordering any pair conflicts.
#
# Applying a reorder mutates this repo, so re-run this between manual tests
# rather than trying to unpick the previous one by hand.
#
#   ./test/make-conflict-sandbox.sh
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/sandbox-conflict"

rm -rf "$dir"
mkdir -p "$dir"
cd "$dir"

git init -b main -q
git config user.email "dev@example.com"
git config user.name "Restack Dev"
git config commit.gpgsign false

printf 'counter = 0\n' > shared.txt
printf '# conflict sandbox\n\nEvery branch rewrites the same line of shared.txt.\n' > README.md
git add -A
git commit -qm "chore: init conflict sandbox"

# Each branch touches the shared line (guarantees the conflict) and adds a file
# of its own (so a resolved reorder is still readable as one commit per branch).
n=1
for name in one two three; do
  git checkout -qb "feat/$name"
  printf 'counter = %s\n' "$n" > shared.txt
  printf 'export const %s = %s;\n' "$name" "$n" > "$name.ts"
  git add -A
  git commit -qm "feat: $name bumps the counter"
  n=$((n + 1))
done

gh stack init feat/one feat/two feat/three

echo
gh stack view
