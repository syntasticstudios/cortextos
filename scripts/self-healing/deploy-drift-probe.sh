#!/usr/bin/env bash
# deploy-drift-probe.sh — DEVOPS detection probe for framework deploy drift.
#
# Independent DETECTION layer (defense-in-depth) for the deploy source-of-truth
# trap (SYS-DEPLOY-SOT): framework merges to main can be INERT to the live fleet
# because the live daemon runs from a specific worktree's dist that must be
# rebuilt AND the daemon process restarted to pick the code up.
#
# This probe does NOT self-heal — that is cortextos-src-watch.sh's job. The probe
# exists so that if the self-healer's cron stalls, rebuilds the wrong worktree, or
# the daemon is never restarted after a rebuild, the drift is still DETECTED and
# escalated to platform-director instead of failing silently.
#
# It resolves the LIVE daemon process from `ps` (NOT a static topology file or
# pgrep, which can miss the node process), derives the dist path it is actually
# executing, and checks four drift dimensions (3 for the daemon dist + 1 for the
# deployed-copy launchd-script class):
#
#   1. SOURCE drift   — origin/main has commits NOT contained in dist/.build-sha
#                       (ancestry-aware: a merge commit that includes origin/main
#                        is up-to-date) AND the gap touches a DIST-AFFECTING input
#                        (src/ + build config). => dist needs rebuild. A gap that
#                        touches NO dist input (scripts/tests/docs/templates/orgs/bin)
#                        rebuilds identically => source_inert (recorded, NOT paged) —
#                        see deploy-drift-source-lib.sh.
#   2. RESTART drift  — the on-disk dist/daemon.js CONTENT differs from what the
#                       running daemon loaded at boot => on-disk build is ahead of
#                       the code actually running in memory. => daemon needs restart.
#                       Keyed off a per-pid content-hash fingerprint, NOT mtime: a
#                       full `tsc` rebuild bumps daemon.js mtime even when its bytes
#                       are unchanged (e.g. the rebuild's only real change was a
#                       non-daemon bin/ script), and an mtime-only check over-pages
#                       PD on those content-identical rebuilds (observed 2026-06-18,
#                       the #52 bin-only rebuild). Falls back to the mtime heuristic
#                       only when no trustworthy fingerprint exists for this pid.
#                       REFINEMENT (restart_hold, dirty-tree class): if the dist was
#                       built while src/daemon/ had UNCOMMITTED changes that trace into
#                       the running daemon.js, the restart is reclassified as a
#                       do-not-restart HOLD (a restart/crash-recovery would load
#                       UNREVIEWED in-progress code; a committed-SHA diff is blind to
#                       dirty-tree builds). See deploy-drift-hold-lib.sh.
#   3. SHA staleness  — dist/daemon.js mtime is NEWER than dist/.build-sha mtime
#                       => dist was rebuilt without postbuild writing the sha, so
#                        .build-sha can no longer be trusted for (1).
#   4. DEPLOYED drift — a launchd job that runs a SELF-CONTAINED copy under
#                       ${CTX_ROOT}/scripts/<name>.sh (quota-watchdog, dispatch-marker,
#                       project-state-writer) has content != origin/main:<sot>. Those
#                       copies have NO auto-sync from the repo, so a merge is inert to
#                       the running job until a manual re-deploy (root-cause class of
#                       the 2026-06-18 fleet false-pause — deployed lagged the repo
#                       guard ~2wks). Map lives in deployed-scripts.registry; remediate
#                       with sync-deployed-scripts.sh apply. Also flags ORPHAN deployed
#                       copies (SoT == NONE) that have no repo source to recover from.
#
# Output: writes a machine-readable <FRAMEWORK_ROOT>/state/deploy-topology.json
# (consumable by cortextos-src-watch / improver tooling per SYS-DEPLOY-SOT improver
# suggestion #2) and, on a NEW drift state, escalates to platform-director.
#
# Driven by the deploy-drift-probe cron. Caller records the fire:
#   cortextos bus update-cron-fire deploy-drift-probe --interval 15
#
# Exit code is always 0 (a probe must never crash its cron); drift is reported via
# the JSON artifact + the PD escalation, not via exit status.

set -uo pipefail

log() { echo "[deploy-drift-probe] $*"; }

# RESTART-HOLD + SOURCE-materiality classifiers (sourced from alongside this script so
# their detection logic is unit-tested independently — deploy-drift-{hold,source}.test.sh).
PROBE_DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=/dev/null
[ -f "$PROBE_DIR/deploy-drift-hold-lib.sh" ]   && source "$PROBE_DIR/deploy-drift-hold-lib.sh"
# shellcheck source=/dev/null
[ -f "$PROBE_DIR/deploy-drift-source-lib.sh" ] && source "$PROBE_DIR/deploy-drift-source-lib.sh"
# shellcheck source=/dev/null
[ -f "$PROBE_DIR/deploy-drift-crontab-lib.sh" ] && source "$PROBE_DIR/deploy-drift-crontab-lib.sh"

