#!/usr/bin/env bash
#
# Rebuild sandbox-multi/ from scratch: one repository holding two independent
# stacks off main, which is what the stack switcher exists for.
#
# gh-stack allows this — `.git/gh-stack` is a `stacks` array and `gh stack
# checkout` takes a stack number — but only one stack is *active* at a time,
# keyed off HEAD. `gh stack view` reports the stack the current branch is in and
# exits 2 for every other, so the thing to confirm here is that switching is a
# checkout, not a view mode.
#
#   ./test/make-multi-stack-sandbox.sh
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/sandbox-multi"

rm -rf "$dir"
mkdir -p "$dir"
cd "$dir"

git init -b main -q
git config user.email "dev@example.com"
git config user.name "Restack Dev"
git config commit.gpgsign false

printf '# multi-stack sandbox\n\nTwo stacks, one repository.\n' > README.md
git add -A
git commit -qm "chore: init multi-stack sandbox"

# Each branch owns a distinct file, so the two stacks can be reordered
# independently without conflicting — the point is the switcher, not conflicts.
stack_one=(feat/auth feat/api)
stack_two=(db/schema db/seed)

git checkout -q main
for name in "${stack_one[@]}"; do
  git checkout -qb "$name"
  printf 'export const %s = true;\n' "${name#*/}" > "${name#*/}.ts"
  git add -A
  git commit -qm "feat: ${name#*/}"
done

git checkout -q main
for name in "${stack_two[@]}"; do
  git checkout -qb "$name"
  printf '%s\n' "-- ${name#*/}" > "${name#*/}.sql"
  git add -A
  git commit -qm "db: ${name#*/}"
done

# A branch in neither stack, to confirm the drag tray offers it while offering
# no branch already claimed by a stack.
git checkout -q main
git checkout -qb chore/lint
printf 'lint\n' > lint.txt
git add -A
git commit -qm "chore: lint config"

# `gh stack init` refuses while HEAD is inside a stack — the same constraint the
# "+ New stack" button parks on trunk for.
git checkout -q main
gh stack init "${stack_one[@]}"
git checkout -q main
gh stack init "${stack_two[@]}"

echo
echo "=== .git/gh-stack"
python3 - <<'PY'
import json

with open(".git/gh-stack") as f:
    data = json.load(f)

for i, stack in enumerate(data["stacks"], start=1):
    chain = " -> ".join([stack["trunk"]["branch"]] + [b["branch"] for b in stack["branches"]])
    print(f"{i}. {chain}")
PY

echo
echo "=== gh stack view, standing on ${stack_two[${#stack_two[@]} - 1]} (reports that stack only)"
git checkout -q "${stack_two[${#stack_two[@]} - 1]}"
gh stack view --short || true
