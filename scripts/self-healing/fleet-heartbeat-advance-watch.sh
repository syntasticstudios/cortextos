#!/usr/bin/env bash
# fleet-heartbeat-advance-watch.sh — SYS-MASK-01 (a) cron-tick-freshness backstop
#
# WHY: today's incident (2026-06-17, 2nd in ~8 days) — a daemon restart (↺~every
# 10h) stopped agents' heartbeat-crons while sessions stayed alive; 3 agents sat
# non-ticking 4-6h and were found MANUALLY. The deployed GAP3 cron-health detector
# (withCronHealthSignal #1340/#1366) did NOT auto-catch it — it reads daemon-cached
# cron-state, which a daemon restart staleens, so the masking-DETECTOR is itself
# maskable by the very event it should catch. This is the operational/status-masking
# class (cortextos status reports "running" while the heartbeat mechanism is dead).
#
# WHAT: read each agent's last_heartbeat from the BUS STORE (cortextos bus
# list-agents) — a RESTART-DURABLE source independent of the daemon cache — and
# check wall-clock advance. OUTCOME-based (did the heartbeat actually move) not
# process-based (did a cron fire). This is the un-maskable backstop per the
# Cycle-8 design-principle: check outcome from a source the mechanism cannot corrupt.
#
# This is the DETECT-side INTERIM safety net (per SYS-DAEMON-RESILIENCE-01 §6,
# PD detect-first/prevent-after sequencing): it lands now + catches a recurrence
# within one watch cycle so PD can wake-nudge before agents sit stale for hours.
# The durable PREVENT-side (devops reconcile-on-boot + inject-worker rebind) lands
# after. Severity-2 (session HUNG while status=running, e.g. improver today) is NOT
# caught here — tick-advance only catches tick-stopped; severity-2 rides the devops
# inject-worker-rebind liveness probe (daemon-can-reach-session). This watch = sev-1.
#
# CROSS-MONITOR COVERAGE COUPLING (bidirectional — DO NOT remove without the reciprocal):
#   This backstop COVERS the post-restart-fleet-never-recovers global-pause: after a daemon
#   restart, credit-death/daemon-wide-freeze leaves every agent hb-stale + work-silent, which
#   this watch ALERTs (the daemon-restart-stall class it is built for, trust-state-independent).
#   The wedge-watchdog HOLD-gate (holdAlertGate(fleetTrustedCount, K=3), scripts/self-healing/)
#   INTENTIONALLY SUPPRESSES its "possible global pause" alert during fleet-bootstrap (< K
#   trusted, e.g. just-post-restart) to avoid a guaranteed-recurring false-push — and that
#   suppression is SAFE *only because this backstop covers the suppressed case*. The two
#   monitors PARTITION the global-pause space: wedge HOLD = trusted-fleet-MID-RUN-stop (trust
#   preserved, no restart); this backstop = POST-RESTART-fleet-never-recovers. If this watch's
#   daemon-restart-stall detection is ever disabled/retuned, UPDATE the wedge holdAlertGate in
#   the same change — else the wedge suppression silently re-opens a global-pause blind spot
#   (the reciprocal note lives in wedge-watchdog holdAlertGate). A hidden cross-monitor
#   coverage dependency is itself a masking-class risk; the coupling is documented on BOTH sides.
#
# THRESHOLDS (PER-AGENT, interval-aware — SYS-WATCHDOG-CAL 2026-06-28):
#   The fleet's heartbeat-cron intervals are 6x non-uniform: 5 HEAVY agents
#   (backend-architect/cortextos-improver/frontend-dev/platform-director/
#   systems-analyst) heartbeat every 4h ("M */4" -> 240min backstop), 3 agents
#   (cannametrics-data/integrations-routing/product-owner) every 30min ("M1,M2 *"),
#   and 2 (devops-monitor/user-proxy) hourly ("M *" -> 60min). A UNIVERSAL threshold
#   cannot fit all: WARN150 sat BELOW the heavy-5's own 240min backstop, so an
#   idle-but-ALIVE heavy agent legitimately ages to ~240min and false-WARNs in the
#   150-240 gap BEFORE its backstop refreshes (the 2026-06-28 synchronized-idle
#   false-WARN: PD/SA/BA/FE finished a burst ~18:42, went idle in lockstep, all 4
#   aged toward 240min together). Activity-suppression (below) does NOT cover this:
#   a genuinely-IDLE-but-alive agent produces no work to corroborate, and the
#   suppression window (= the tripped universal threshold) is shorter than the 240min
#   backstop. Idle-alive is a distinct case from busy-mid-turn.
#
#   So each agent's thresholds are now KEYED TO ITS OWN configured heartbeat interval
#   (read from config.json crons[name=heartbeat].cron):
#     interval = max consecutive gap (min) between fires of that cron expr
#     WARN_agent  = max(WARN_FLOOR=90,  interval + WARN_MARGIN=60)
#     ALERT_agent = max(ALERT_FLOOR=150, ceil(interval * ALERT_FACTOR=1.5))
#   Effect: heavy-5 -> WARN300/ALERT360 (never false-WARN on 4h-idle; their own
#   backstop is 240min so detection cannot be tighter than that by construction);
#   30min agents -> WARN90/ALERT150 (FASTER detection than the old universal 150/210);
#   hourly -> WARN120/ALERT150. The FLOORS preserve the daemon-restall (4-6h) catch
#   for EVERY agent: ALERT still fires on a real long stall (the cross-monitor coupling
#   below is therefore intact — raising thresholds upward never disables that
#   detection; the wedge holdAlertGate partition needs no reciprocal change).
#   Agents whose config/heartbeat-cron can't be read fall back to the universal
#   WARN_FLOOR/ALERT_FLOOR (safe-generous), logged as [fallback] on their line.
#
# Run:  bash scripts/self-healing/fleet-heartbeat-advance-watch.sh  (read-only; bus-store)
# Exit: 0 = all agents below their per-agent WARN threshold      — no fire
#       1 = >=1 agent past its per-agent ALERT threshold         — route ALERT to PD lane
#       3 = WARN-only (>=1 past per-agent WARN, none at ALERT)   — soft heads-up to PD lane
#       2 = probe error (list-agents empty/unreadable)           — probe-blind, do NOT fire
set -euo pipefail