# --- 1. Resolve the LIVE daemon process + the dist it executes ----------------
# pgrep -f misses the node daemon on macOS in practice; ps is the reliable path.
DAEMON_LINE=$(ps -axww -o pid=,command= 2>/dev/null \
  | awk '/node .*\/dist\/daemon\.js/ && !/awk/ {print; exit}')

if [ -z "$DAEMON_LINE" ]; then
  log "WARNING: no live daemon process (node .../dist/daemon.js) found — nothing to probe"
  exit 0
fi

DAEMON_PID=$(echo "$DAEMON_LINE" | awk '{print $1}')
DAEMON_JS=$(echo "$DAEMON_LINE" | grep -oE '/[^ ]*/dist/daemon\.js' | head -1)
DIST_DIR=$(dirname "$DAEMON_JS")
FRAMEWORK_ROOT=$(dirname "$DIST_DIR")
BUILD_SHA_FILE="$DIST_DIR/.build-sha"

log "live daemon pid=$DAEMON_PID framework_root=$FRAMEWORK_ROOT"

# --- 2. Gather facts ----------------------------------------------------------
BUILD_SHA=$(tr -d '[:space:]' < "$BUILD_SHA_FILE" 2>/dev/null || echo "")

# origin/main tip (best-effort fetch; tolerate offline).
git -C "$FRAMEWORK_ROOT" fetch origin main --quiet 2>/dev/null || \
  log "WARNING: git fetch failed — comparing against last-known origin/main"
REMOTE_SHA=$(git -C "$FRAMEWORK_ROOT" rev-parse origin/main 2>/dev/null || echo "")

# mtimes (epoch) of the on-disk build artifacts.
DAEMON_MTIME=$(stat -f "%m" "$DAEMON_JS" 2>/dev/null || stat -c "%Y" "$DAEMON_JS" 2>/dev/null || echo "0")
SHA_MTIME=$(stat -f "%m" "$BUILD_SHA_FILE" 2>/dev/null || stat -c "%Y" "$BUILD_SHA_FILE" 2>/dev/null || echo "0")

# Running daemon's process start epoch (LC_ALL=C so weekday/month are English).
LSTART=$(LC_ALL=C ps -o lstart= -p "$DAEMON_PID" 2>/dev/null | sed 's/^ *//;s/ *$//')
PROC_START_EPOCH=$(LC_ALL=C date -j -f "%a %b %e %T %Y" "$LSTART" +%s 2>/dev/null \
  || LC_ALL=C date -d "$LSTART" +%s 2>/dev/null || echo "0")

# Content hash of the on-disk daemon.js (the artifact a restart would load). This is
# what restart_drift compares against the running daemon's boot-time fingerprint, so
# byte-identical rebuilds don't read as "needs restart". shasum on macOS, sha256sum on Linux.
DAEMON_HASH=$(shasum -a 256 "$DAEMON_JS" 2>/dev/null | awk '{print $1}' \
  || sha256sum "$DAEMON_JS" 2>/dev/null | awk '{print $1}' || echo "")

# --- 3. Evaluate the three drift dimensions -----------------------------------
SOURCE_DRIFT="false"; RESTART_DRIFT="false"; SHA_STALE="false"; SOURCE_INERT="false"
REASONS=()

