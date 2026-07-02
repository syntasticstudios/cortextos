#!/usr/bin/env python3
"""Decision-latency capture v1 (theta-C7 deliverable).

Three separate series, classified by BINDING constraint (PD rule):
  - fleet_decision_latency  : ruling-binding. Clock = decision_surfaced event (metadata.surfaced_at) -> ruling.
  - freeze_park_age         : freeze-binding (SAT-FREEZE/POST-LAUNCH). Clock = blocked-entry (created_at proxy, upper-bound).
  - human_action_latency    : [HUMAN] task-doing. Clock = created_at proxy, upper-bound.

Ruling series consumes PD's decision_surfaced events (the only clean surfaced-clock source).
Still-blocked stamped tasks = CENSORED (report open-age, not a closed latency).
Emits median/p90/max per series. Weekly append.
"""
import json, glob, os, sys, datetime, re, statistics

CTX = os.path.expanduser("~/.cortextos/default")
EVENTS_GLOB = f"{CTX}/orgs/phytomedic/analytics/events/*/*.jsonl"
NOW = datetime.datetime.now(datetime.timezone.utc)

def parse_iso(s):
    if not s: return None
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None

def days_between(a, b):
    return (b - a).total_seconds() / 86400.0

def pct(vals, p):
    if not vals: return None
    vals = sorted(vals)
    k = (len(vals) - 1) * (p / 100.0)
    f = int(k); c = min(f + 1, len(vals) - 1)
    return round(vals[f] + (vals[c] - vals[f]) * (k - f), 2)

def summarize(vals):
    if not vals: return {"n": 0}
    return {"n": len(vals), "median": round(statistics.median(vals), 2),
            "p90": pct(vals, 90), "max": round(max(vals), 2)}

# --- 1. gather decision_surfaced events (ruling-binding, PD-stamped) ---
surfaced = {}    # task_id -> {surfaced_at, channel}   (ruling CLOCK source)
classified = {}  # task_id -> {binding_class, at}       (PD authoritative CLASS)
VALID_CLASSES = {"ruling", "freeze_park", "human_action", "agent_dep", "stale"}
for f in glob.glob(EVENTS_GLOB):
    try:
        for line in open(f):
            if "decision_surfaced" not in line and "decision_classified" not in line:
                continue
            e = json.loads(line)
            ev = e.get("event"); m = e.get("metadata") or {}
            tid = m.get("task_id")
            if not tid:
                continue
            if ev == "decision_surfaced":
                sa = parse_iso(m.get("surfaced_at"))
                if sa and (tid not in surfaced or sa < surfaced[tid]["surfaced_at"]):
                    surfaced[tid] = {"surfaced_at": sa, "channel": m.get("channel")}
            elif ev == "decision_classified":
                bc = m.get("binding_class")
                at = parse_iso(e.get("timestamp"))
                if bc in VALID_CLASSES:
                    # latest classification wins (freeze-lift re-emit reclassifies)
                    if tid not in classified or (at and classified[tid]["at"] and at >= classified[tid]["at"]):
                        classified[tid] = {"binding_class": bc, "at": at}
    except Exception:
        continue

# --- 2. load tasks ---
import subprocess
tasks_raw = subprocess.run(["cortextos", "bus", "list-tasks", "--format", "json"],
                           capture_output=True, text=True).stdout
tasks = json.loads(tasks_raw)
by_id = {t.get("id"): t for t in tasks}

def is_freeze(t):
    ti = (t.get("title", "") + " " + t.get("description", "")).lower()
    return any(k in ti for k in ["sat-freeze", "freeze-blocked", "post-launch", "post_launch"])

def is_human(t):
    ti = t.get("title", "")
    # convention: "[HUMAN] X" prefix OR a "HUMAN " token in the title (e.g. "...HUMAN Clerk...")
    return ("[human]" in ti.lower() or re.search(r"\bHUMAN\b", ti)
            or (t.get("assigned_to") or "").lower() in ("human", "founder", "user"))

