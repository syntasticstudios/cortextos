#!/usr/bin/env bash
# cron-durability-lint.sh — re-clone-durability backstop for agent crons.
#
# Flags any cron whose helper script violates the durable-cron convention, so the
# one-time durability cleanup (PRs #87 devops-monitor / #90 systems-analyst) can't
# silently re-rot as agents add new crons over time.
#
# A cron is re-clone/re-provision-survivable only if ALL hold:
#   1. PATH    — script referenced as "$CTX_FRAMEWORK_ROOT/<rel>", not a worktree-absolute /Users/... path
#   2. TRACKED — the script is git-tracked in origin/main (git cat-file -e passes)
#   3. UNIGNORED — the script is not under a gitignored path (.gitignore 'orgs/*/agents/*' agent-dir zone)
#   4. IN-CONFIG — the cron def lives in config.json, not only in the live crons.json registry
#
# DURABILITY SoT = ORIGIN/MAIN committed config (the O axis). A re-clone / re-provision reads the
# COMMITTED origin/main config.json — NOT the local main-checkout working copy, which may be stale
# (behind origin/main) or dirty. Four config states per cron (learned 2026-07-13, cannametrics
# git-fetch-first flag after PR #123):
#   O = origin/main committed config      — what a re-clone / re-provision gets = the durability SoT
#   M = main-checkout WORKING COPY config — local checkout freshness only (may lag origin/main)
#   W = worktree / daemon-runtime config  — pending-merge (durable once merged to origin/main)
#   R = runtime crons.json                — what is actually scheduled right now
#
# DAEMON RELOAD MODEL (code-verified, cron-migration.ts + agent-manager.ts:489): config→crons.json
# migration is ONE-TIME, gated by a per-agent marker in ctxRoot state. A PLAIN restart SKIPS
# migration and reads the persistent crons.json (R) directly — it never re-reads config.json, so a
# stale/behind main-checkout (M) can NOT strand or drop a live cron on restart. config.json only
# drives crons.json on a MIGRATION EVENT (first-ever boot / `migrate-crons --force` / fresh
# re-provision), which does a wholesale REPLACE from the config read. Hence the durability charter =
# re-clone/re-provision (reads O), NOT restart; and M-staleness is COSMETIC except under --force.
# (INVERSE of the crontab-.sh lane, where the CLI symlink routes EXECUTION into the worktree.)
#
# Classifications per cron:
#   PASS          — all checks clean
#   FAIL          — a re-clone would break this cron (abs path / untracked / ignored / config-orphan
#                   = in R but in NEITHER O nor W)
#   PENDING-SYNC  — source config is durable+portable, but the LIVE crons.json copy still carries an
#                   abs path (expected transient while the worktree hasn't merged the relocate PR)
#   DIVERGENCE    — origin/main (O) and worktree (W) config disagree on this cron's presence
#                   (W-only = not yet committed → re-clone-now would drop it; O-only = worktree
#                   dropped it). Non-failing WARN — durability-relevant but usually pending-merge.
#   STALE-MAIN    — local main-checkout working copy (M) disagrees with origin/main (O): the local
#                   checkout is behind/ahead. Non-failing advisory — COSMETIC for a plain restart
#                   (daemon reads runtime crons.json), only matters under migrate --force / re-provision.
#   SELF-REMOVE-TARGET — the cron's self-remove/one-shot prompt instructs editing the WORKTREE
#                   config.json; a worktree-only self-remove strands a leftover on a migration event.
#                   Non-failing WARN — fix before it strands.
#
# Exit: 0 if no FAIL, 1 if any FAIL. PENDING-SYNC / DIVERGENCE / STALE-MAIN / SELF-REMOVE-TARGET do not fail.
#
# Run:  bash "$CTX_FRAMEWORK_ROOT/scripts/self-healing/cron-durability-lint.sh"
set -euo pipefail

FWROOT="${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT not set}"
CTXROOT="${CTX_ROOT:-$HOME/.cortextos/default}"

FWROOT="$FWROOT" CTXROOT="$CTXROOT" python3 - "$@" <<'PYEOF'
import json, os, re, subprocess, sys, glob

FWROOT = os.environ["FWROOT"]
CTXROOT = os.environ["CTXROOT"]
STATE = os.path.join(CTXROOT, ".cortextOS", "state", "agents")

