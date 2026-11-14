#!/usr/bin/env bash
# Smoke test for tools/coord. Uses a throwaway local remote, so it needs no network and no gh.
# Checks: init, new-agent, concurrent posts from two worktrees, tail, since, active.
set -euo pipefail

COORD_BIN="$(cd "$(dirname "$0")" && pwd)/coord"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.com
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.com

fail() { echo "FAIL: $*" >&2; exit 1; }

git init -q --bare -b main "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/repo" 2>/dev/null
cd "$TMP/repo"
mkdir tools && cp "$COORD_BIN" tools/coord
echo ".coord/" > .gitignore
git add . && git commit -q -m init && git push -q origin HEAD:main
git switch -q --orphan coord
mkdir events && echo log > README.md && touch events/.gitkeep
git add README.md events && git commit -q -m "coord log" && git push -q origin coord
git switch -q main && git branch -q -D coord

tools/coord init
tools/coord init
[ -d .coord/events ] || fail "init did not create .coord"

tools/coord new-agent a_1 >/dev/null
tools/coord new-agent b_1 >/dev/null

# 10 posts from each of two worktrees at the same time.
for agent in a_1 b_1; do
  (
    cd "$TMP/repo-$agent"
    export AGENT_NAME=$agent
    for i in 1 2 3 4 5 6 7 8 9 10; do tools/coord post NOTE "note $i" >/dev/null; done
  ) &
done
wait

[ ! -e "$TMP/repo-a_1/.coord" ] || fail "agent worktree got its own .coord"
git fetch -q origin coord
count=$(git ls-tree -r --name-only origin/coord events | grep -c '\.md$')
[ "$count" = 20 ] || fail "expected 20 events on the remote, found $count"

if AGENT_NAME='' tools/coord post NOTE "x" 2>/dev/null; then fail "post worked without AGENT_NAME"; fi

export AGENT_NAME=a_1
tools/coord post CLAIM --issue 7 "claiming #7" >/dev/null
tools/coord post START --issue 7 --files api/x.py,web/y.ts "starting" >/dev/null
AGENT_NAME=b_1 tools/coord post CLAIM --issue 8 "claiming #8" >/dev/null
AGENT_NAME=b_1 tools/coord post DONE --issue 8 "finished" >/dev/null

active=$(tools/coord active)
echo "$active" | grep -q '^a_1 #7 \[api/x.py, web/y.ts\] 0m ago$' || fail "active output wrong: $active"
echo "$active" | grep -q '#8' && fail "a DONE issue still shows as active"

[ "$(tools/coord tail 3 | wc -l | tr -d ' ')" = 3 ] || fail "tail 3 did not print 3 lines"
last=$(tools/coord tail 4)
echo "$last" | grep -q 'a_1 START #7 \[api/x.py, web/y.ts\]: starting' || fail "tail format wrong: $last"
[ "$(tools/coord since 2000-01-01T00:00:00Z | grep -vc '^#')" = 24 ] || fail "since <old ts> should list all 24 events"
[ "$(tools/coord since 2999-01-01T00:00:00Z | grep -vc '^#')" = 0 ] || fail "since <future ts> should list nothing"

echo "coord smoke test passed"