if [ -n "$REMOTE_SHA" ] && [ -n "$BUILD_SHA" ]; then
  if ! git -C "$FRAMEWORK_ROOT" merge-base --is-ancestor "$REMOTE_SHA" "$BUILD_SHA" 2>/dev/null; then
    # origin/main is ahead of the built commit. The daemon dist is compiled (tsup) from
    # src/ + build config ONLY, so page when the gap touches a DIST-AFFECTING input.
    # Two non-dist sub-cases (see deploy-drift-source-lib.sh):
    #   • .github/workflows/** → OPERATIONALLY material: page anyway (CI/deploy surface
    #     advanced), but flag that NO daemon rebuild is required (PD SYS-DEPLOY-SOT spec).
    #   • everything else non-dist (scripts/tests/docs/templates/orgs/bin/...) → rebuilds
    #     to a byte-identical dist = INERT — recorded but NOT paged (the PR #66 scripts-only
    #     false-page class; deploy-drift-nondist-no-restart lane).
    # Each branch's reason carries the matched-path list (fmt_delta_summary) for one-glance triage.
    if declare -f dist_material_delta >/dev/null 2>&1; then
      MAT_DELTA=$(dist_material_delta "$FRAMEWORK_ROOT" "$BUILD_SHA" "$REMOTE_SHA")
      OPS_DELTA=$(ops_material_delta "$FRAMEWORK_ROOT" "$BUILD_SHA" "$REMOTE_SHA")
      # Full gap (all paths) — only for the INERT line's path list; never affects routing.
      FULL_DELTA=$(git -C "$FRAMEWORK_ROOT" diff --name-only "$BUILD_SHA" "$REMOTE_SHA" 2>/dev/null | grep -v '^$' || true)
    else
      MAT_DELTA="?:source-lib-missing"   # no classifier → conservatively treat as material
      OPS_DELTA=""
      FULL_DELTA=""
    fi
    if [ -n "$MAT_DELTA" ]; then
      # Split the dist-affecting delta into daemon-PROCESS src vs out-of-process CLI/tooling
      # src (SYS-DEPLOY-DRIFT-CLISPLIT, task_1782757548171). dist/daemon.js and dist/cli.js
      # are SEPARATE tsup bundles; src/cli/** compiles ONLY into cli.js, which is invoked
      # fresh per CLI call → once dist is rebuilt the CLI change is LIVE with NO daemon
      # restart. So a CLI-only src advance must NOT page "daemon needs restart". Everything
      # else under src/ (src/daemon, src/bus, src/hooks, src/utils, src/types) compiles INTO
      # daemon.js → a running daemon keeps the old code until restarted → page.
      # ASSUMPTION (verified 2026-06-29 w/ devops): src/daemon imports nothing from
      # src/cli/** (only a comment ref), so no daemon.js code lives under src/cli. SAFETY
      # NETS if a future src/daemon→src/cli import ever breaks the path heuristic: (a) the
      # restart-hold mute below keys on the daemon.js CONTENT HASH, so such an import moves
      # the hash and FIRES; (b) the content-based RESTART dimension is an independent
      # backstop. So a mis-classified CLI change can never silently hide a daemon lag.
      DAEMON_MAT=$(printf '%s\n' "$MAT_DELTA" | grep -v '^src/cli/' || true)
      CLI_MAT=$(printf '%s\n' "$MAT_DELTA" | grep '^src/cli/' || true)
      if [ -n "$DAEMON_MAT" ]; then
        # Daemon-process src in the delta → daemon rebuild + restart needed → page.
        SOURCE_DRIFT="true"
        REASONS+=("SOURCE: origin/main ${REMOTE_SHA:0:8} not contained in build ${BUILD_SHA:0:8} — $(fmt_delta_summary "$DAEMON_MAT") daemon-process src (compiled into daemon.js) — dist needs rebuild + daemon restart")
        [ -n "$CLI_MAT" ] && REASONS+=("SOURCE-CLI (info): delta also includes $(fmt_delta_summary "$CLI_MAT") CLI/tooling src — served per-invoke by the rebuilt binary, no daemon restart needed")
      else
        # CLI/tooling src ONLY (no daemon-process delta) → the rebuilt binary serves it →
        # record-not-page (no daemon restart). Routed through SOURCE_INERT so DRIFT stays
        # false on a cli-only advance (the #100-class "page on every CLI PR" false-page).
        SOURCE_INERT="true"
        REASONS+=("SOURCE-CLI: origin/main ${REMOTE_SHA:0:8} ahead of build ${BUILD_SHA:0:8} by $(fmt_delta_summary "$CLI_MAT") CLI/tooling src ONLY (src/cli/**) — served per-invoke by the rebuilt binary; dist rebuild updates the CLI, NO daemon restart needed; recorded, not paged")
      fi
    elif [ -n "$OPS_DELTA" ]; then
      # No dist delta, but .github/workflows/** advanced — operationally material. Page
      # (NOT silenced) per PD SYS-DEPLOY-SOT spec; daemon rebuild is NOT required.
      SOURCE_DRIFT="true"
      REASONS+=("SOURCE-OPS: origin/main ${REMOTE_SHA:0:8} ahead of build ${BUILD_SHA:0:8} — no dist delta but $(fmt_delta_summary "$OPS_DELTA") operationally-material (CI workflow); daemon rebuild NOT required, but the deploy/CI surface advanced — paged, not silenced")
    else
      # Non-dist, non-ops gap → rebuilds identically → INFO downgrade, recorded not paged.
      SOURCE_INERT="true"
      REASONS+=("SOURCE-INERT: origin/main ${REMOTE_SHA:0:8} ahead of build ${BUILD_SHA:0:8} but NO dist/ops-material delta — non-dist only: $(fmt_delta_summary "$FULL_DELTA") (scripts/tests/docs/templates/orgs/bin) — dist would rebuild identically; recorded, not paged")
    fi
  fi
elif [ -z "$BUILD_SHA" ]; then
  SHA_STALE="true"
  REASONS+=("SHA: $BUILD_SHA_FILE missing/empty — cannot verify source freshness")
fi

# RESTART drift via per-pid content fingerprint (see header note). The fingerprint
# file stores "<pid>:<daemon.js hash>" = the content this running daemon loaded at
# boot. When on-disk daemon.js is newer than proc start we decide by CONTENT, not
# mtime; we (re)baseline whenever on-disk == loaded so byte-identical rebuilds are
# silent. NEW_FP, if set, is persisted after the state dir is ensured (section 4).
FINGERPRINT_FILE="$FRAMEWORK_ROOT/state/.deploy-daemon-fingerprint"
FP_PID=""; FP_HASH=""
if [ -f "$FINGERPRINT_FILE" ]; then
  FP_PID=$(awk -F: 'NR==1{print $1}' "$FINGERPRINT_FILE" 2>/dev/null)
  FP_HASH=$(awk -F: 'NR==1{print $2}' "$FINGERPRINT_FILE" 2>/dev/null)