# PER-AGENT interval-aware threshold parameters (SYS-WATCHDOG-CAL). Each agent's
# WARN/ALERT is derived from its OWN heartbeat-cron interval (see header). The FLOORS
# are the daemon-restall safety net (every agent ALERTs on a real long stall) and the
# fallback for agents whose config can't be read. All env-overridable for tuning/tests.
#   WARN_FLOOR   — no agent WARNs below this even if its interval is tiny (generous-safe)
#   ALERT_FLOOR  — no agent ALERTs below this; catches the 4-6h daemon-restall class
#   WARN_MARGIN  — added to interval for WARN (covers cron jitter/stagger above interval)
#   ALERT_FACTOR — interval multiplier for ALERT (a real stall sails past N x interval)
WARN_FLOOR_MIN="${FLEET_HB_WARN_FLOOR_MIN:-90}"
ALERT_FLOOR_MIN="${FLEET_HB_ALERT_FLOOR_MIN:-150}"
WARN_MARGIN_MIN="${FLEET_HB_WARN_MARGIN_MIN:-60}"
ALERT_FACTOR="${FLEET_HB_ALERT_FACTOR:-1.5}"
# Config root holding orgs/<org>/agents/<name>/config.json (heartbeat-cron source).
# Prefer $CTX_FRAMEWORK_ROOT; else derive from this script's location (scripts/self-healing/
# -> framework root is two dirs up) so it stays correct under re-clone/relocation.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