def git(*a):
    return subprocess.run(["git", "-C", FWROOT, *a], capture_output=True, text=True)

def main_checkout_root():
    # The daemon loads cron config from the MAIN checkout, not this worktree.
    # Main worktree toplevel = dirname of the git common-dir (…/<mainroot>/.git).
    r = git("rev-parse", "--path-format=absolute", "--git-common-dir")
    common = r.stdout.strip()
    if r.returncode == 0 and common:
        # common-dir is normally <mainroot>/.git; its parent is the main checkout root
        cand = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        if os.path.isdir(os.path.join(cand, "orgs")):
            return cand
    # Fallback: first entry of `git worktree list` is the main worktree
    r2 = git("worktree", "list", "--porcelain")
    for line in r2.stdout.splitlines():
        if line.startswith("worktree "):
            return line[len("worktree "):].strip()
    return FWROOT  # last resort: behave as before

MAINROOT = main_checkout_root()

def git_at(root, *a):
    return subprocess.run(["git", "-C", root, *a], capture_output=True, text=True)

# Freshen origin/main so the O axis reflects the true remote, not a stale local ref. cannametrics
# 2026-07-13: the main-checkout hadn't pulled #123, so the LOCAL origin/main ref lagged and the lint
# false-flagged a durably-committed cron. Best-effort + non-fatal — a fetch failure (offline / CI /
# no network) just falls back to whatever local origin/main ref exists.
git("fetch", "--quiet", "origin", "main")

# How far the local main-checkout working copy (M) trails committed origin/main (O). Cosmetic for a
# plain restart (see header), surfaced so a lagging local checkout is visible, not mysterious.
def main_checkout_behind():
    head = git_at(MAINROOT, "rev-parse", "HEAD").stdout.strip()
    if not head:
        return None
    r = git("rev-list", "--count", f"{head}..origin/main")
    return r.stdout.strip() if r.returncode == 0 else None

MAIN_BEHIND = main_checkout_behind()

def tracked_main(rel):
    return git("cat-file", "-e", f"origin/main:{rel}").returncode == 0

def ignored(rel):
    return git("check-ignore", rel).returncode == 0

# Only EXECUTED scripts are in scope: a path is durability-relevant only if it is
# actually run (bash/sh/source/. /python3/node). Paths merely read with a graceful
# fallback (e.g. `cat .../state.json 2>/dev/null`) are per-machine runtime STATE,
# legitimately gitignored, and must NOT be flagged (false-positive guard — confirmed
# benign for improver/upstream-watch's upstream-notified.js dedup ledger).
EXEC = r'(?:bash|sh|source|\.|python3|node)\s+["\']?'
ABS_RE  = re.compile(EXEC + r'(/Users/[^\s"\']*?\.(?:sh|js|py))')
PORT_RE = re.compile(EXEC + r'\$(?:CTX_FRAMEWORK_ROOT|\{CTX_FRAMEWORK_ROOT\})/([^\s"\']*?\.(?:sh|js|py))')

# Self-remove/one-shot cron prompts that instruct editing the WORKTREE config.json are latently
# broken: the daemon loads the MAIN-CHECKOUT config, so a worktree-only self-remove strands a
# leftover that re-registers on restart (see SA/stripe-restart-drag-timer 2026-07-13). A correct
# self-remove targets remove-cron/cron-delete (runtime) + the MAIN-CHECKOUT config block.
SELFREMOVE_RE = re.compile(
    r'(self-remov|remove yourself|remove this cron|remove me from|self-disabl|delete this cron|one-?shot)',
    re.I)
WORKTREE_CFG_RE = re.compile(r'worktree[^\n.]{0,40}config\.json|config\.json[^\n.]{0,40}worktree', re.I)

def rel_of_abs(p):
    # worktree-absolute -> repo-relative (best effort)
    for marker in ("objective-mclaren/", "/cortextos/"):
        if marker in p:
            return p.split(marker)[-1]
    return p

def config_crons(agent, root):
    for cf in glob.glob(os.path.join(root, "orgs", "*", "agents", agent, "config.json")):
        try:
            return {c["name"]: c for c in json.load(open(cf)).get("crons", [])}
        except Exception:
            return {}
    return {}

def agent_config_rel(agent):
    # repo-relative path of the agent's config.json (same in any checkout); used to read the
    # COMMITTED origin/main copy via `git show`. Probe both checkouts in case the agent dir only
    # exists in one working tree.
    for root in (MAINROOT, FWROOT):
        for cf in glob.glob(os.path.join(root, "orgs", "*", "agents", agent, "config.json")):
            return os.path.relpath(cf, root)
    return None