fi
NEW_FP=""

# The RESTART reason is DEFERRED (captured in RESTART_REASON, appended later) so the
# dirty-tree HOLD refinement below can REPLACE the plain "needs restart" wording with
# a do-not-restart HOLD when the dist was built from uncommitted daemon src.
RESTART_REASON=""
if [ "$PROC_START_EPOCH" -gt 0 ] && [ "$DAEMON_MTIME" -gt "$PROC_START_EPOCH" ]; then
  # On-disk daemon.js was written after this pid booted. Decide by content.
  if [ "$FP_PID" = "$DAEMON_PID" ] && [ -n "$FP_HASH" ] && [ -n "$DAEMON_HASH" ]; then
    if [ "$DAEMON_HASH" != "$FP_HASH" ]; then
      RESTART_DRIFT="true"
      RESTART_REASON="RESTART: dist/daemon.js content changed since the running daemon (pid $DAEMON_PID) loaded it — daemon needs restart"
    fi
    # else: byte-identical rebuild — NOT a restart condition (mtime-only false-positive suppressed).
  else
    # No trustworthy content baseline for this pid (first sighting already post-rebuild).
    # Conservative: fall back to the mtime heuristic so a genuine drift is never MISSED.
    RESTART_DRIFT="true"
    RESTART_REASON="RESTART: dist/daemon.js rebuilt after the daemon started (no content baseline for pid $DAEMON_PID; mtime-based) — daemon may need restart"
  fi
elif [ "$PROC_START_EPOCH" -gt 0 ] && [ -n "$DAEMON_HASH" ]; then
  # On-disk daemon.js is NOT newer than proc start => it IS what the daemon loaded.
  # (Re)baseline this pid's fingerprint to the current content hash.
  NEW_FP="${DAEMON_PID}:${DAEMON_HASH}"
fi

# RESTART-HOLD refinement (SYS-DEPLOY-SOT, dirty-tree class). A committed-SHA diff is
# BLIND to a dist rebuilt from a DIRTY working tree. When RESTART drift fired, the dist
# is ahead of the running daemon — but if it was built while src/daemon/ had UNCOMMITTED
# changes, a restart (deliberate OR crash-recovery) would load UNREVIEWED in-progress
# code while the committed-SHA range shows EMPTY (the 2026-06-19 mis-triage). We trace
# net-new uncommitted daemon symbols INTO the running dist (running-code == armed-code);
# if found, EMIT A HOLD instead of the plain actionable "needs restart".
RESTART_HOLD="false"; HOLD_TOKENS=""
if [ "$RESTART_DRIFT" = "true" ]; then
  if declare -f trace_uncommitted_daemon_symbols >/dev/null 2>&1; then
    HOLD_TOKENS=$(trace_uncommitted_daemon_symbols "$FRAMEWORK_ROOT" "$DAEMON_JS" 2>/dev/null | paste -sd, -)
    DIRTY_LIST=$(list_dirty_daemon_files "$FRAMEWORK_ROOT" 2>/dev/null | paste -sd' ' -)
  fi
  if [ -n "$HOLD_TOKENS" ]; then
    RESTART_HOLD="true"
    REASONS+=("HOLD: dist/daemon.js carries UNCOMMITTED daemon src — uncommitted symbol(s) [$HOLD_TOKENS] are present in the RUNNING-disk build (dirty: ${DIRTY_LIST:-?}). DO NOT restart: a deliberate restart OR crash-recovery would load UNREVIEWED in-progress code. Commit/review-gate the dist before any restart. (committed-SHA diff is blind to dirty-tree builds.)")
  else
    # Either daemon src is clean (normal post-merge rebuild) or no new symbol traced —
    # emit the plain RESTART reason, plus a caveat when src/daemon/ is nonetheless dirty.
    [ -n "$RESTART_REASON" ] && REASONS+=("$RESTART_REASON")
    if [ -n "${DIRTY_LIST:-}" ]; then
      REASONS+=("RESTART-CAVEAT: src/daemon/ is dirty ($DIRTY_LIST) while RESTART drift is set, but no net-new uncommitted symbol traced into the dist — verify the build did not capture uncommitted code before restarting.")
    fi
  fi
fi

if [ "$SHA_MTIME" -gt 0 ] && [ "$DAEMON_MTIME" -gt "$SHA_MTIME" ]; then
  SHA_STALE="true"
  REASONS+=("SHA: daemon.js newer than .build-sha — sha not rewritten by postbuild, source check unreliable")
fi

# --- 3b. DEPLOYED-COPY drift (SYS-DEPLOY-SOT, deployed-copy class) -------------
# Several launchd jobs run a SELF-CONTAINED copy under ${CTX_ROOT}/scripts/<name>.sh
# rather than executing from a worktree. Those copies have NO auto-sync from the
# repo, so a merge to origin/main is INERT to the running job until a manual
# re-deploy. quota-watchdog silently ran ~2wks stale this way (deployed copy lagged
# the repo false-pause guard) = the running-code != tested-code class behind the
# 2026-06-18 fleet false-pause. We compare each deployed copy's content hash to
# origin/main:<sot> (the MERGED truth — independent of any dirty worktree). The
# (deployed-path -> repo-SoT) map is the shared registry that sync-deployed-scripts.sh
# also consumes; remediation is `sync-deployed-scripts.sh apply`.
DEPLOYED_DRIFT="false"
DEPLOYED_ORPHAN="false"
DEPLOYED_DRIFT_FILES=()   # feeds the dedup key + topology artifact
REGISTRY="$(dirname "${BASH_SOURCE[0]}")/deployed-scripts.registry"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"