# ADVANCE-DELTA state: persist each agent's last_heartbeat between fires so a FROZEN
# agent (last_heartbeat NOT advancing across a cycle) is caught within ONE cycle,
# regardless of absolute age — the outcome-check (did it MOVE) beating the proxy
# (is the age high). Proof case 2026-06-17: frontend-dev frozen-since-19:08 sat 1min
# under the absolute WARN90 at the 20:37 fire; absolute-age missed it, advance-delta
# flags it immediately. A genuinely-slow-but-healthy agent (e.g. passive user-proxy)
# still ADVANCES within a cycle, so it won't trip FROZEN. FROZEN is WARN-level (soft),
# not a hard page, to stay safe against any unusually-slow-but-healthy interval.
# (SCRIPT_DIR defined above, alongside CONFIG_ROOT.)
# Runtime state lives in CTX_ROOT/state (outside the repo) — never next to the tracked
# script, so relocating into scripts/self-healing/ produces zero tracked churn.
STATE_FILE="${FLEET_HB_STATE_FILE:-${CTX_ROOT:-$HOME/.cortextos/default}/state/.fleet-hb-prev-state.json}"
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

# Bus-store is the restart-durable source of truth (independent of daemon cache).
# FLEET_HB_RAW_OVERRIDE = test hook: inject a synthetic list-agents JSON to exercise the
# spare/alert paths deterministically (used by the negative-case test; unset in production).
RAW="${FLEET_HB_RAW_OVERRIDE:-$(cortextos bus list-agents --format json 2>/dev/null || true)}"
if [ -z "$RAW" ]; then
  echo "FLEET-HB-WATCH: ERROR — empty list-agents response (bus store unreadable?)" >&2
  exit 2
fi

# ACTIVITY-CORROBORATION input: a stale/frozen heartbeat is only a PROXY for a stop.
# work-produced is the un-maskable OUTCOME. A busy agent on a long work-turn (15-25min:
# rebases, builds, CI-watchers, long inference) ages its heartbeat WHILE genuinely
# producing — it only heartbeats at turn boundaries (cause-3: the FE 2026-06-17 + the
# improver 2026-06-19 [2x today] false-positives that would have cost a wrong reap).
#
# TWO outcome sources, combined (newest wins = liveness):
#  (1) task-activity (bus-store updated_at/completed_at) — RESTART-DURABLE but COARSE:
#      an agent producing mid-long-turn need not touch the task store, so this alone
#      MISSED improver (busy writing context_status, last task-update older than its hb).
#  (2) work-produced fs-mtime — the SHARED wedge-watchdog lastActivity source-set:
#      newest of {state/<name>/context_status.json, logs/<name>/stdout.log, state/<name>/
#      newest-file mtime}. context_status.json is the STRONGEST live signal (a wedged
#      session mid-dead-stream CANNOT write it) but only improver-class agents emit it;
#      stdout.log + state-dir mtime cover the rest. Consuming the SAME source-set as
#      wedge-watchdog-data.mjs lastActivity() keeps the two monitors from disagreeing on
#      busy-vs-stalled for the same agent (PD coherence req 2026-06-19; mirror until the
#      .mjs adds context_status — flagged to devops to fold into the in-flight iteration).
#
# RECENCY is WINDOW-RELATIVE (PD req): spare only if liveness is newer than the staleness
# threshold the candidate TRIPPED (now - liveness < that threshold), matching wedge B2's
# activity-within-the-window. An agent whose LAST work is OLDER than the freeze (produced
# once after an old hb then genuinely went quiet) still ALERTs — we never spare on
# stale-old activity. Corroboration-blind (no sources readable) -> do NOT suppress (fail
# toward surfacing, never hide). Tasks -> TEMP FILE (task-store JSON too large for env; E2BIG).
TASKS_FILE="$(mktemp -t fleet-hb-tasks.XXXXXX)"
trap 'rm -f "$TASKS_FILE"' EXIT
cortextos bus list-tasks --format json > "$TASKS_FILE" 2>/dev/null || echo '[]' > "$TASKS_FILE"

CTX_BASE="${CTX_ROOT:-$HOME/.cortextos/${CTX_INSTANCE_ID:-default}}"
WARN_FLOOR_MIN="$WARN_FLOOR_MIN" ALERT_FLOOR_MIN="$ALERT_FLOOR_MIN" WARN_MARGIN_MIN="$WARN_MARGIN_MIN" ALERT_FACTOR="$ALERT_FACTOR" CONFIG_ROOT="$CONFIG_ROOT" RAW="$RAW" TASKS_FILE="$TASKS_FILE" STATE_FILE="$STATE_FILE" CTX_BASE="$CTX_BASE" python3 - <<'PY'
import json, os, sys, datetime, glob, math

