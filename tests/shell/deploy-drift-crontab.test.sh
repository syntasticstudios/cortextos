#!/bin/bash
# Regression test for the CRONTAB path-source classifier (deploy-drift-crontab-lib.sh).
# The cortextos .sh/.mjs crons must route via the stable CLI symlink (-> FF-current worktree),
# never a raw worktree path (teardown-fragile) nor a stale main-checkout scripts|bin path
# (silently runs old code). A missing/dangling symlink is the npm-removal case = LOUD alert.
#
# Criteria:
#   (1) symlink -> real dir            → "ok <dir>"
#   (2) symlink absent                 → "missing"        (npm uninstall)
#   (3) real dir where symlink expected→ "notlink"        (indirection lost)
#   (4) symlink -> nonexistent target  → "dangling"       (npm relink moved it)
#   (5) all crons via symlink          → 0 bypass lines   (correct state)
#   (6) a raw-worktree cron entry      → flagged bypass
#   (7) a main-checkout cron entry     → flagged bypass
#   (8) phytomedic-saas + log-redirect + comment lines → NOT flagged (ignored)
#   (9) mixed (one symlink-ok + one main-checkout) → only the bad one flagged
#
# Usage: bash deploy-drift-crontab.test.sh <deploy-drift-crontab-lib.sh>
set -uo pipefail
LIB="$1"
# shellcheck source=/dev/null
source "$LIB"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1 -- $2"; FAIL=$((FAIL+1)); }

BASE=/Users/arndt/cortextos
SYM=/opt/homebrew/lib/node_modules/cortextos   # the real symlink path (only read via status fn)

# Canonicalize TMP: on macOS /tmp is a symlink to /private/tmp, and crontab_symlink_status
# resolves via `cd -P` (real path), so the expected value must be the resolved path too.
TMP=$(cd -P "$(mktemp -d /tmp/ddc.XXXXXX)" && pwd)
trap 'rm -rf "$TMP"' EXIT

# ---- symlink status ----
mkdir -p "$TMP/realwt"
ln -s "$TMP/realwt" "$TMP/link_ok"
r=$(crontab_symlink_status "$TMP/link_ok")
[ "$r" = "ok $TMP/realwt" ] && ok "(1) resolving symlink -> ok <dir>" || bad "(1) resolving symlink" "got: $r"

r=$(crontab_symlink_status "$TMP/nope")
[ "$r" = "missing" ] && ok "(2) absent -> missing" || bad "(2) absent" "got: $r"

mkdir -p "$TMP/realdir_here"
r=$(crontab_symlink_status "$TMP/realdir_here")
[ "$r" = "notlink" ] && ok "(3) real dir at symlink path -> notlink" || bad "(3) notlink" "got: $r"

ln -s "$TMP/does_not_exist" "$TMP/link_dangling"
r=$(crontab_symlink_status "$TMP/link_dangling")
[ "$r" = "dangling" ] && ok "(4) dangling symlink -> dangling" || bad "(4) dangling" "got: $r"

# ---- crontab bypass detection ----
CT_GOOD="# header comment
0 18 * * * $SYM/scripts/daily-digest.sh >> $BASE/logs/daily-digest.log 2>&1
0 * * * * $SYM/scripts/human-task-pulse.sh
0 8 * * * cd /Users/arndt/phytomedic-saas && /opt/homebrew/bin/node scripts/iteration-tracker/track-ci.mjs >> $BASE/logs/ci-tracker.log 2>&1
0 9 * * * $SYM/bin/feature-overview-push.sh"
n=$(printf '%s\n' "$CT_GOOD" | crontab_bypass_lines "$BASE" | grep -c . || true)
[ "$n" -eq 0 ] && ok "(5)+(8) all-via-symlink + phyto/redirect/comment ignored -> 0 bypass" || bad "(5)/(8) clean crontab" "got $n bypass lines"

CT_RAWWT="0 * * * * $BASE/.claude/worktrees/objective-mclaren/scripts/human-task-pulse.sh"
n=$(printf '%s\n' "$CT_RAWWT" | crontab_bypass_lines "$BASE" | grep -c . || true)
[ "$n" -eq 1 ] && ok "(6) raw-worktree entry -> flagged" || bad "(6) raw-worktree" "got $n"

CT_MAIN="0 * * * * $BASE/scripts/human-task-pulse.sh"
n=$(printf '%s\n' "$CT_MAIN" | crontab_bypass_lines "$BASE" | grep -c . || true)
[ "$n" -eq 1 ] && ok "(7) main-checkout entry -> flagged" || bad "(7) main-checkout" "got $n"

CT_MIX="0 * * * * $SYM/scripts/human-task-pulse.sh
0 18 * * * $BASE/scripts/daily-digest.sh >> $BASE/logs/daily-digest.log 2>&1"
out=$(printf '%s\n' "$CT_MIX" | crontab_bypass_lines "$BASE")
n=$(printf '%s\n' "$out" | grep -c . || true)
if [ "$n" -eq 1 ] && printf '%s' "$out" | grep -q "daily-digest.sh" && ! printf '%s' "$out" | grep -q "$SYM"; then
  ok "(9) mixed -> only the main-checkout line flagged"
else
  bad "(9) mixed" "got: $out"
fi

echo "----"
echo "deploy-drift-crontab: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