if [ -f "$REGISTRY" ]; then
  while IFS='|' read -r dep sot; do
    dep="$(echo "$dep" | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
    sot="$(echo "${sot:-}" | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$dep" ] && continue
    dep_path="$CTX_ROOT/$dep"

    if [ "$sot" = "NONE" ] || [ -z "$sot" ]; then
      DEPLOYED_ORPHAN="true"
      DEPLOYED_DRIFT_FILES+=("orphan:$dep")
      REASONS+=("DEPLOYED-ORPHAN: $dep runs from a deployed copy with NO repo source — un-recoverable if lost; adopt it into the repo")
      continue
    fi

    git -C "$FRAMEWORK_ROOT" cat-file -e "origin/main:$sot" 2>/dev/null || {
      REASONS+=("DEPLOYED: registry SoT origin/main:$sot does not exist — registry stale?")
      continue
    }
    src_hash="$(git -C "$FRAMEWORK_ROOT" show "origin/main:$sot" 2>/dev/null | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | awk '{print $1}')"
    dep_hash="$( { shasum -a 256 "$dep_path" 2>/dev/null || sha256sum "$dep_path" 2>/dev/null; } | awk '{print $1}')"

    if [ -z "$dep_hash" ]; then
      DEPLOYED_DRIFT="true"; DEPLOYED_DRIFT_FILES+=("$dep")
      REASONS+=("DEPLOYED: $dep MISSING at $dep_path but registered (SoT $sot) — run sync-deployed-scripts.sh apply")
    elif [ -n "$src_hash" ] && [ "$dep_hash" != "$src_hash" ]; then
      DEPLOYED_DRIFT="true"; DEPLOYED_DRIFT_FILES+=("$dep")
      # Determine deploy DIRECTION before recommending a fix. The canned "run
      # sync-apply" remediation assumes the deployed copy is BEHIND main; if it is
      # actually AHEAD (carrying a fix not yet merged), sync-apply would REVERT it —
      # the 2026-06-29 SYS-AUTH-APIKEY-01 footgun. Resolve direction by matching the
      # deployed content's git blob against <sot> across history: a match on a commit
      # NOT contained in origin/main ⇒ deployed is AHEAD; a match on an ancestor of
      # origin/main ⇒ genuinely BEHIND; no match ⇒ a manual/diverged edit. Bounded
      # cost: <sot> are small registry scripts with modest history. (task_1782743371901)
      dep_blob="$(git -C "$FRAMEWORK_ROOT" hash-object "$dep_path" 2>/dev/null || echo "")"
      dep_dir="unknown"
      if [ -n "$dep_blob" ] && [ -n "$REMOTE_SHA" ]; then
        match_commit="$(git -C "$FRAMEWORK_ROOT" rev-list --all -- "$sot" 2>/dev/null | while read -r _c; do
          _cb="$(git -C "$FRAMEWORK_ROOT" rev-parse --quiet --verify "$_c:$sot" 2>/dev/null)" || continue
          if [ "$_cb" = "$dep_blob" ]; then echo "$_c"; break; fi
        done)"
        if [ -n "$match_commit" ]; then
          if git -C "$FRAMEWORK_ROOT" merge-base --is-ancestor "$match_commit" "$REMOTE_SHA" 2>/dev/null; then
            dep_dir="behind"
          else
            dep_dir="ahead"
          fi
        fi
      fi
      if [ "$dep_dir" = "ahead" ]; then
        REASONS+=("DEPLOYED-AHEAD: $dep (${dep_hash:0:8}) is AHEAD of origin/main:$sot (${src_hash:0:8}) — deployed carries content not yet on main; MERGE it to main, do NOT run sync-apply (it would REVERT the deployed copy)")
      elif [ "$dep_dir" = "behind" ]; then
        REASONS+=("DEPLOYED: $dep (${dep_hash:0:8}) != origin/main:$sot (${src_hash:0:8}) — deployed copy lags repo; run sync-deployed-scripts.sh apply")
      else
        REASONS+=("DEPLOYED-DIVERGED: $dep (${dep_hash:0:8}) != origin/main:$sot (${src_hash:0:8}) — content matches no known commit for this path (manual edit?); reconcile by hand, do NOT blindly sync-apply")
      fi
    fi
  done < "$REGISTRY"
else
  log "WARNING: deployed-scripts registry not found at $REGISTRY — skipping deployed-copy dimension"
fi

