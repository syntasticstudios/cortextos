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
# EFFECTIVE CONFIG SoT = the MAIN-CHECKOUT config.json (dirname of git-common-dir), NOT the
# worktree copy. The daemon loads cron config from the main checkout + runtime crons.json; the
# worktree config.json is a SEPARATE on-disk file (not symlinked). A worktree-only config edit
# reads "clean" against the worktree but the daemon ignores it → the cron re-registers on restart.
# (Learned 2026-07-13, SA daily-integration-health false-clean cost 3 days.) This is the INVERSE of
# the crontab-.sh lane, where the CLI symlink routes EXECUTION into the worktree. So: config_crons()
# reads the MAIN checkout; we additionally read the worktree copy purely to flag divergence.
#
# Classifications per cron:
#   PASS          — all checks clean
#   FAIL          — a re-clone would break this cron (abs path / untracked / ignored / config-orphan)
#   PENDING-SYNC  — source (config.json) is durable+portable, but the LIVE crons.json copy still
#                   carries an abs path (expected transient while the framework-root worktree
#                   hasn't yet merged the relocate PR — NOT a durability break)
#   DIVERGENCE    — the worktree config.json and the effective MAIN-CHECKOUT config.json disagree on
#                   this cron's presence (worktree-only add/remove not synced to the copy the daemon
#                   loads). Non-failing WARN — surfaces the silent no-op that reads "clean" locally.
#   SELF-REMOVE-TARGET — the cron's self-remove/one-shot prompt instructs editing the WORKTREE
#                   config.json; since the daemon loads main-checkout, that strands a leftover that
#                   re-registers on restart. Non-failing WARN — fix before it strands.
#
# Exit: 0 if no FAIL, 1 if any FAIL. PENDING-SYNC / DIVERGENCE / SELF-REMOVE-TARGET do not fail.
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
    cfg = config_crons(agent, MAINROOT)   # EFFECTIVE SoT — the config the daemon actually loads
    wt  = config_crons(agent, FWROOT)     # worktree copy — read only to flag divergence
    reg = registered_crons(agent)
    for name in sorted(set(cfg) | set(reg) | set(wt)):
        cfg_c, reg_c = cfg.get(name), reg.get(name)
        in_main, in_wt, in_reg = name in cfg, name in wt, name in reg

        # TRUE config-orphan (hard FAIL): live in crons.json but in NEITHER config.json
        # (main or worktree) — no def anywhere, dropped by re-clone / migrate --force, undurable.
        if in_reg and not in_main and not in_wt:
            results.append((agent, name, "FAIL", "config-orphan: in crons.json but in NO config.json (main or worktree) — dropped by re-clone / migrate --force"))
            continue

        # worktree-vs-main divergence: someone edited one config.json but not the other.
        # Non-failing WARN — the silent no-op that reads "clean" locally while the daemon keeps
        # loading the un-edited main-checkout copy. This is NOT a hard FAIL: a worktree-only add
        # may be a legit cron pending merge to main; a main-only entry is still durably loaded.
        if in_main != in_wt:
            only = ("main-checkout only (worktree drop not synced → daemon still loads it from main; retire not complete)"
                    if in_main else
                    "worktree only (present in worktree config + maybe runtime, but NOT in effective main-checkout / origin config → re-clone would drop it; durablize or confirm pending-merge)")
            results.append((agent, name, "DIVERGENCE", f"config.json worktree/main disagree: {only}"))

        if not cfg_c:
            # no EFFECTIVE (main-checkout) source cron to durability-check — daemon's effective
            # config doesn't carry it. Already surfaced above (orphan or divergence). Skip checks.
            continue

        cfg_prompt = (cfg_c or {}).get("prompt", "")
        reg_prompt = (reg_c or {}).get("prompt", "")

        # SELF-REMOVE-TARGET (non-failing WARN): a self-remove/one-shot prompt that tells the agent
        # to edit the WORKTREE config.json is latently broken — the daemon loads main-checkout, so a
        # worktree-only self-remove strands a leftover that re-registers on restart. Catch it before
        # it strands. (Backstop for the class SA flagged from stripe-restart-drag-timer.)
        if SELFREMOVE_RE.search(cfg_prompt) and WORKTREE_CFG_RE.search(cfg_prompt):
            results.append((agent, name, "SELF-REMOVE-TARGET",
                            "self-remove prompt targets WORKTREE config.json — must target main-checkout config + remove-cron/cron-delete (runtime), else leftover re-registers on restart"))

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
selfrem   = [r for r in results if r[2] == "SELF-REMOVE-TARGET"]
# "scanned" = unique crons; a single cron can emit a DIVERGENCE/warn row plus a durability row
scanned   = len({(a, c) for a, c, _, _ in results})
passes    = [r for r in results if r[2] == "PASS"]

print("=== cron-durability-lint ===")
for a, c, s, d in results:
    if s == "PASS":
        continue
    print(f"  [{s}] {a}/{c}: {d}")
print(f"\n{scanned} crons scanned | {len(passes)} PASS | {len(pending)} PENDING-SYNC | {len(diverge)} DIVERGENCE | {len(selfrem)} SELF-REMOVE-TARGET | {len(fails)} FAIL")
if diverge:
    print("NOTE — DIVERGENCE rows are non-failing warnings: worktree/main config.json disagree; sync the copy the daemon loads (main-checkout) before assuming a cron add/removal took effect.")
if selfrem:
    print("NOTE — SELF-REMOVE-TARGET rows are non-failing warnings: fix the cron prompt to self-remove from main-checkout config + runtime, not the worktree config.")
if fails:
    print("DURABILITY FAIL — these crons would break on re-clone/re-provision.")
    sys.exit(1)
print("OK — no re-clone-durability failures.")
PYEOF
PYEOF_OUTER_GUARD=true