def origin_config_crons(agent):
    # O axis — the COMMITTED origin/main config. A fresh re-clone / re-provision reads THIS (its
    # ctxRoot has no migration marker, so it migrates from origin/main config), NOT the local
    # working copy. This is the true re-clone durability SoT. Read via `git show`, not the on-disk
    # file, so a stale/dirty local checkout can't skew the verdict.
    rel = agent_config_rel(agent)
    if not rel:
        return {}
    r = git("show", f"origin/main:{rel}")
    if r.returncode != 0:
        return {}   # config.json not committed to origin/main at all
    try:
        return {c["name"]: c for c in (json.loads(r.stdout).get("crons", []) or [])}
    except Exception:
        return {}

def registered_crons(agent):
    cj = os.path.join(STATE, agent, "crons.json")
    if not os.path.exists(cj):
        return {}
    try:
        d = json.load(open(cj))
        crons = d if isinstance(d, list) else d.get("crons", [])
        return {c["name"]: c for c in crons if "name" in c}
    except Exception:
        return {}

agents = sorted(os.listdir(STATE)) if os.path.isdir(STATE) else []
results = []  # (agent, cron, status, detail)

for agent in agents:
    O   = origin_config_crons(agent)      # committed origin/main — the re-clone/re-provision SoT
    M   = config_crons(agent, MAINROOT)   # main-checkout working copy — local freshness only
    W   = config_crons(agent, FWROOT)     # worktree / daemon-runtime — pending-merge
    reg = registered_crons(agent)
    for name in sorted(set(O) | set(M) | set(W) | set(reg)):
        reg_c = reg.get(name)
        in_O, in_M, in_W, in_reg = name in O, name in M, name in W, name in reg

        # TRUE config-orphan (hard FAIL): live in crons.json but committed NOWHERE a re-provision
        # would read — not in origin/main (O) and not in the worktree/pending-merge config (W). A
        # re-clone / migrate --force would drop it. M (the local main-checkout working copy) does
        # NOT save it: a re-clone reads committed origin/main, not a dirty/stale local file.
        if in_reg and not in_O and not in_W:
            results.append((agent, name, "FAIL", "config-orphan: in crons.json but in NEITHER origin/main config (O) nor worktree config (W) — dropped by re-clone / migrate --force"))
            continue

        # O-vs-W divergence (durability-relevant, non-failing WARN): committed origin/main and the
        # worktree/pending-merge config disagree. NOT a hard FAIL — a worktree-only add is usually a
        # legit cron pending merge to main; an origin-only entry is still durably committed.
        if in_O != in_W:
            only = ("origin/main only (worktree config dropped it → if a COMPLETED retire, remove the entry from origin/main config too (commit the removal) so a re-provision doesn't re-create the retired cron; if unintended, the worktree branch is behind origin/main)"
                    if in_O else
                    "worktree only (in worktree config + maybe runtime, NOT yet committed to origin/main → a re-clone RIGHT NOW would drop it; durablize via merge to main or confirm pending-merge)")
            results.append((agent, name, "DIVERGENCE", f"origin/main (O) vs worktree (W) config disagree: {only}"))

        # STALE-MAIN (non-failing advisory): the local main-checkout working copy (M) disagrees with
        # committed origin/main (O). COSMETIC for a plain restart — migration is one-time/marker-gated
        # and a plain restart reads runtime crons.json, never re-reading config.json, so a
        # behind/ahead main-checkout can't strand or drop a live cron. Only bites under migrate
        # --force / fresh re-provision on the stale local checkout. Fix = git -C <main-checkout> pull.
        if in_O != in_M:
            note = ("main-checkout working copy BEHIND origin/main (lacks a cron O carries — e.g. hasn't pulled the durablizing merge)"
                    if in_O else
                    "main-checkout working copy AHEAD of / diverged from origin/main (carries a cron not yet committed to origin/main)")
            results.append((agent, name, "STALE-MAIN", f"local main-checkout vs origin/main disagree — {note}; cosmetic for plain restart (daemon reads runtime crons.json), only matters under migrate --force / re-provision"))

        # Durability source to lint = what a re-provision actually reads: prefer committed origin/main
        # (O), else the pending-merge worktree config (W). If neither carries it we already FAILed.
        src_c = O.get(name) or W.get(name)
        if not src_c:
            continue

        cfg_prompt = src_c.get("prompt", "")
        reg_prompt = (reg_c or {}).get("prompt", "")

        # SELF-REMOVE-TARGET (non-failing WARN): a self-remove/one-shot prompt that tells the agent
        # to edit the WORKTREE config.json is latently broken — a worktree-only self-remove strands a
        # leftover that re-appears on a migration event (first boot / --force / re-provision). Catch
        # it before it strands. (Backstop for the class SA flagged from stripe-restart-drag-timer.)
        if SELFREMOVE_RE.search(cfg_prompt) and WORKTREE_CFG_RE.search(cfg_prompt):
            results.append((agent, name, "SELF-REMOVE-TARGET",
                            "self-remove prompt targets WORKTREE config.json — must target main-checkout config + remove-cron/cron-delete (runtime), else leftover re-appears on a migration event"))

        # collect script refs from the config (source-of-truth) prompt
        cfg_abs  = set(ABS_RE.findall(cfg_prompt))
        cfg_port = set(PORT_RE.findall(cfg_prompt))

        fail = []
        # source abs-path antipattern
        for p in cfg_abs:
            rel = rel_of_abs(p)
            fail.append(f"config uses worktree-abs path ({rel}) instead of $CTX_FRAMEWORK_ROOT-relative")
        # portable refs must be tracked + unignored
        for rel in cfg_port:
            if not tracked_main(rel):
                fail.append(f"script not tracked in origin/main: {rel}")
            elif ignored(rel):
                fail.append(f"script under gitignored path: {rel}")

        if fail:
            results.append((agent, name, "FAIL", "; ".join(fail)))
            continue

        # source clean — is the LIVE copy lagging (abs path still present)?
        if cfg_port and ABS_RE.search(reg_prompt):
            results.append((agent, name, "PENDING-SYNC", "config portable+tracked; live crons.json still abs (awaiting worktree main-sync, no live gap)"))
        else:
            results.append((agent, name, "PASS", ""))

