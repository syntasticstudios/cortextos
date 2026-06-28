#!/usr/bin/env python3
# token-cost-rollup.py — Per-agent token/cost telemetry rollup (Phase 1).
#
# task_1782669950735 — design at:
#   orgs/phytomedic/agents/cortextos-improver/memory/design-token-cost-telemetry.md
#
# WHAT IT DOES (no src/ change — CI-freeze-independent; durable-cron convention):
#   For each enabled agent it tails the Claude Code session transcripts at
#   ~/.claude/projects/<agentDir-hash>/<session-uuid>.jsonl, extracts the
#   `message.usage` from assistant messages, and appends NORMALIZED RAW-COUNT
#   rows to  <ctxRoot>/logs/<agent>/token-usage.jsonl  (same dir/format family
#   as the codex runtime's codex-tokens.jsonl). It checkpoints per session by
#   BYTE OFFSET in <ctxRoot>/state/<agent>/token-rollup-offset.json so re-runs
#   only append NEW usage rows (idempotent — no double count).
#
#   It then aggregates ALL agents for the target day into
#   <ctxRoot>/orgs/<org>/analytics/cost.json, deriving USD ESTIMATES at
#   aggregation time from the versioned, effective-dated price table at
#   <ctxRoot>/orgs/<org>/analytics/price-table.json.
#
# DESIGN INVARIANTS (load-bearing — do not regress):
#   * token-usage.jsonl stores ONLY RAW token counts (+ model, ts, source,
#     session/message ids). NEVER bake a $ figure into it — the dollar value is
#     derived ONLY at rollup, by looking up price-table.json. A price change or
#     pricing bug then never corrupts history: cost.json is re-derivable anytime
#     from the raw counts.
#   * Each token TYPE is priced SEPARATELY (cache_read can be ~190x the input
#     volume and is billed at ~0.1x the input rate — pricing it at the input
#     rate would make the estimate garbage).
#
# TRANSCRIPT DEDUP (critical):
#   Claude Code's streaming writer emits the SAME assistant message ~3x (one
#   transcript line per stream flush), each carrying the FULL cumulative usage
#   (verified uniform within a message.id group). Summing raw lines overcounts
#   ~3x. We dedup by message.id, keeping the first occurrence, and carry the
#   last-emitted message.id across runs to suppress a group that straddles the
#   byte-offset boundary.
#
# stdlib only. Corrupt/partial lines are skipped, never fatal.

import json
import os
import re
import sys
import glob
import subprocess
from datetime import datetime, timezone

# --------------------------------------------------------------------------- #
# Paths / environment
# --------------------------------------------------------------------------- #

def _git_toplevel():
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return None

CTX_ROOT = (
    os.environ.get("CTX_FRAMEWORK_ROOT")
    or _git_toplevel()
    or os.getcwd()
)
CTX_ORG = os.environ.get("CTX_ORG", "phytomedic")
PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")

LOGS_DIR = os.path.join(CTX_ROOT, "logs")
STATE_DIR = os.path.join(CTX_ROOT, "state")
ANALYTICS_DIR = os.path.join(CTX_ROOT, "orgs", CTX_ORG, "analytics")
PRICE_TABLE_PATH = os.path.join(ANALYTICS_DIR, "price-table.json")
COST_JSON_PATH = os.path.join(ANALYTICS_DIR, "cost.json")

# Default price table (written if absent). Versioned + effective-dated so a
# price change is a one-line edit and cost.json is re-derivable from raw counts.
DEFAULT_PRICE_TABLE = {
    "effective_date": "2026-06-28",
    "currency": "USD",
    "per_million_tokens": {
        "opus":   {"input": 5,  "output": 25, "cache_read": 0.50, "cache_write_5m": 6.25,  "cache_write_1h": 10.00},
        "sonnet": {"input": 3,  "output": 15, "cache_read": 0.30, "cache_write_5m": 3.75,  "cache_write_1h": 6.00},
        "haiku":  {"input": 1,  "output": 5,  "cache_read": 0.10, "cache_write_5m": 1.25,  "cache_write_1h": 2.00},
        "fable":  {"input": 10, "output": 50, "cache_read": 1.00, "cache_write_5m": 12.50, "cache_write_1h": 20.00},
    },
    "match": "model-id substring -> opus|sonnet|haiku|fable, fallback opus",
    "source": "Anthropic public pricing (claude-api skill, cached 2026-06-04, "
              "verified 2026-06-28). cache_read=0.1x input, cache_write_5m=1.25x "
              "input, cache_write_1h=2.0x input.",
}


# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #

def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def atomic_write_json(path, obj):
    ensure_dir(os.path.dirname(path))
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=2, sort_keys=False)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def load_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


# --------------------------------------------------------------------------- #
# Agent discovery + transcript-dir resolution
# --------------------------------------------------------------------------- #

def transcript_hash(working_dir):
    """Claude Code project-dir hash: working-dir path with '/' and '.' -> '-'."""
    return re.sub(r"[/.]", "-", working_dir)


def list_agents():
    """Return [{name, org}] for ENABLED agents.

    Primary source: `cortextos bus list-agents --format json`. Falls back to
    scanning orgs/<org>/agents/* if the CLI is unavailable.
    """
    agents = []
    try:
        out = subprocess.run(
            ["cortextos", "bus", "list-agents", "--format", "json"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0 and out.stdout.strip():
            data = json.loads(out.stdout)
            for a in data:
                if a.get("enabled", True) is False:
                    continue
                agents.append({
                    "name": a.get("name"),
                    "org": a.get("org") or CTX_ORG,
                })
    except Exception:
        pass

    if agents:
        return [a for a in agents if a.get("name")]

    # Fallback: directory scan of this org.
    base = os.path.join(CTX_ROOT, "orgs", CTX_ORG, "agents")
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            if os.path.isdir(os.path.join(base, name)):
                agents.append({"name": name, "org": CTX_ORG})
    return agents


def agent_working_dir(agent):
    return os.path.join(CTX_ROOT, "orgs", agent["org"], "agents", agent["name"])


# --------------------------------------------------------------------------- #
# Transcript tail
# --------------------------------------------------------------------------- #

def extract_usage_row(obj):
    """Return a normalized RAW-COUNT row for an assistant usage entry, else None."""
    if obj.get("type") != "assistant":
        return None
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return None
    usage = msg.get("usage")
    if not isinstance(usage, dict):
        return None
    msg_id = msg.get("id")
    if not msg_id:
        return None

    def n(v):
        return v if isinstance(v, (int, float)) else 0

    ts = obj.get("timestamp") or datetime.now(timezone.utc).isoformat()

    # Split cache writes by TTL. Claude Code 1h-caches the stable system-prompt
    # prefix (ephemeral_1h_input_tokens) and 5m-caches the rest. 1h writes bill
    # at 2.0x input vs 1.25x for 5m, so a single cache_write rate understates
    # them. The split lives in usage.cache_creation; if that sub-object is
    # absent, attribute the whole cache_creation_input_tokens to 5m.
    cc = usage.get("cache_creation")
    if isinstance(cc, dict):
        w5m = n(cc.get("ephemeral_5m_input_tokens"))
        w1h = n(cc.get("ephemeral_1h_input_tokens"))
    else:
        w5m = n(usage.get("cache_creation_input_tokens"))
        w1h = 0

    return {
        "msg_id": msg_id,
        "row": {
            "ts": ts,
            "model": msg.get("model") or "unknown",
            "input_tokens": n(usage.get("input_tokens")),
            "output_tokens": n(usage.get("output_tokens")),
            "cache_read_tokens": n(usage.get("cache_read_input_tokens")),
            "cache_write_5m_tokens": w5m,
            "cache_write_1h_tokens": w1h,
            "source": "transcript",
            "session_id": obj.get("sessionId"),
            "message_id": msg_id,
        },
    }


def tail_session(path, offset, last_msg_id):
    """Read complete new lines from `offset`; dedup by message.id.

    Returns (new_rows, new_offset, new_last_msg_id). Only fully-terminated
    lines are consumed; a trailing partial line (live session mid-write) is
    left for the next run. `last_msg_id` suppresses a streaming group that
    straddles the offset boundary (already emitted on the prior run).
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return [], offset, last_msg_id

    if offset > size:
        # File shrank/rotated (rare) — restart from 0.
        offset = 0

    rows = []
    seen = set()
    new_offset = offset
    cur_last = last_msg_id

    try:
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read()
    except OSError:
        return [], offset, last_msg_id

    # Consume only up to the last newline; keep trailing partial for next run.
    last_nl = data.rfind(b"\n")
    if last_nl == -1:
        return [], offset, last_msg_id
    consumable = data[: last_nl + 1]
    new_offset = offset + len(consumable)

    for raw in consumable.split(b"\n"):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue  # skip corrupt line
        if not isinstance(obj, dict):
            continue
        extracted = extract_usage_row(obj)
        if not extracted:
            continue
        mid = extracted["msg_id"]
        # Boundary guard: a group already counted last run that bleeds into
        # the new chunk, or in-chunk streaming duplicates.
        if mid == cur_last or mid in seen:
            continue
        seen.add(mid)
        rows.append(extracted["row"])
        cur_last = mid

    return rows, new_offset, cur_last


def rollup_agent(agent):
    """Tail all sessions for one agent; append new rows to its token-usage.jsonl.

    Returns the count of new rows appended.
    """
    name = agent["name"]
    wdir = agent_working_dir(agent)
    tdir = os.path.join(PROJECTS_DIR, transcript_hash(wdir))
    if not os.path.isdir(tdir):
        return 0

    ckpt_path = os.path.join(STATE_DIR, name, "token-rollup-offset.json")
    ckpt = load_json(ckpt_path, {})
    if not isinstance(ckpt, dict):
        ckpt = {}
    sessions = ckpt.get("sessions")
    if not isinstance(sessions, dict):
        sessions = {}

    log_path = os.path.join(LOGS_DIR, name, "token-usage.jsonl")
    ensure_dir(os.path.dirname(log_path))

    total_new = 0
    out_lines = []

    for sess_path in sorted(glob.glob(os.path.join(tdir, "*.jsonl"))):
        sess_file = os.path.basename(sess_path)
        meta = sessions.get(sess_file) or {}
        offset = meta.get("offset", 0) if isinstance(meta, dict) else 0
        last_mid = meta.get("last_msg_id") if isinstance(meta, dict) else None

        rows, new_offset, new_last = tail_session(sess_path, offset, last_mid)
        sessions[sess_file] = {
            "offset": new_offset,
            "last_msg_id": new_last,
            "mtime": os.path.getmtime(sess_path),
        }
        for r in rows:
            out_lines.append(json.dumps(r))
        total_new += len(rows)

    # Append new rows, then persist the checkpoint (offset advanced only after
    # the append). On crash between the two the worst case is re-appending the
    # same rows next run; cost.json dedups defensively by (session,message_id).
    if out_lines:
        with open(log_path, "a") as fh:
            fh.write("\n".join(out_lines) + "\n")

    ckpt["sessions"] = sessions
    ckpt["updated_at"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(ckpt_path, ckpt)

    return total_new


# --------------------------------------------------------------------------- #
# Cost aggregation
# --------------------------------------------------------------------------- #

def model_bucket(model_id):
    m = (model_id or "").lower()
    if "opus" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    if "fable" in m:
        return "fable"
    return "opus"  # fallback


def _row_w5m(row):
    # New schema splits cache writes by TTL. Tolerate the old single-field
    # schema (cache_write_tokens) by attributing it all to 5m.
    if "cache_write_5m_tokens" in row or "cache_write_1h_tokens" in row:
        return row.get("cache_write_5m_tokens", 0)
    return row.get("cache_write_tokens", 0)


def _row_w1h(row):
    return row.get("cache_write_1h_tokens", 0)


def row_cost(row, price_table):
    rates = price_table.get("per_million_tokens", {})
    bucket = model_bucket(row.get("model"))
    p = rates.get(bucket) or rates.get("opus") or {}
    # cache_write_1h falls back to cache_write_5m, then to a legacy single rate.
    rate_w5m = p.get("cache_write_5m", p.get("cache_write", 0))
    rate_w1h = p.get("cache_write_1h", rate_w5m)
    return (
        (row.get("input_tokens", 0) / 1_000_000.0) * p.get("input", 0)
        + (row.get("output_tokens", 0) / 1_000_000.0) * p.get("output", 0)
        + (row.get("cache_read_tokens", 0) / 1_000_000.0) * p.get("cache_read", 0)
        + (_row_w5m(row) / 1_000_000.0) * rate_w5m
        + (_row_w1h(row) / 1_000_000.0) * rate_w1h
    )


def _span_hours(start_iso, end_iso):
    """Whole hours between two ISO-8601 UTC timestamps; None if unparseable."""
    def parse(s):
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    a, b = parse(start_iso), parse(end_iso)
    if a is None or b is None:
        return None
    return round((b - a).total_seconds() / 3600.0)


def aggregate_costs(agents, price_table):
    """Re-derive cost.json from every agent's raw jsonl over ALL retained rows.

    The headline `totals`/`per_agent` are CUMULATIVE over whatever Claude Code
    transcript history is still on disk (which spans multiple days), so the
    object is window-labelled (window_start/end/span_hours) rather than dated.
    `by_day` buckets each row's est_usd by UTC date for the per-period view a
    cost-control decision (e.g. a sonnet downshift) needs.
    """
    per_agent = {}
    totals = {
        "input": 0, "output": 0, "cache_read": 0,
        "cache_write_5m": 0, "cache_write_1h": 0, "est_usd": 0.0,
    }
    by_day = {}            # "YYYY-MM-DD" -> {"total_est_usd", "per_agent": {...}}
    window_start = None
    window_end = None

    for agent in agents:
        name = agent["name"]
        log_path = os.path.join(LOGS_DIR, name, "token-usage.jsonl")
        if not os.path.isfile(log_path):
            continue
        # Defensive dedup across the file in case a crash re-appended rows.
        seen = set()
        models = {}
        try:
            with open(log_path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except Exception:
                        continue
                    key = (row.get("session_id"), row.get("message_id"))
                    if key[1] and key in seen:
                        continue
                    seen.add(key)

                    ts = row.get("ts", "")
                    if ts:
                        if window_start is None or ts < window_start:
                            window_start = ts
                        if window_end is None or ts > window_end:
                            window_end = ts

                    bucket = model_bucket(row.get("model"))
                    m = models.setdefault(bucket, {
                        "input": 0, "output": 0, "cache_read": 0,
                        "cache_write_5m": 0, "cache_write_1h": 0, "est_usd": 0.0,
                    })
                    w5m = _row_w5m(row)
                    w1h = _row_w1h(row)
                    c = row_cost(row, price_table)

                    m["input"] += row.get("input_tokens", 0)
                    m["output"] += row.get("output_tokens", 0)
                    m["cache_read"] += row.get("cache_read_tokens", 0)
                    m["cache_write_5m"] += w5m
                    m["cache_write_1h"] += w1h
                    m["est_usd"] += c

                    totals["input"] += row.get("input_tokens", 0)
                    totals["output"] += row.get("output_tokens", 0)
                    totals["cache_read"] += row.get("cache_read_tokens", 0)
                    totals["cache_write_5m"] += w5m
                    totals["cache_write_1h"] += w1h
                    totals["est_usd"] += c

                    day = ts[:10]  # UTC date prefix of the ISO timestamp
                    if day:
                        d = by_day.setdefault(
                            day, {"total_est_usd": 0.0, "per_agent": {}})
                        d["total_est_usd"] += c
                        d["per_agent"][name] = d["per_agent"].get(name, 0.0) + c
        except OSError:
            continue

        if models:
            for m in models.values():
                m["est_usd"] = round(m["est_usd"], 4)
            per_agent[name] = models

    totals["est_usd"] = round(totals["est_usd"], 4)
    # Round by_day dollars and order newest-first.
    by_day_out = {}
    for day in sorted(by_day.keys(), reverse=True):
        d = by_day[day]
        by_day_out[day] = {
            "total_est_usd": round(d["total_est_usd"], 4),
            "per_agent": {a: round(v, 4) for a, v in sorted(
                d["per_agent"].items(), key=lambda kv: -kv[1])},
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_start": window_start,
        "window_end": window_end,
        "span_hours": _span_hours(window_start, window_end)
        if (window_start and window_end) else None,
        "scope": "cumulative over retained Claude Code transcripts",
        "price_table_effective_date": price_table.get("effective_date"),
        "totals": totals,
        "per_agent": per_agent,
        "by_day": by_day_out,
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main(argv):
    ensure_dir(ANALYTICS_DIR)
    # Seed the versioned price table if it doesn't exist yet.
    if not os.path.isfile(PRICE_TABLE_PATH):
        atomic_write_json(PRICE_TABLE_PATH, DEFAULT_PRICE_TABLE)
    price_table = load_json(PRICE_TABLE_PATH, DEFAULT_PRICE_TABLE)

    agents = list_agents()
    new_counts = {}
    for agent in agents:
        try:
            new_counts[agent["name"]] = rollup_agent(agent)
        except Exception as e:
            print(f"[token-cost-rollup] WARN agent {agent.get('name')}: {e}",
                  file=sys.stderr)

    cost = aggregate_costs(agents, price_table)
    atomic_write_json(COST_JSON_PATH, cost)

    total_new = sum(new_counts.values())
    print(f"[token-cost-rollup] agents={len(agents)} new_rows={total_new} "
          f"window={cost['window_start']}..{cost['window_end']} "
          f"({cost['span_hours']}h)")
    print(f"[token-cost-rollup] cumulative totals: in={cost['totals']['input']} "
          f"out={cost['totals']['output']} "
          f"cache_read={cost['totals']['cache_read']} "
          f"cache_write_5m={cost['totals']['cache_write_5m']} "
          f"cache_write_1h={cost['totals']['cache_write_1h']} "
          f"est_usd=${cost['totals']['est_usd']}")
    print(f"[token-cost-rollup] cost.json -> {COST_JSON_PATH} "
          f"({len(cost['by_day'])} days bucketed)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