# --- 3. authoritative class per task: PD decision_classified overrides heuristic ---
def heuristic_class(t):
    if is_freeze(t): return "freeze_park"
    if is_human(t):  return "human_action"
    return None  # unknown -> not bucketed by heuristic

def held(t):
    return t.get("status") in ("blocked", "pending")  # human_action are often pending, not blocked

def resolved_ts(t):
    return parse_iso(t.get("completed_at")) or parse_iso(t.get("updated_at"))

# --- 4. build the 3 decision-series + excluded classes ---
closed, censored = [], []            # fleet_decision_latency (ruling)
freeze_ages, human_ages = [], []     # freeze_park_age, human_action_latency
excluded = {"agent_dep": 0, "stale": 0}
heuristic_used, authoritative_used = 0, 0

# union of tasks PD classified + heuristic-eligible held tasks (unclassified fallback)
consider = set(classified) | {t.get("id") for t in tasks if held(t)}
for tid in consider:
    t = by_id.get(tid)
    if not t:
        continue
    if tid in classified:
        bc = classified[tid]["binding_class"]; authoritative_used += 1
    elif tid in surfaced:
        bc = "ruling"; authoritative_used += 1     # a decision_surfaced stamp IMPLIES ruling-binding (PD only stamps ruling)
    else:
        bc = heuristic_class(t)                     # fallback only for un-stamped, un-classified held tasks
        if bc is None:
            continue
        heuristic_used += 1

    if bc == "ruling":
        s = surfaced.get(tid)
        if not s:      # ruling-class but no surfaced_at clock yet
            continue
        if t.get("status") == "blocked":
            censored.append({"task": tid, "open_age_days": round(days_between(s["surfaced_at"], NOW), 2),
                             "channel": s.get("channel")})
        else:
            r = resolved_ts(t)
            if r: closed.append(round(days_between(s["surfaced_at"], r), 2))
    elif bc in ("freeze_park", "human_action"):
        ca = parse_iso(t.get("created_at"))
        if not ca:
            continue
        end = NOW if held(t) else (resolved_ts(t) or NOW)
        age = round(days_between(ca, end), 2)
        (freeze_ages if bc == "freeze_park" else human_ages).append(age)
    elif bc in excluded:
        excluded[bc] += 1

report = {
    "captured_at": NOW.isoformat(),
    "fleet_decision_latency_days": {
        "closed": summarize(closed),
        "open_censored": len(censored),
        "open_detail": censored,
        "clock": "surfaced_at -> ruling (PD decision_surfaced stamped)",
    },
    "freeze_park_age_days": {**summarize(freeze_ages),
                             "clock": "created_at -> resolved/now (UPPER-BOUND age)"},
    "human_action_latency_days": {**summarize(human_ages),
                                  "clock": "created_at -> resolved/now (UPPER-BOUND age)"},
    "excluded_classes": excluded,  # agent_dep + stale: classified, not in any decision-series
    "classification": {
        "authoritative_stamped": authoritative_used,  # PD decision_classified
        "heuristic_fallback": heuristic_used,          # my title-heuristic (should -> 0 after PD seed)
    },
}
print(json.dumps(report, indent=2))

# weekly append to durable timeseries (one JSON line per capture)
TS_PATH = os.environ.get("DECISION_LATENCY_TS",
    os.path.join(CTX, "state", "systems-analyst", "decision-latency-timeseries.jsonl"))
if "--append" in sys.argv:
    os.makedirs(os.path.dirname(TS_PATH), exist_ok=True)
    row = {"captured_at": report["captured_at"],
           "ruling_closed": report["fleet_decision_latency_days"]["closed"],
           "ruling_open_censored": report["fleet_decision_latency_days"]["open_censored"],
           "freeze_park": {k: report["freeze_park_age_days"].get(k) for k in ("n","median","p90","max")},
           "human_action": {k: report["human_action_latency_days"].get(k) for k in ("n","median","p90","max")}}
    with open(TS_PATH, "a") as f:
        f.write(json.dumps(row) + "\n")
    sys.stderr.write(f"[appended weekly point -> {TS_PATH}]\n")