fails     = [r for r in results if r[2] == "FAIL"]
pending   = [r for r in results if r[2] == "PENDING-SYNC"]
diverge   = [r for r in results if r[2] == "DIVERGENCE"]
stalemain = [r for r in results if r[2] == "STALE-MAIN"]
selfrem   = [r for r in results if r[2] == "SELF-REMOVE-TARGET"]
# "scanned" = unique crons; a single cron can emit a DIVERGENCE/STALE-MAIN warn plus a durability row
scanned   = len({(a, c) for a, c, _, _ in results})
passes    = [r for r in results if r[2] == "PASS"]

print("=== cron-durability-lint ===")
if MAIN_BEHIND and MAIN_BEHIND != "0":
    print(f"  (context) local main-checkout is {MAIN_BEHIND} commit(s) behind origin/main — cosmetic for plain restart; `git -C <main-checkout> pull` to freshen.")
for a, c, s, d in results:
    if s == "PASS":
        continue
    print(f"  [{s}] {a}/{c}: {d}")
print(f"\n{scanned} crons scanned | {len(passes)} PASS | {len(pending)} PENDING-SYNC | {len(diverge)} DIVERGENCE | {len(stalemain)} STALE-MAIN | {len(selfrem)} SELF-REMOVE-TARGET | {len(fails)} FAIL")
if diverge:
    print("NOTE — DIVERGENCE rows are non-failing warnings: origin/main (O) and worktree (W) config disagree; merge to origin/main to durablize (or confirm pending-merge) before assuming a re-clone would carry the change.")
if stalemain:
    print("NOTE — STALE-MAIN rows are non-failing advisories: the local main-checkout working copy lags/leads origin/main; cosmetic for a plain restart (daemon reads runtime crons.json), only bites under migrate --force / re-provision. `git -C <main-checkout> pull`.")
if selfrem:
    print("NOTE — SELF-REMOVE-TARGET rows are non-failing warnings: fix the cron prompt to self-remove from main-checkout config + runtime, not the worktree config.")
if fails:
    print("DURABILITY FAIL — these crons would break on re-clone/re-provision.")
    sys.exit(1)
print("OK — no re-clone-durability failures.")
PYEOF
PYEOF_OUTER_GUARD=true