# --- 3c. CRONTAB path-source dimension (SYS-DEPLOY, PD 2026-07-10) -------------
# The cortextos .sh crons (human-task-pulse hourly, daily-digest, feature-overview) MUST route
# via the stable CLI symlink so they always execute FF-current worktree code. A missing/dangling
# symlink (npm uninstall/relink) OR a raw-worktree / stale main-checkout bypass = SILENT
# cron-staleness (this class shipped a not-actually-live #120). Paged LOUD — never fail silent.
# (reference_crontab_runs_main_checkout_not_worktree.) Orthogonal to the daemon dims, so it also
# pages through the Founder-gated restart-hold mute (§4b) below.
CRONTAB_DRIFT="false"; CRONTAB_SIG=""
CLI_SYMLINK="/opt/homebrew/lib/node_modules/cortextos"        # canonical CLI symlink -> worktree root
MAIN_CHECKOUT_BASE="${FRAMEWORK_ROOT%%/.claude/worktrees/*}"  # checkout root, e.g. /Users/arndt/cortextos
if declare -f crontab_symlink_status >/dev/null 2>&1; then
  CT_TEXT=$(crontab -l 2>/dev/null || true)
  SYM_STATUS=$(crontab_symlink_status "$CLI_SYMLINK")
  if [ "${SYM_STATUS%% *}" != "ok" ]; then
    CRONTAB_DRIFT="true"
    REASONS+=("CRONTAB-SYMLINK: stable CLI symlink $CLI_SYMLINK is '${SYM_STATUS}' — cortextos crons cannot resolve to the live worktree (npm uninstall/relink?); they run stale or fail")
  fi
  CT_BYPASS_PATHS=""
  CT_BYPASS=$(printf '%s\n' "$CT_TEXT" | crontab_bypass_lines "$MAIN_CHECKOUT_BASE")
  if [ -n "$CT_BYPASS" ]; then
    CRONTAB_DRIFT="true"
    CT_BYPASS_PATHS=$(printf '%s' "$CT_BYPASS" | grep -oE '/[^[:space:]]+\.(sh|mjs)' | sort -u | tr '\n' ',')
    REASONS+=("CRONTAB-PATH: cron entry/entries bypass the CLI symlink via a raw-worktree or stale main-checkout path: ${CT_BYPASS_PATHS} — a merged script change is NOT live there")
  fi
  # Page-once signature: symlink status + the sorted bypass-path set, so a CHANGED drift set re-pages
  # (and a recovery clears it) — same set-based page-once semantics as source_drift/deployed_drift.
  CRONTAB_SIG="${SYM_STATUS%% *}:${CT_BYPASS_PATHS}"
fi

DRIFT="false"
if [ "$SOURCE_DRIFT" = "true" ] || [ "$RESTART_DRIFT" = "true" ] || [ "$SHA_STALE" = "true" ] \
   || [ "$DEPLOYED_DRIFT" = "true" ] || [ "$DEPLOYED_ORPHAN" = "true" ] \
   || [ "$CRONTAB_DRIFT" = "true" ]; then
  DRIFT="true"
fi

# --- 4. Write the machine-readable topology/status artifact -------------------
STATE_DIR="$FRAMEWORK_ROOT/state"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Persist the running daemon's content fingerprint (baselined above when on-disk
# daemon.js == what this pid loaded). Lets the next run decide restart_drift by
# content rather than mtime. Best-effort — never block the probe.
if [ -n "$NEW_FP" ]; then echo "$NEW_FP" > "$FINGERPRINT_FILE" 2>/dev/null || true; fi

# --- 4b. Founder-gate restart-hold mute (SYS-DEPLOY-DRIFT-HOLDMUTE, task_1782757548171) ---
# When the daemon-PROCESS restart is deliberately HELD (Founder-gated, ticketed — e.g. the
# #95 housekeeping restart awaiting Founder OK), the daemon-process SOURCE + RESTART drift
# is KNOWN/expected and must RECORD-not-page so it stops nagging PD on every material main
# advance. The mute marker keys on (held_pid + the daemon.js CONTENT HASH at hold time):
#   • running pid == held pid AND on-disk daemon.js hash == held hash → the SAME known held
#     drift → mute active (record-not-page the daemon SOURCE/RESTART).
#   • daemon.js hash MOVES (a new src/daemon|src/bus PR rebuilt into daemon.js, OR a future
#     src/cli→daemon import) → hash mismatch → mute INACTIVE → the new daemon lag PAGES.
#   • pid CHANGES (the held restart landed, or a crash-respawn) → marker stale → auto-clear
#     + resume paging (the drift itself also resolves once the new pid loads current dist).
# Non-daemon dimensions (deployed-drift, sha-stale, orphan) are NEVER muted. The content-
# based RESTART dimension remains an independent backstop. Marker format (line 1):
#   <held_pid>:<held_daemon_js_sha256>[:<ticket-or-note>]
RESTART_HOLD_MUTE="false"
HOLD_MUTE_FILE="$STATE_DIR/.deploy-drift-restart-hold"
if [ -f "$HOLD_MUTE_FILE" ]; then
  HM_PID=$(awk -F: 'NR==1{print $1}' "$HOLD_MUTE_FILE" 2>/dev/null)
  HM_HASH=$(awk -F: 'NR==1{print $2}' "$HOLD_MUTE_FILE" 2>/dev/null)
  if [ -n "$HM_PID" ] && [ "$HM_PID" != "$DAEMON_PID" ]; then
    rm -f "$HOLD_MUTE_FILE" 2>/dev/null || true
    log "restart-hold mute cleared: daemon pid changed ($HM_PID → $DAEMON_PID) — held restart resolved"
  elif [ "$HM_PID" = "$DAEMON_PID" ] && [ -n "$HM_HASH" ] && [ "$HM_HASH" = "$DAEMON_HASH" ]; then
    RESTART_HOLD_MUTE="true"
  fi
  # Same pid but daemon.js hash moved: leave the marker for the owner to refresh; mute stays
  # FALSE so the new daemon-affecting drift pages (never silently hide a real daemon lag).
