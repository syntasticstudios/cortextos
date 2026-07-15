#!/usr/bin/env bash
# apply-tool-trace-hook.sh — OBSERV-01 activation applier.
#
# WHY A SCRIPT (not a PR): the 10 live per-agent settings.json under
# orgs/<org>/agents/<agent>/.claude/settings.json are GITIGNORED
# (.gitignore: orgs/phytomedic/agents/*/*) — per-agent runtime-local config, NOT
# tracked. So the tracked-PR path can only carry the TEMPLATES (future agents);
# the existing 10 must be edited in place. This reviewed, idempotent applier IS
# the audit trail for that in-place edit (append-not-clobber, skip-if-present,
# per-file backup, before/after hook-count report). Run once by platform-director
# per the settings-drift doctrine, AFTER PR #124 lands (script path must exist).
#
# APPENDS one PostToolUse entry invoking tool-trace-hook.sh to each agent's
# existing hooks — it never clobbers or reorders existing hooks, and re-running
# is a no-op (skip-if-present). Activation is next-natural-session-boundary
# (hooks are read at session start) — no forced restart.
#
# Usage:  apply-tool-trace-hook.sh [--dry-run] [--org <org>]
set -uo pipefail

DRY=0; ORG="${CTX_ORG:-phytomedic}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --org) shift; ORG="$1" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
AGENTS_DIR="$ROOT/orgs/$ORG/agents"
[ -d "$AGENTS_DIR" ] || { echo "no agents dir: $AGENTS_DIR" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 required" >&2; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
total=0; changed=0; skipped=0

for adir in "$AGENTS_DIR"/*/; do
  agent=$(basename "$adir")
  cfg="$adir/.claude/settings.json"
  [ -f "$cfg" ] || { echo "  $agent: no settings.json — SKIP"; continue; }
  total=$((total+1))
  result=$(DRY="$DRY" STAMP="$STAMP" CFG="$cfg" python3 - "$agent" <<'PY'
import json, os, sys, collections
agent = sys.argv[1]
cfg = os.environ['CFG']; dry = os.environ['DRY'] == '1'; stamp = os.environ['STAMP']
ENTRY = {"hooks":[{"type":"command","command":"bash \"$CTX_FRAMEWORK_ROOT/scripts/self-healing/tool-trace-hook.sh\"","timeout":5}]}
MARK = 'tool-trace-hook.sh'
try:
    with open(cfg) as f:
        d = json.load(f, object_pairs_hook=collections.OrderedDict)
except Exception as e:
    print(f"ERROR parse: {e}"); sys.exit(0)
hooks = d.setdefault('hooks', collections.OrderedDict())
def total_hooks(h):
    return sum(len(b.get('hooks', [])) for arr in h.values() if isinstance(arr, list) for b in arr if isinstance(b, dict))
before_events = {k: len(v) for k, v in hooks.items() if isinstance(v, list)}
before_total = total_hooks(hooks)
arr = hooks.setdefault('PostToolUse', [])
if any(MARK in json.dumps(e) for e in arr):
    print(f"SKIP already-present | PostToolUse={len(arr)} total_hooks={before_total}"); sys.exit(0)
arr.append(ENTRY)
after_total = total_hooks(hooks)
# invariant: we added EXACTLY one hook, dropped none
if after_total != before_total + 1:
    print(f"ABORT invariant: total_hooks {before_total}->{after_total} (expected +1)"); sys.exit(0)
if dry:
    print(f"WOULD-ADD | PostToolUse {len(arr)-1}->{len(arr)} total_hooks {before_total}->{after_total}"); sys.exit(0)
import shutil
shutil.copy2(cfg, f"{cfg}.bak.{stamp}")
with open(cfg, 'w') as f:
    json.dump(d, f, indent=2); f.write('\n')
print(f"ADDED | PostToolUse {len(arr)-1}->{len(arr)} total_hooks {before_total}->{after_total} | backup .bak.{stamp}")
PY
)
  echo "  $agent: $result"
  case "$result" in
    ADDED*|WOULD-ADD*) changed=$((changed+1)) ;;
    SKIP*) skipped=$((skipped+1)) ;;
  esac
done

echo "---"
echo "agents=$total changed=$changed skipped=$skipped dry_run=$DRY"
[ "$DRY" = "1" ] && echo "(dry-run — no files written)"
exit 0
