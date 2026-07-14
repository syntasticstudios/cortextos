#!/usr/bin/env python3
"""restart-ineffective-refcheck.py — reference implementation of the LOCKED
restart-ineffective classifier (SELF-HEAL-GUARD-02) that validates the golden
vector is self-consistent. This is NOT the production guard (that lives in
src/daemon/stale-watchdog.ts, and the OOP one in wedge-watchdog.mjs — two
INDEPENDENT impls). This reference exists so the contract itself is proven
correct before either side implements against it, and doubles as a regression
harness both can diff against. Run: python3 restart-ineffective-refcheck.py
Exit 0 = all golden cases match; 1 = a mismatch (the contract or an expected is wrong).
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "restart-ineffective-golden.json")

TS_RE = re.compile(r"\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]?")
STALE_RE = re.compile(r"WATCHDOG: stale_restart")
SESSION_RE = re.compile(r"session=([0-9a-f-]+)")

NOT_LOGGED_IN = [re.compile(r"Not logged in"), re.compile(r"(Please )?run /login", re.I),
                 re.compile(r"· API Usage Billing")]
RATE_LIMIT = [re.compile(r"/rate-limit-options"), re.compile(r"rate limit", re.I)]


def ts_of(line):
    m = TS_RE.search(line)
    return m.group(1) if m else None


def classify(case, N):
    restarts = case["restarts_log"]
    crashes = case["crashes_log"]
    hb_advances = sorted(case.get("hb_advances", []))
    # T0 = most recent hb advance (else empty -> treat as before everything)
    T0 = hb_advances[-1] if hb_advances else ""
    # streak = WATCHDOG stale_restart entries with ts > T0
    streak_lines = [l for l in restarts if STALE_RE.search(l) and (ts_of(l) or "") > T0]
    streak = len(streak_lines)
    # session-ids of the corresponding respawns (crashes with ts > T0)
    streak_sessions = [SESSION_RE.search(l).group(1) for l in crashes
                       if SESSION_RE.search(l) and (ts_of(l) or "") > T0]
    newest_session = None
    if crashes:
        with_sid = [l for l in crashes if SESSION_RE.search(l)]
        if with_sid:
            newest_session = SESSION_RE.search(with_sid[-1]).group(1)
    reap_working = len(set(streak_sessions)) == len(streak_sessions) and len(streak_sessions) > 0
    ineffective = (streak >= N) and reap_working

    # label (post-fire only; here we compute the expected label for the vector)
    if streak >= N and not reap_working:
        label = "reap-failure-not-this-class"
    elif not ineffective:
        label = "n/a"
    else:
        stdout = case.get("stdout_current_session", "")
        if any(p.search(stdout) for p in NOT_LOGGED_IN):
            label = "not-logged-in"
        elif any(p.search(stdout) for p in RATE_LIMIT):
            label = "rate-limit"
        else:
            label = "unknown-needs-eyes"
    return {"ineffective": ineffective, "streak": streak,
            "newestSessionId": newest_session, "label": label}


def main():
    with open(GOLDEN) as f:
        vec = json.load(f)
    N = vec["N"]
    failures = 0
    for case in vec["cases"]:
        got = classify(case, N)
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