fi

TOPOLOGY_FILE="$STATE_DIR/deploy-topology.json"
REASONS_JSON=$(printf '%s\n' "${REASONS[@]:-}" | python3 -c "import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))" 2>/dev/null || echo "[]")
DEPLOYED_DRIFT_JSON=$(printf '%s\n' "${DEPLOYED_DRIFT_FILES[@]:-}" | python3 -c "import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))" 2>/dev/null || echo "[]")
HOLD_TOKENS_JSON=$(printf '%s' "${HOLD_TOKENS:-}" | python3 -c "import json,sys; s=sys.stdin.read().strip(); print(json.dumps([t for t in s.split(',') if t]))" 2>/dev/null || echo "[]")

cat > "$TOPOLOGY_FILE" <<EOF
{
  "framework_root": "$FRAMEWORK_ROOT",
  "daemon_pid": $DAEMON_PID,
  "daemon_js": "$DAEMON_JS",
  "build_sha": "$BUILD_SHA",
  "origin_main_sha": "$REMOTE_SHA",
  "daemon_js_hash": "$DAEMON_HASH",
  "daemon_loaded_hash": "${FP_HASH:-}",
  "daemon_js_mtime": $DAEMON_MTIME,
  "build_sha_mtime": $SHA_MTIME,
  "proc_start_epoch": $PROC_START_EPOCH,
  "drift": $DRIFT,
  "source_drift": $SOURCE_DRIFT,
  "source_inert": $SOURCE_INERT,
  "restart_drift": $RESTART_DRIFT,
  "restart_hold": $RESTART_HOLD,
  "restart_hold_mute": $RESTART_HOLD_MUTE,
  "hold_tokens": $HOLD_TOKENS_JSON,
  "sha_stale": $SHA_STALE,
  "crontab_drift": $CRONTAB_DRIFT,
  "crontab_sig": "$CRONTAB_SIG",
  "deployed_drift": $DEPLOYED_DRIFT,
  "deployed_orphan": $DEPLOYED_ORPHAN,
  "deployed_drift_files": $DEPLOYED_DRIFT_JSON,
  "reasons": $REASONS_JSON
}
EOF
log "wrote $TOPOLOGY_FILE (drift=$DRIFT)"

# --- 5. Escalate on MATERIAL drift change (dedup — no spam) -------------------
# Per platform-director directive (OPS-DAEMON-RESTART, 2026-06-18): a restart_drift
# that PD has already acknowledged + ticketed must NOT re-page every 15 min. Re-page
# ONLY when the situation MATERIALLY changes — the source dist-affecting file SET
# changes (see SOURCE_SIG below; flipping true is one such change), sha_stale flips
# true, the deployed-drift file set changes, or a NEW daemon pid appears. The dedup
# key therefore deliberately EXCLUDES restart_drift, build_sha and mtime: a same-pid restart_drift (incl. repeated
# improver rebuilds of the daemon while it awaits its planned restart) keeps the same
# key and is suppressed after the first page. A fresh pid (the restart landed, or a
# crash-respawn) changes the key, which both clears the old condition and surfaces any
# new one. The topology artifact is still rewritten every run regardless of paging.
#
# The deployed-copy dimension joins the key by its SORTED drifted-file SET (not just a
# bool): a new file drifting changes the key (re-page), and a sync that clears it flips
# the key back (recovered) — same page-once-per-distinct-state semantics as source_drift.
#
# restart_HOLD joins the key too: unlike a routine restart_drift (deliberately excluded
# to avoid re-paging while a planned restart is pending), a HOLD is a do-not-restart
# WARNING (the dist carries uncommitted daemon src) that PD must see when it appears and
# when it clears — so hold-state transitions re-page.
MARKER="$STATE_DIR/.deploy-drift-last"
DEPLOYED_SIG=$(printf '%s\n' "${DEPLOYED_DRIFT_FILES[@]:-}" | sort | tr '\n' ',' )

