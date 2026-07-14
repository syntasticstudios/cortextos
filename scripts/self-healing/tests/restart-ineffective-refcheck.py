#!/usr/bin/env python3
"""restart-ineffective-refcheck.py — reference implementation (v2) of the LOCKED
restart-ineffective classifier (SELF-HEAL-GUARD-02), validating the golden vector
is self-consistent. NOT the production guard (those are two INDEPENDENT impls:
src/daemon/stale-watchdog.ts and wedge-watchdog.mjs). This reference proves the
CONTRACT is correct before either side builds, and doubles as a regression harness.

v2 pins (from devops review of real IR log formats):
  1. ALL timestamp comparisons are epoch-ms (ISO parse handles millis/no-millis).
  2. Only type=crash lines count for session-ids (exclude type=daemon-stop/halted).
  3. hb-advance = the last_heartbeat TIMESTAMP; T0 = max(epoch(last_heartbeat) or 0,
     epoch(now) - scan_window_ms). A healthy agent's recent last_heartbeat => streak 0.
  4. streak = stale_restart entries with epoch(ts) > T0; reapWorking = type=crash
     respawns with ts > T0 have distinct session-ids AND count == streak.

Run: python3 restart-ineffective-refcheck.py   (exit 0 = all pass)
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "restart-ineffective-golden.json")

TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)")
STALE_RE = re.compile(r"WATCHDOG: stale_restart")
TYPE_RE = re.compile(r"type=(\S+)")
SESSION_RE = re.compile(r"session=([0-9a-f-]+)")

NOT_LOGGED_IN = [re.compile(r"Not logged in"), re.compile(r"(Please )?run /login", re.I),
                 re.compile(r"· API Usage Billing")]
RATE_LIMIT = [re.compile(r"/rate-limit-options"), re.compile(r"rate limit", re.I)]


def epoch_ms(ts):
    """Parse an ISO-8601 Z timestamp (with or without millis) to epoch ms. None if unparseable."""
    if not ts:
        return None
    try:
        return int(datetime.strptime(
            ts, "%Y-%m-%dT%H:%M:%S.%fZ" if "." in ts else "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def first_ts_ms(line):
    m = TS_RE.search(line)
    return epoch_ms(m.group(1)) if m else None


def classify(case, N, scan_window_ms):
    now_ms = epoch_ms(case["now"])
    hb = (case.get("heartbeat_json") or {}).get("last_heartbeat")
    hb_ms = epoch_ms(hb) or 0
    # T0 = last heartbeat, floored to the scan window (finding 3 + 4)
    T0 = max(hb_ms, now_ms - scan_window_ms)

    # streak: stale_restart entries with ts > T0 (finding 1: epoch compare)
    streak_ts = [t for line in case["restarts_log"] if STALE_RE.search(line)
                 for t in [first_ts_ms(line)] if t is not None and t > T0]
    streak = len(streak_ts)

    # respawn session-ids: type=crash ONLY, ts > T0 (finding 2)
    def parse_crash(line):
        tm = TYPE_RE.search(line)
        sm = SESSION_RE.search(line)
        return (tm.group(1) if tm else None, sm.group(1) if sm else None, first_ts_ms(line))
    crash_only = [(typ, sid, t) for (typ, sid, t) in map(parse_crash, case["crashes_log"])
                  if typ == "crash" and sid]
    run_sessions = [sid for (typ, sid, t) in crash_only if t is not None and t > T0]
    reap_working = (len(run_sessions) == streak and streak > 0
                    and len(set(run_sessions)) == len(run_sessions))

    # newestSessionId: newest type=crash line only (finding 2 minor)
    newest = None
    if crash_only:
        newest = max(crash_only, key=lambda x: (x[2] if x[2] is not None else -1))[1]

    ineffective = (streak >= N) and reap_working

    if streak >= N and not reap_working:
        label = "reap-failure-not-this-class"
    elif not ineffective:
        label = "n/a"
    else:
        s = case.get("stdout_current_session", "")
        if any(p.search(s) for p in NOT_LOGGED_IN):
            label = "not-logged-in"
        elif any(p.search(s) for p in RATE_LIMIT):
            label = "rate-limit"
        else:
            label = "unknown-needs-eyes"
    return {"ineffective": ineffective, "streak": streak,
            "newestSessionId": newest, "label": label}


def main():
    with open(GOLDEN) as f:
        vec = json.load(f)
    N = vec["N"]
    win = vec["scan_window_ms"]
    failures = 0
    for case in vec["cases"]:
        got = classify(case, N, win)
        exp = case["expected"]
        ok = got == exp
        print(f"[{'PASS' if ok else 'FAIL'}] {case['name']}")
        if not ok:
            failures += 1
            print(f"   expected: {exp}")
            print(f"   got:      {got}")
    print(f"--- {len(vec['cases']) - failures}/{len(vec['cases'])} cases pass ---")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
