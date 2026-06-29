#!/usr/bin/env bash
# secret-leak-scan.sh — Fleet credential-leak tripwire (SYS-SECLEAK-01)
#
# WHY: bus send-message shell-evaluates message text (backticks / $(...) / $VAR
#   get EXECUTED), and a backtick-`env` once dumped the full environment incl
#   live API keys into a message payload that persisted in recipient processed/
#   stores + stdout.logs (2026-06-28). Type-scoped manual scrubs silently left
#   financial keys behind (a 2.5mo-old Stripe sk_live was missed). This is the
#   DETECTION leg (cleanup=manual, prevention=send-message wrapper task_1782687826424).
#
# WHAT: greps the WRONG-PLACE stores under $CTX_ROOT (logs/ processed/ inbox/
#   inflight/ orgs/*/tasks/ + message logs) for ALL fleet credential TYPES.
#   EXCLUDES the legit secret stores (*.env / secrets.env) — they SHOULD hold values.
#
# HARD SAFETY INVARIANT (load-bearing — do NOT regress):
#   The scan NEVER prints, echoes, or logs a secret VALUE. It reports ONLY
#   key-TYPE + file PATH + occurrence COUNT (grep -l / -c only; never -o, never a
#   bare grep that prints matching lines). A tripwire that prints values would BE
#   a new leak vector. It also never writes findings into a propagating store
#   (stdout summary + exit code only; the cron prompt does the PD/devops routing).
#
# EXIT: 0 = clean. 1 = LEAK FOUND (summary on stdout, NO values). 2 = probe-blind.
# stdlib/grep only. Durable-cron convention: $CTX_FRAMEWORK_ROOT-relative, git-tracked.

set -uo pipefail

ROOT="${CTX_ROOT:-$HOME/.cortextos/${CTX_INSTANCE_ID:-default}}"
if [ ! -d "$ROOT" ]; then
  echo "SECRET-LEAK-SCAN: probe-blind — CTX_ROOT not readable ($ROOT)"
  exit 2
fi

# WRONG-PLACE stores to scan (everything credential-bearing EXCEPT legit .env files).
SCAN_DIRS=()
for d in logs processed inbox inflight orgs tasks; do
  [ -e "$ROOT/$d" ] && SCAN_DIRS+=("$ROOT/$d")
done
if [ "${#SCAN_DIRS[@]}" -eq 0 ]; then
  echo "SECRET-LEAK-SCAN: probe-blind — no scannable stores under $ROOT"
  exit 2
fi

# Exclusions: legit secret stores + binaries + deps. (-I in grep skips binary files.)
EXCLUDES=(
  --exclude='*.env' --exclude='.env' --exclude='.env.*' --exclude='secrets.env'
  --exclude='*.env.*' --exclude='secret-leak-scan.sh'
  # dashboard sqlite db = test-mode keys only (low-sens), allowlisted per PD so it does not
  # false-alarm forever. (grep -I already skips binary, but exclude by name defensively.)
  --exclude='*.db' --exclude='cortextos-default.db' --exclude='dashboard.db'
  --exclude-dir='node_modules' --exclude-dir='.git'
)

# key-TYPE -> detection regex (ERE). Patterns match the FORMAT (prefix + min length),
# never require knowing a value. Order: highest-stakes first.
TYPES=(
  "STRIPE/CLERK_sk_live|sk_live_[A-Za-z0-9]{20,}"
  "STRIPE_sk_test|sk_test_[A-Za-z0-9]{20,}"
  "STRIPE_rk_live|rk_live_[A-Za-z0-9]{20,}"
  "ANTHROPIC|sk-ant-(api03|oat01)-[A-Za-z0-9_-]{24,}"
  "OPENAI|sk-(proj-)?[A-Za-z0-9]{40,}"
  "GOOGLE_AIza|AIza[A-Za-z0-9_-]{30,}"
  "TELEGRAM_BOT|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}"
  "GITHUB|gh[pousr]_[A-Za-z0-9]{36,}"
  "AWS_AKIA|AKIA[A-Z0-9]{16}"
)

FOUND=0
SUMMARY=""
for entry in "${TYPES[@]}"; do
  label="${entry%%|*}"
  pat="${entry#*|}"
  # -l = files-with-match (paths only). -I = skip binary. NO value ever emitted.
  files="$(grep -rIlE "${EXCLUDES[@]}" -- "$pat" "${SCAN_DIRS[@]}" 2>/dev/null)"
  [ -z "$files" ] && continue
  # Exclude redacted markers: a line that already reads *-REDACTED is not a live value,
  # but grep -l can't tell; so recount per file with a negative filter via grep -c on a
  # value-shaped match that excludes REDACTED. Still NO value printed (counts only).
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # -c = count of MATCHING LINES (never extracts/prints the value). The live-format
    # patterns can't match a *-REDACTED marker (too short / wrong shape), so a redacted
    # file scores 0 here with no extra filter — strictly value-safe (no -o anywhere).
    cnt="$(grep -cIE -- "$pat" "$f" 2>/dev/null || true)"
    [ "${cnt:-0}" -eq 0 ] && continue
    FOUND=$((FOUND + 1))
    SUMMARY+="  [${label}] ${cnt}x  ${f}"$'\n'
  done <<< "$files"
done

if [ "$FOUND" -eq 0 ]; then
  echo "SECRET-LEAK-SCAN: CLEAN — 0 live credential values in wrong-place stores under $ROOT (legit *.env excluded). $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi

echo "SECRET-LEAK-SCAN: LEAK FOUND — ${FOUND} file/type hit(s) in wrong-place stores (values NOT shown):"
printf '%s' "$SUMMARY"
echo "ACTION: route this summary (type+path+count, NO values) to platform-director + devops-monitor. Redact in-place by VAR-NAME (never write literal values in the redaction command). Then re-run to confirm 0."
exit 1
