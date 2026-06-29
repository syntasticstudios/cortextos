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
# Tick-type attribution
# --------------------------------------------------------------------------- #
# Each assistant turn is initiated by a preceding user-role entry. Cron fires
# inject "[CRON FIRED <iso>] <cron-name>: <prompt>" so the cron-name is the turn
# origin; non-cron turn-starts (founder/agent messages, /commands) = interactive.
# A downshift decision targets the tick TYPE, not the agent, because cost is
# ~88% caching / 12% generation and the cheap downshift wins are the high-freq,
# ~50-token mechanical ticks.
#
# THREE tiers (PD gate-review corrected, 3-way):
#   pure_mechanical — signature alone is sufficient; never reasons (~50-tok out).
#   conditional     — ~99% mechanical / ~1% DETECTS+acts; signature CANNOT tell a
#                     mechanical fire from a real-alert fire, so these stay opus
#                     for now. Per-turn `acted` tags which fires actually mutated
#                     /escalated, so a future cycle can downshift the 99% safely.
#   reasoning       — everything else, incl. interactive + any UNMAPPED cron-name
#                     (default reasoning — conservative).
PURE_MECHANICAL = {
    "heartbeat", "status-pulse", "cron-status", "cortextos-src-watch",
}
CONDITIONAL = {
    "cron-drift-watchdog", "vault-task-reconcile", "keychain-oauth-refresh",
    "human-task-pulse", "fleet-cascade-sync", "daily-vault-log",
}

CRON_RE = re.compile(r"\s*\[CRON FIRED[^\]]*\]\s*([A-Za-z0-9._-]+)\s*:")
# Mutating / escalating actions that mark a conditional fire as having ACTED.
MUTATING_RE = re.compile(
    r"\b(send-message|send-telegram|create-task|complete-task|update-task)\b"
    r"|git\s+commit")


def tick_class(origin):
    if origin in PURE_MECHANICAL:
        return "pure_mechanical"
    if origin in CONDITIONAL:
        return "conditional"
    return "reasoning"


def _user_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text")
    return ""


def turn_origin_from_user(obj):
    """For a user-role entry, return (is_turn_start, origin, turn_uuid).

    A user entry carrying a tool_result is a continuation of the SAME turn, not
    a new turn-start — return is_turn_start=False so the caller keeps the prior
    origin. A real turn-start parses its text: cron-name if it matches the
    CRON-FIRED marker, else "interactive".
    """
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return (False, None, None)
    content = msg.get("content")
    if isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_result"
            for b in content):
        return (False, None, None)  # tool_result continuation
    text = _user_text(content)
    m = CRON_RE.match(text) if text else None
    origin = m.group(1) if m else "interactive"
    return (True, origin, obj.get("uuid"))


def message_acted(obj):
    """True if this assistant message emits a mutating/escalating tool call."""
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return False
    content = msg.get("content")
    if not isinstance(content, list):
        return False
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        inp = b.get("input")
        cmd = ""
        if isinstance(inp, dict):
            cmd = str(inp.get("command", "")) or json.dumps(inp)
        elif inp is not None:
            cmd = str(inp)
        if MUTATING_RE.search(cmd):
            return True
    return False


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

    # Skip Claude Code synthetic/injected placeholder messages (model
    # "<synthetic>"): they carry an all-zero usage block, are not billed API
    # turns, and only dilute msg_count / avg_output_tokens.
    model = msg.get("model") or "unknown"
    if "synthetic" in model.lower():
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
            "model": model,
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