# SOURCE signature — key on the dist-affecting changed-file SET, not the src= bool.
# A bare src=${SOURCE_DRIFT} bool suppresses re-escalation when origin/main advances
# with a NEW dist-affecting file while SOURCE_DRIFT is ALREADY true: the key is
# unchanged so PD never sees the new file (2026-06-26 miss — the #84 stale-watchdog.ts
# source file did not auto-surface; caught only by a manual probe-output read).
# Mirror DEPLOYED_SIG (set-based): the SORTED union of the dist-material (MAT_DELTA) and
# ops-material (OPS_DELTA) paths, each paired with its origin/main BLOB hash. That blob
# hash is a sharper "+ origin/main SHA" — content-precise rather than commit-wide:
#   • a NEW or REMOVED dist file, OR a re-edit of an already-drifting file (its blob
#     hash moves) → sig changes → re-page ONCE;
#   • an INERT origin/main advance (docs/tests/scripts) leaves every dist blob untouched
#     → identical sig → suppressed — so we do NOT regress to per-commit/per-cycle spam
#     (the #66/#51 material-change discipline). The raw commit SHA would churn the key on
#     every unrelated commit in the range; the per-file blob set does not.
SOURCE_SIG=""
if [ "$SOURCE_DRIFT" = "true" ] && declare -f source_drift_sig >/dev/null 2>&1; then
  SOURCE_SIG=$(source_drift_sig "$FRAMEWORK_ROOT" "$BUILD_SHA" "$REMOTE_SHA")
fi

DRIFT_KEY="src=${SOURCE_DRIFT};srcsig=${SOURCE_SIG};sha=${SHA_STALE};pid=${DAEMON_PID};dep=${DEPLOYED_SIG};hold=${RESTART_HOLD};holdmute=${RESTART_HOLD_MUTE};crontab=${CRONTAB_SIG}"
LAST_KEY=$(cat "$MARKER" 2>/dev/null || echo "")

# Restart-hold mute (section 4b): while the held daemon-process restart is Founder-gated
# (pid + daemon.js hash matched), the daemon SOURCE/RESTART drift is expected → page ONLY
# if a NON-held dimension (deployed-drift / sha-stale / orphan) also drifted. A daemon.js
# hash move or pid change already flips RESTART_HOLD_MUTE=false (4b) so a genuinely-new
# daemon lag or a real restart always pages. Topology artifact records everything regardless.
PAGE_DRIFT="$DRIFT"
if [ "$RESTART_HOLD_MUTE" = "true" ]; then
  if [ "$DEPLOYED_DRIFT" = "true" ] || [ "$DEPLOYED_ORPHAN" = "true" ] || [ "$SHA_STALE" = "true" ] || [ "$CRONTAB_DRIFT" = "true" ]; then
    PAGE_DRIFT="true"
  else
    PAGE_DRIFT="false"
  fi
fi

if [ "$PAGE_DRIFT" = "true" ]; then
  for r in "${REASONS[@]}"; do log "DRIFT: $r"; done
  if [ "$DRIFT_KEY" != "$LAST_KEY" ]; then
    SUMMARY=$(printf '%s; ' "${REASONS[@]}")
    # A HOLD leads the message unmistakably so neither a human nor an automated restart
    # lane treats it as a routine "needs restart".
    PREFIX="Live daemon (pid $DAEMON_PID) deploy drift in $FRAMEWORK_ROOT."
    [ "$RESTART_HOLD" = "true" ] && PREFIX="⚠ HOLD — DO NOT RESTART daemon (pid $DAEMON_PID) in $FRAMEWORK_ROOT: dist carries UNCOMMITTED daemon src."
    cortextos bus send-message platform-director high \
      "[deploy-drift-probe] ${PREFIX} ${SUMMARY}Detail: $TOPOLOGY_FILE" \
      2>/dev/null && log "escalated to platform-director" || log "WARNING: PD escalation failed"
    cortextos bus log-event action deploy_drift_detected warn \
      --meta "{\"pid\":$DAEMON_PID,\"source_drift\":$SOURCE_DRIFT,\"restart_drift\":$RESTART_DRIFT,\"restart_hold\":$RESTART_HOLD,\"sha_stale\":$SHA_STALE,\"deployed_drift\":$DEPLOYED_DRIFT,\"deployed_orphan\":$DEPLOYED_ORPHAN}" 2>/dev/null || true
    echo "$DRIFT_KEY" > "$MARKER"
  else
    log "drift unchanged since last fire — escalation suppressed (idempotent)"
  fi
elif [ "$DRIFT" = "true" ]; then
  # Drift present but page-suppressed by the Founder-gate restart-hold mute (only the known
  # held daemon-process SOURCE/RESTART, pid+daemon.js-hash matched). Record, do NOT page,
  # and do NOT touch the marker — so when the mute clears (pid or daemon.js hash changes) the
  # then-current key differs from $LAST_KEY and the next material change re-pages cleanly.
  for r in "${REASONS[@]}"; do log "DRIFT(hold-muted): $r"; done
  log "restart-hold mute ACTIVE (pid $DAEMON_PID + daemon.js hash matched) — daemon SOURCE/RESTART recorded, not paged"
else
  log "no drift: origin/main ⊆ build, daemon running current on-disk build"
  [ -f "$MARKER" ] && rm -f "$MARKER" && log "cleared prior drift marker (recovered)"
fi

exit 0