# PER-AGENT interval-aware thresholds (SYS-WATCHDOG-CAL). Floors/margin/factor are the
# knobs; each agent's WARN/ALERT is derived from its own heartbeat-cron interval below.
warn_floor = float(os.environ["WARN_FLOOR_MIN"])
alert_floor = float(os.environ["ALERT_FLOOR_MIN"])
warn_margin = float(os.environ["WARN_MARGIN_MIN"])
alert_factor = float(os.environ["ALERT_FACTOR"])
config_root = os.environ.get("CONFIG_ROOT", "")
state_file = os.environ["STATE_FILE"]
now = datetime.datetime.now(datetime.timezone.utc)

def _expand_cron_field(field, lo, hi):
    """Expand one cron field to a sorted set of ints in [lo,hi]. Supports *, */N,
    a-b, a-b/N, comma-lists, and single values. Raises on anything unparseable."""
    out = set()
    for part in field.split(","):
        step = 1
        if "/" in part:
            base, step_s = part.split("/", 1)
            step = int(step_s)
        else:
            base = part
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            s, e = base.split("-", 1)
            start, end = int(s), int(e)
        else:
            start = end = int(base)
        for v in range(start, end + 1, step):
            if lo <= v <= hi:
                out.add(v)
    if not out:
        raise ValueError("empty field")
    return sorted(out)

def cron_interval_minutes(expr):
    """Max consecutive gap (minutes) between fires of a 5-field cron expr, over a
    24h window. This is the LONGEST an agent legitimately goes silent between ticks,
    so thresholds derived from it never false-fire on the slow side. Returns None
    if the expr can't be parsed or constrains day/month/dow (not a pure intraday cron)."""
    parts = expr.split()
    if len(parts) < 5:
        return None
    minute, hour, dom, mon, dow = parts[0], parts[1], parts[2], parts[3], parts[4]
    # Only handle pure intraday recurrence (dom/mon/dow unrestricted); anything else
    # falls back to floors rather than guessing.
    if dom != "*" or mon != "*" or dow != "*":
        return None
    try:
        minutes = _expand_cron_field(minute, 0, 59)
        hours = _expand_cron_field(hour, 0, 23)
    except Exception:
        return None
    fires = sorted(h * 60 + m for h in hours for m in minutes)
    if not fires:
        return None
    if len(fires) == 1:
        return 1440  # once per day
    gaps = [fires[i + 1] - fires[i] for i in range(len(fires) - 1)]
    gaps.append(fires[0] + 1440 - fires[-1])  # wrap across midnight
    return max(gaps)

def agent_heartbeat_interval(name):
    """Read name's heartbeat-cron interval (min) from its config.json. None if the
    config or heartbeat cron can't be found/parsed -> caller uses the floor fallback."""
    if not config_root:
        return None
    for cfg_path in glob.glob(os.path.join(config_root, "orgs", "*", "agents", name, "config.json")):
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
        except Exception:
            continue
        for c in cfg.get("crons", []):
            if (c.get("name", "").lower() == "heartbeat") and c.get("cron"):
                iv = cron_interval_minutes(c["cron"])
                if iv is not None:
                    return iv
    return None

def thresholds_for(name):
    """(warn_min, alert_min, mode) for an agent. Interval-aware when its heartbeat
    cron is readable; floors otherwise (mode='fallback')."""
    iv = agent_heartbeat_interval(name)
    if iv is None:
        return warn_floor, alert_floor, "fallback"
    warn_a = max(warn_floor, iv + warn_margin)
    alert_a = max(alert_floor, math.ceil(iv * alert_factor))
    return warn_a, alert_a, f"interval={iv}min"

try:
    data = json.loads(os.environ["RAW"])
except Exception:
    print("FLEET-HB-WATCH: ERROR — unparseable list-agents JSON", file=sys.stderr)
    sys.exit(2)