def tail_session(path, offset, last_msg_id, last_origin, last_turn_id):
    """Read complete new lines from `offset`; dedup by message.id.

    Threads turn state (tick origin + turn uuid) so each assistant row is
    attributed to the kind of turn that triggered it. The state is carried
    across runs (a turn that straddles the byte-offset boundary keeps its
    origin/turn_id from the prior run).

    Returns (new_rows, new_offset, new_last_msg_id, cur_origin, cur_turn_id).
    Only fully-terminated lines are consumed; a trailing partial line (live
    session mid-write) is left for the next run.
    """
    fail = ([], offset, last_msg_id, last_origin, last_turn_id)
    try:
        size = os.path.getsize(path)
    except OSError:
        return fail

    if offset > size:
        # File shrank/rotated (rare) — restart from 0.
        offset = 0

    rows = []
    seen = set()
    cur_last = last_msg_id
    cur_origin = last_origin or "interactive"
    cur_turn_id = last_turn_id

    try:
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read()
    except OSError:
        return fail

    # Consume only up to the last newline; keep trailing partial for next run.
    last_nl = data.rfind(b"\n")
    if last_nl == -1:
        return fail
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

        if obj.get("type") == "user":
            is_start, origin, tuid = turn_origin_from_user(obj)
            if is_start:
                cur_origin = origin
                cur_turn_id = tuid
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
        row = extracted["row"]
        row["tick_origin"] = cur_origin
        row["tick_class"] = tick_class(cur_origin)
        row["turn_id"] = cur_turn_id
        row["acted"] = message_acted(obj)
        rows.append(row)
        cur_last = mid

    return rows, new_offset, cur_last, cur_origin, cur_turn_id


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
        if not isinstance(meta, dict):
            meta = {}
        offset = meta.get("offset", 0)
        last_mid = meta.get("last_msg_id")
        last_origin = meta.get("last_tick_origin")
        last_turn = meta.get("last_turn_id")

        rows, new_offset, new_last, new_origin, new_turn = tail_session(
            sess_path, offset, last_mid, last_origin, last_turn)
        sessions[sess_file] = {
            "offset": new_offset,
            "last_msg_id": new_last,
            "last_tick_origin": new_origin,
            "last_turn_id": new_turn,
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

    def _new_class():
        return {
            "input": 0, "output": 0, "cache_read": 0,
            "cache_write_5m": 0, "cache_write_1h": 0,
            "est_usd": 0.0, "msg_count": 0,
        }
    by_tick_class = {
        "pure_mechanical": _new_class(),
        "conditional": _new_class(),
        "reasoning": _new_class(),
    }
    by_tick_origin = {}    # origin -> {"est_usd", "msg_count", "output"}
    # Conditional-tier acted attribution, keyed per TURN (session_id, turn_id):
    # a turn is "acted" if ANY of its assistant messages emitted a mutating call.
    cond_turn_acted = {}

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

                    # Tick-type attribution.
                    out_tok = row.get("output_tokens", 0)
                    origin = row.get("tick_origin") or "interactive"
                    tc = row.get("tick_class") or tick_class(origin)
                    cls = by_tick_class.setdefault(tc, _new_class())
                    cls["input"] += row.get("input_tokens", 0)
                    cls["output"] += out_tok
                    cls["cache_read"] += row.get("cache_read_tokens", 0)
                    cls["cache_write_5m"] += w5m
                    cls["cache_write_1h"] += w1h
                    cls["est_usd"] += c
                    cls["msg_count"] += 1

                    o = by_tick_origin.setdefault(
                        origin, {"est_usd": 0.0, "msg_count": 0, "output": 0})
                    o["est_usd"] += c
                    o["msg_count"] += 1
                    o["output"] += out_tok

                    if tc == "conditional":
                        tkey = (row.get("session_id"), row.get("turn_id"))
                        cond_turn_acted[tkey] = (
                            cond_turn_acted.get(tkey, False)
                            or bool(row.get("acted")))
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

    # Finalize by_tick_class: round dollars, add avg_output_tokens (output per
    # assistant message — a low avg confirms a tier is downshift-safe).
    for tc, cls in by_tick_class.items():
        mc = cls["msg_count"]
        cls["est_usd"] = round(cls["est_usd"], 4)
        cls["avg_output_tokens"] = round(cls["output"] / mc, 1) if mc else 0
    # Conditional acted sub-counts: turns that mutated/escalated (reasoning
    # fires) vs turns that only read/heartbeated (mechanical fires). This is the
    # outcome-tag that lets a future cycle downshift the mechanical 99% while
    # keeping the acting 1% on opus.
    by_tick_class["conditional"]["reasoning_fires"] = sum(
        1 for v in cond_turn_acted.values() if v)
    by_tick_class["conditional"]["mechanical_fires"] = sum(
        1 for v in cond_turn_acted.values() if not v)

    # by_tick_origin: add avg_output_tokens, round, order newest=highest $.
    by_tick_origin_out = {}
    for origin, o in sorted(by_tick_origin.items(),
                            key=lambda kv: -kv[1]["est_usd"]):
        mc = o["msg_count"]
        by_tick_origin_out[origin] = {
            "tick_class": tick_class(origin),
            "est_usd": round(o["est_usd"], 4),
            "msg_count": mc,
            "avg_output_tokens": round(o["output"] / mc, 1) if mc else 0,
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
        "by_tick_class": by_tick_class,
        "by_tick_origin": by_tick_origin_out,
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
    tot = cost["totals"]["est_usd"] or 1.0
    for tc in ("pure_mechanical", "conditional", "reasoning"):
        cls = cost["by_tick_class"].get(tc, {})
        extra = ""
        if tc == "conditional":
            extra = (f" [mechanical_fires={cls.get('mechanical_fires', 0)} "
                     f"reasoning_fires={cls.get('reasoning_fires', 0)}]")
        print(f"[token-cost-rollup]   {tc:15} "
              f"${cls.get('est_usd', 0):>9.2f} "
              f"({100 * cls.get('est_usd', 0) / tot:4.1f}% $) "
              f"msgs={cls.get('msg_count', 0):>6} "
              f"avg_out={cls.get('avg_output_tokens', 0)}{extra}")
    print(f"[token-cost-rollup] cost.json -> {COST_JSON_PATH} "
          f"({len(cost['by_day'])} days bucketed)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
