#!/usr/bin/env bash
# deploy-drift-crontab-lib.sh — CRONTAB path-source drift classifier for deploy-drift-probe.sh.
#
# WHY: the system crontab runs several cortextos .sh crons (human-task-pulse hourly,
# daily-digest, feature-overview-push x2). Per PD ruling SYS-DEPLOY (2026-07-10) these MUST
# route via the stable CLI symlink /opt/homebrew/lib/node_modules/cortextos -> the FF-current
# objective-mclaren worktree, and NEVER via:
#   - a RAW worktree path (breaks silently if the worktree is renamed / torn down), nor
#   - a stale MAIN-CHECKOUT scripts|bin path (the main checkout parks on stale PR-build
#     branches, so the cron silently runs OLD code — this shipped a not-actually-live #120).
# Both are the silent-cron-staleness class documented in
# reference_crontab_runs_main_checkout_not_worktree. This classifier lets the probe PAGE LOUD
# when (a) the symlink is missing/dangling (an npm uninstall/relink dropped it) or (b) any
# cortextos cron bypasses the symlink — so the exec-path can never silently regress.
#
# Unit-tested directly (tests/shell/deploy-drift-crontab.test.sh).

# crontab_symlink_status <symlink_path>
#   echoes exactly one of: "ok <resolved-dir>" | "missing" | "notlink" | "dangling". rc 0 always.
#   - missing : nothing at the path (npm uninstall)
#   - notlink : a real file/dir sits where the stable SYMLINK should be (indirection lost)
#   - dangling: a symlink that does not resolve to a directory (target moved/removed)
crontab_symlink_status() {
  local link="$1" real
  if [ ! -L "$link" ]; then
    [ -e "$link" ] && { echo "notlink"; return 0; }
    echo "missing"; return 0
  fi
  real=$(cd -P "$link" 2>/dev/null && pwd)   # resolves the link IFF it points at a real directory
  if [ -z "$real" ] || [ ! -d "$real" ]; then echo "dangling"; return 0; fi
  echo "ok $real"
}

# crontab_bypass_lines <cortextos_base>    (crontab text on stdin)
#   Echoes each ACTIVE crontab line that runs a cortextos-owned .sh/.mjs via a RAW path —
#   the main-checkout <base>/scripts|bin OR a raw <base>/.claude/worktrees path — i.e.
#   BYPASSING the stable CLI symlink. Empty output => every cortextos cron routes via the
#   symlink (the correct state). Ignores comment/blank lines, log-redirect targets (they are
#   not .sh/.mjs), and non-cortextos entries (e.g. a phytomedic-saas node invocation). The
#   symlink path (/opt/homebrew/...) is deliberately NOT under <base>, so a symlink-routed
#   entry never matches.
crontab_bypass_lines() {
  local base="${1:-/Users/arndt/cortextos}"
  grep -vE '^[[:space:]]*(#|$)' \
    | grep -E "${base}/(scripts|bin|\.claude/worktrees)/[^[:space:]]*\.(sh|mjs)" || true
}