agents = data if isinstance(data, list) else data.get("agents", [])
if not agents:
    print("FLEET-HB-WATCH: ERROR — no agents in list-agents response", file=sys.stderr)
    sys.exit(2)

# ACTIVITY map {agent: newest task updated/completed datetime} = the un-maskable OUTCOME.
# A heartbeat-candidate with task-activity AFTER its last_heartbeat is provably alive
# past the heartbeat (busy-not-frozen, cause-3) -> SUPPRESS. Corroboration-blind
# (empty/bad tasks) -> activity={} -> do NOT suppress (fail toward surfacing, never hide).
agent_activity = {}
try:
    with open(os.environ["TASKS_FILE"]) as tf:
        tasks = json.load(tf)
    for t in (tasks if isinstance(tasks, list) else []):
        who = t.get("assigned_to")
        if not who:
            continue
        for ts in (t.get("updated_at"), t.get("completed_at")):
            if not ts:
                continue
            try:
                dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except Exception:
                continue
            if who not in agent_activity or dt > agent_activity[who]:
                agent_activity[who] = dt
except Exception:
    agent_activity = {}  # corroboration-blind -> do not suppress

# fs-mtime activity = the SHARED wedge-watchdog lastActivity source-set:
# newest of {state/<name>/context_status.json, logs/<name>/stdout.log, state/<name>/
# newest-file mtime}. Finer-grained than task-activity (catches busy-mid-long-turn that
# never touches the task store, e.g. improver). Bus agent name == fs dir name (verified).
# Any path absent/unreadable -> just skipped (an agent missing context_status still has
# stdout.log + state-dir). Returns None only if NOTHING is readable (corroboration-blind).
ctx_base = os.environ.get("CTX_BASE", "")
def fs_activity_dt(name):
    if not ctx_base:
        return None
    newest = None
    explicit = [
        os.path.join(ctx_base, "state", name, "context_status.json"),
        os.path.join(ctx_base, "logs", name, "stdout.log"),
    ]
    for p in explicit:
        try:
            dt = datetime.datetime.fromtimestamp(os.path.getmtime(p), datetime.timezone.utc)
        except OSError:
            continue
        if newest is None or dt > newest:
            newest = dt
    sdir = os.path.join(ctx_base, "state", name)
    try:
        for entry in os.scandir(sdir):
            if not entry.is_file():
                continue
            try:
                dt = datetime.datetime.fromtimestamp(entry.stat().st_mtime, datetime.timezone.utc)
            except OSError:
                continue
            if newest is None or dt > newest:
                newest = dt
    except OSError:
        pass
    return newest

# Prev-fire readings {agent: last_heartbeat_value} for the advance-delta (frozen) check.
prev = {}
try:
    with open(state_file) as f:
        prev = json.load(f).get("readings", {})
except Exception:
    prev = {}  # first fire / missing / unreadable -> absolute-only this cycle

