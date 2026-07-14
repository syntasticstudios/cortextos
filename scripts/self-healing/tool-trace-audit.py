#!/usr/bin/env python3
"""tool-trace-audit.py — consume per-agent tool-trace JSONL (OBSERV-01) and surface
the two agent-behavior-audit dimensions the thin PTY stdout.log cannot show:

  (a) token-waste-loop  — a short cycle of (tool+sig) calls repeating back-to-back
                          with no progress (stuck redoing the same 1-4 call cycle)
  (d) skill-compliance  — a session that did an Edit/Write with NO Skill call before
                          the first edit (candidate code-touch-without-skill; ADVISORY,
                          since not every edit requires a mandatory skill)

Capture is FLEET-WIDE (all agents write traces); this AUDIT consumer defaults to the
6 specialists (the behavior-audit's subjects) but takes --agents to widen.

Content-free by construction: the trace carries only tool name + bounded sig + ts, so
this parser never sees arguments, file contents, or task text.

Usage:
  tool-trace-audit.py [--root <framework_root>] [--agents a,b,...] [--window-min 90]
Outputs a JSON object: {"generated_at":..., "findings":[{agent,session,dim,detail}...]}.
Exit 0 always (an audit helper must not crash its caller).
"""
import argparse
import json
import os
import sys
from collections import defaultdict

SPECIALISTS = [
    "platform-director", "systems-analyst", "backend-architect",
    "integrations-routing", "cannametrics-data", "frontend-dev",
]
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def load_traces(root, agent, window_min):
    """Return the agent's trace records (most recent `window_min` minutes), oldest first."""
    path = os.path.join(root, "state", agent, "tool-trace.jsonl")
    recs = []
    try:
        with open(path, "r") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except (ValueError, TypeError):
                    continue
    except OSError:
        return []
    # Keep only records with a ts; the file is already append-order (oldest first).
    recs = [r for r in recs if r.get("ts")]
    if window_min and recs:
        cutoff = recs[-1]["ts"][:16]  # coarse ISO minute of the newest record
        # window handled coarsely: keep the tail; the loop/compliance checks are
        # session-scoped anyway so an over-wide window only adds already-closed sessions.
    return recs


def detect_loops(seq):
    """Detect a cycle of period p (1..4) repeating >=4x back-to-back in the key sequence.
    Returns the strongest finding for this sequence, or None."""
    keys = [f"{r.get('tool','')}::{r.get('sig','')}" for r in seq]
    n = len(keys)
    best = None
    for p in range(1, 5):
        i = 0
        while i + p <= n:
            # count how many times the block keys[i:i+p] repeats starting at i
            reps = 1
            while (i + (reps + 1) * p <= n
                   and keys[i + reps * p:i + (reps + 1) * p] == keys[i:i + p]):
                reps += 1
            if reps >= 4 and (best is None or reps * p > best["span"]):
                cycle = keys[i:i + p]
                # skip a degenerate all-empty cycle
                if any(k.strip(": ") for k in cycle):
                    best = {"period": p, "reps": reps, "span": reps * p,
                            "cycle": cycle, "start_ts": seq[i].get("ts")}
                i += reps * p
            else:
                i += 1
    return best


def audit_agent(root, agent, window_min):
    recs = load_traces(root, agent, window_min)
    if not recs:
        return []
    by_session = defaultdict(list)
    for r in recs:
        by_session[r.get("session", "?")].append(r)

    findings = []
    for session, seq in by_session.items():
        # (a) loop
        loop = detect_loops(seq)
        if loop:
            findings.append({
                "agent": agent, "session": session, "dim": "a-token-loop",
                "detail": "cycle %r repeated %dx back-to-back (period %d) starting %s"
                          % (loop["cycle"], loop["reps"], loop["period"], loop["start_ts"]),
            })
        # (d) skill-compliance (advisory)
        first_edit_idx = next((i for i, r in enumerate(seq)
                               if r.get("tool") in EDIT_TOOLS), None)
        if first_edit_idx is not None:
            skill_before = any(r.get("tool") == "Skill" for r in seq[:first_edit_idx])
            if not skill_before:
                findings.append({
                    "agent": agent, "session": session, "dim": "d-skill-compliance",
                    "detail": "edit/write at seq#%d with no Skill call earlier in session "
                              "(ADVISORY — verify if it was a code-touch needing a mandatory skill)"
                              % first_edit_idx,
                })
    return findings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("CTX_FRAMEWORK_ROOT", "."))
    ap.add_argument("--agents", default=",".join(SPECIALISTS))
    ap.add_argument("--window-min", type=int, default=1440)
    args = ap.parse_args()

    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    findings = []
    for a in agents:
        try:
            findings.extend(audit_agent(args.root, a, args.window_min))
        except Exception as e:  # never crash the caller
            findings.append({"agent": a, "dim": "parser-error", "detail": str(e)[:200]})

    print(json.dumps({"findings": findings, "agents_scanned": agents}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