alerts, warns, lines = [], [], []
new_readings = {}
for ag in agents:
    name = ag.get("name", "?")
    if ag.get("enabled") is False:
        continue  # intentionally-disabled agents do not heartbeat
    hb = ag.get("last_heartbeat") or ag.get("lastHeartbeat") or ag.get("heartbeat_at")
    if not hb:
        lines.append(f"  {name}: NO last_heartbeat field -> skip (cannot assess)")
        continue
    try:
        hb_dt = datetime.datetime.fromisoformat(hb.replace("Z", "+00:00"))
        age_m = (now - hb_dt).total_seconds() / 60.0
    except Exception:
        lines.append(f"  {name}: unparseable last_heartbeat '{hb}' -> skip")
        continue
    new_readings[name] = hb
    # PER-AGENT interval-aware thresholds (SYS-WATCHDOG-CAL): keyed to THIS agent's own
    # heartbeat-cron interval so an idle-but-alive heavy agent (240min backstop) never
    # false-WARNs in the old 150-240 gap, while fast agents get tighter detection.
    warn_m, alert_m, mode = thresholds_for(name)
    # FROZEN = last_heartbeat did NOT advance since the prev fire (zero-advance).
    frozen = name in prev and prev[name] == hb
    # Candidate status = ABSOLUTE staleness only. advance-delta "frozen" is DEMOTED to
    # an informational note (not an independent trigger): its only two standalone catches
    # 2026-06-17 were BOTH false-positives (FE busy-long-turn, user-proxy hourly-heartbeat)
    # — at the watch's hourly cadence, zero-advance cannot distinguish frozen from a slow
    # or busy agent. Absolute-stale + activity-corroboration carry the real detection.
    if age_m > alert_m:
        status, bucket = "ALERT", alerts
    elif age_m > warn_m:
        status, bucket = "WARN", warns
    else:
        status, bucket = "OK", None
    # ACTIVITY-CORROBORATION (the OUTCOME, WINDOW-RELATIVE): liveness = newest of
    # {task-activity (bus-store), fs-mtime (context_status/stdout/state-dir)}. A candidate
    # is SUPPRESSED (busy-not-frozen) only if it produced work WITHIN the staleness window
    # it tripped (now - liveness < that threshold) — matching wedge B2. An agent whose LAST
    # work is OLDER than the freeze (genuinely went quiet) still ALERTs; never spare on
    # stale-old activity. Corroboration-blind (no source) -> do NOT suppress. NEVER auto-acts.
    threshold_for = alert_m if status == "ALERT" else (warn_m if status == "WARN" else None)
    live_dt = agent_activity.get(name)
    fs_dt = fs_activity_dt(name)
    if fs_dt is not None and (live_dt is None or fs_dt > live_dt):
        live_dt = fs_dt
    # frozen-note only on actual candidates (WARN/ALERT) — not on OK agents (avoids the
    # misleading "OK [frozen]" line; an OK agent simply hasn't ticked yet this window).
    note = " [frozen: hb unchanged since last fire]" if (frozen and bucket is not None) else ""
    if bucket is not None and live_dt is not None and threshold_for is not None:
        live_age_m = (now - live_dt).total_seconds() / 60.0
        if live_age_m < threshold_for:
            note = (f" -> SUPPRESSED busy (work-produced {live_age_m:.0f}min ago, "
                    f"within the {threshold_for:.0f}min window — busy-not-frozen)")
            status, bucket = "BUSY", None  # alive within the staleness window: do not alert
    lines.append(f"  {name}: hb {age_m:.0f}min old (WARN>{warn_m:.0f}, ALERT>{alert_m:.0f}; {mode}) -> {status}{note}")
    if bucket is not None:
        bucket.append({"agent": name, "hbAgeMin": round(age_m), "status": status,
                       "reason": "absolute_alert" if status == "ALERT" else "absolute_warn",
                       "frozenNote": frozen,
                       "threshold": alert_m if status == "ALERT" else warn_m})

# Persist this fire's readings for the next cycle's advance-delta check.
try:
    with open(state_file, "w") as f:
        json.dump({"recordedAt": now.isoformat(), "readings": new_readings}, f)
except Exception as e:
    print(f"FLEET-HB-WATCH: WARN — could not write state file {state_file}: {e}", file=sys.stderr)

print("FLEET-HB-WATCH (bus-store last_heartbeat, restart-durable, advance-delta frozen-detection):")
print("\n".join(lines))

if alerts:
    print("\nALERT — route to PD lane (heartbeat stalled past the agent's per-agent "
          "interval-aware ALERT threshold [see each entry's 'threshold']; PD triages "
          "nudge [sev-1 false-stale] then reap+cold-restart [sev-2 hung] per runbook):")
    print(json.dumps(alerts, indent=2))
    sys.exit(1)
if warns:
    print("\nWARN — soft heads-up to PD lane (FROZEN = hb did not advance since last fire = "
          "cron-stopped, caught in one cycle regardless of age; or absolute-stale past the "
          "agent's per-agent WARN threshold [see each entry's 'threshold']):")
    print(json.dumps(warns, indent=2))
    sys.exit(3)
print("\nAll enabled agents heartbeating fresh (below their per-agent interval-aware WARN "
      "thresholds) + advancing — fleet tick healthy.")
sys.exit(0)
PY
