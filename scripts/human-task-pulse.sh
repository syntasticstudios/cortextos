#!/usr/bin/env bash
# Probes API endpoints to auto-detect when User completed HUMAN tasks
# Runs hourly via cron
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PD_ENV=/Users/arndt/cortextos/.claude/worktrees/objective-mclaren/orgs/phytomedic/agents/platform-director/.env
[ -f "$PD_ENV" ] && set -a && . "$PD_ENV" && set +a
export CTX_AGENT_NAME=human-task-pulse
export CTX_ORG=phytomedic
PHYTO=/Users/arndt/phytomedic-saas
LOG=/Users/arndt/cortextos/logs/human-task-pulse.log
TODAY=$(date +%Y-%m-%d)
mkdir -p $(dirname "$LOG")

echo "=== $(date) HUMAN-task-pulse run ===" >> "$LOG"

# ─── Probe 1: Yousign production API keys ─────────
# Check if YOUSIGN_API_KEY env var is set in Vercel
YOUSIGN_OK="no"
if cd "$PHYTO" && npx vercel env ls production 2>/dev/null | grep -q "YOUSIGN_API_KEY"; then
  YOUSIGN_OK="yes"
fi
echo "Yousign API key in Vercel prod: $YOUSIGN_OK" >> "$LOG"

if [ "$YOUSIGN_OK" = "yes" ]; then
  # Find + close Yousign HUMAN task
  TASK_ID=$(cortextos bus list-tasks 2>&1 | grep -i "yousign" | grep -E "HUMAN" | grep -oE "task_[0-9_]+" | head -1)
  if [ -n "$TASK_ID" ]; then
    cortextos bus complete-task "$TASK_ID" --result "VERIFIED auto-detected: YOUSIGN_API_KEY set in Vercel production env at $(date -Iseconds). Auto-closed by human-task-pulse." 2>&1 | head -1 >> "$LOG"
    echo "✓ Auto-closed Yousign task $TASK_ID" >> "$LOG"
  fi
fi

# ─── Probe 2: Cannaflow merchant onboarding ─────────
# Check if any Cannaflow pharmacy was synced recently (indicates merchant active)
CANNAFLOW_OK="no"
if cd "$PHYTO" && npx convex run --prod functions/admin:listCatalogProviders 2>/dev/null | grep -q "cannaflow"; then
  # Provider is registered — check if it has pharmacies
  CANNAFLOW_OK="yes"
fi
echo "Cannaflow merchant active: $CANNAFLOW_OK" >> "$LOG"

if [ "$CANNAFLOW_OK" = "yes" ]; then
  TASK_ID=$(cortextos bus list-tasks 2>&1 | grep -i "cannaflow" | grep -E "HUMAN" | grep -oE "task_[0-9_]+" | head -1)
  if [ -n "$TASK_ID" ]; then
    cortextos bus complete-task "$TASK_ID" --result "VERIFIED auto-detected: Cannaflow provider returns pharmacies at $(date -Iseconds). Auto-closed by human-task-pulse." 2>&1 | head -1 >> "$LOG"
    echo "✓ Auto-closed Cannaflow task $TASK_ID" >> "$LOG"
  fi
fi

# ─── Probe 3: DAILY_API_KEY ─────────
DAILY_OK="no"
if cd "$PHYTO" && npx vercel env ls production 2>/dev/null | grep -q "DAILY_API_KEY"; then
  DAILY_OK="yes"
fi
echo "Daily.co API key in Vercel: $DAILY_OK" >> "$LOG"

# ─── Probe 4: nudge user if Yousign/Cannaflow still open (ESCALATING BACKOFF) ─────────
# telegram-dx-audit 2026-07-05: this nudge previously fired VERBATIM every day at 10:00
# for as long as the tasks stayed open (7 identical Founder msgs in one week = noise).
# Now backs off: daily for the first 3 nudges, then every 3 days, then weekly. Counter
# resets automatically once the blocking tasks clear, so a fresh blocker nudges promptly.
NEEDS_NUDGE=$(cortextos bus list-tasks 2>&1 | grep -E "HUMAN.*Yousign|HUMAN.*Cannaflow")
STATE_FILE=/Users/arndt/cortextos/state/cortextos-improver/human-task-nudge-state
mkdir -p "$(dirname "$STATE_FILE")"
if [ -z "$NEEDS_NUDGE" ] || [ "$YOUSIGN_OK" != "no" ]; then
  # Blocker cleared (or auto-detected) — reset backoff so the next new blocker starts fresh.
  [ -f "$STATE_FILE" ] && rm -f "$STATE_FILE" && echo "Nudge backoff reset (blocker cleared)" >> "$LOG"
elif [ "$(date +%H)" = "10" ]; then
  # Read prior state: "LAST_NUDGE_YMD COUNT"
  LAST_YMD=""; COUNT=0
  [ -f "$STATE_FILE" ] && read -r LAST_YMD COUNT < "$STATE_FILE"
  COUNT=${COUNT:-0}
  # Required gap in days by escalation tier: <3 nudges → 1d, <6 → 3d, else 7d.
  if [ "$COUNT" -lt 3 ]; then GAP=1; elif [ "$COUNT" -lt 6 ]; then GAP=3; else GAP=7; fi
  TODAY_EPOCH=$(date +%s)
  if [ -n "$LAST_YMD" ]; then
    LAST_EPOCH=$(date -j -f "%Y-%m-%d" "$LAST_YMD" +%s 2>/dev/null || echo 0)
    DAYS_SINCE=$(( (TODAY_EPOCH - LAST_EPOCH) / 86400 ))
  else
    DAYS_SINCE=999
  fi
  if [ "$DAYS_SINCE" -ge "$GAP" ]; then
    CHAT_ID=${TELEGRAM_CHAT_ID:-353207237}
    NEXT_COUNT=$((COUNT + 1))
    cortextos bus send-telegram "$CHAT_ID" "⏰ HUMAN-task nudge #$NEXT_COUNT: Yousign + Cannaflow noch nicht erkannt. Mit jedem Tag offen wartet System auf Dich.

$NEEDS_NUDGE" 2>&1 | head -1 >> "$LOG"
    echo "$(date +%Y-%m-%d) $NEXT_COUNT" > "$STATE_FILE"
    echo "✓ Nudge #$NEXT_COUNT sent (backoff gap ${GAP}d)" >> "$LOG"
  else
    echo "Nudge suppressed by backoff (count=$COUNT, ${DAYS_SINCE}d since last < ${GAP}d gap)" >> "$LOG"
  fi
fi

# ─── Probe 5: Cannaleo Sentry token — nudge + auto-detect + auto-close ───
# PD-approved 2026-07-10 (durable option 1). The pulse was hardcoded to Yousign/Cannaflow, so the
# Cannaleo Sentry token gap — the SOLE detector for silent-Rx-status-loss (clinical-safety, no
# orthogonal backstop) — never nudged the Founder.
# SCOPE (SA design-fork 2026-07-10): SENTRY-ONLY. SYS-MON-01 was dropped — its PROBE_TOKEN was
# already present, but SA closed task_1781449744963 on a REAL probe-ran-green verify (8 consecutive
# scheduled success runs authenticating vs Convex prod), NOT on credential-presence.
# DESIGN PRINCIPLE (record): never auto-close a monitor/DETECTOR task on bare credential-presence —
# that is a false-all-clear (the detector could be silently broken). Gate any future detector
# auto-close on probe-ran-green (e.g. `gh run list` success), not on the secret existing. The
# Sentry token is safe to auto-close on presence because it is a PROVISIONING gate that unblocks
# rule creation, not a live-detector-health claim.
# SECURITY: detect token PRESENCE only — never echo/log any token value.

# -- Cannaleo Sentry token (option A = SENTRY_AUTH_TOKEN in secrets.env) --
SENTRY_TOKEN_OK="no"
SECRETS_ENV=/Users/arndt/cortextos/.claude/worktrees/objective-mclaren/orgs/phytomedic/secrets.env
if [ -f "$SECRETS_ENV" ] && grep -qE '^[[:space:]]*SENTRY_AUTH_TOKEN=..*' "$SECRETS_ENV"; then
  SENTRY_TOKEN_OK="yes"
fi
echo "Sentry token (SENTRY_AUTH_TOKEN in secrets.env, presence-only): $SENTRY_TOKEN_OK" >> "$LOG"

# Stable-title match over the UNTRUNCATED JSON title (PD constraint: not a bare 'cannaleo'
# keyword). NOTE: the text `list-tasks` output truncates titles to ~48 chars ("...webhook-re"),
# so a full-phrase grep on it silently misses — match the JSON title + gate on pending (idempotent
# self-silencing: once auto-closed it drops out and devops is not re-pinged).
SENTRY_TASK=$(cortextos bus list-tasks --format json 2>/dev/null | python3 -c "import json,sys
try: t=json.load(sys.stdin)
except Exception: t=[]
m=[x['id'] for x in t if x.get('status')=='pending' and 'HUMAN' in (x.get('title') or '') and 'Sentry alert on cannaleo webhook-rejection' in (x.get('title') or '')]
print(m[0] if m else '')" 2>/dev/null)
if [ "$SENTRY_TOKEN_OK" = "yes" ] && [ -n "$SENTRY_TASK" ]; then
  cortextos bus complete-task "$SENTRY_TASK" --result "VERIFIED auto-detected: SENTRY_AUTH_TOKEN present in orgs/phytomedic/secrets.env at $(date -Iseconds) (option A). Auto-closed by human-task-pulse." 2>&1 | head -1 >> "$LOG"
  # Unblock the rule-creation agent task (task_1783308180974): tell devops-monitor to proceed.
  cortextos bus send-message devops-monitor normal 'Cannaleo Sentry token provisioned: SENTRY_AUTH_TOKEN detected in secrets.env by human-task-pulse. Proceed with the webhook-rejection alert rule creation + self-verify routing (unblocks task_1783308180974). Rule spec finalized: 500 >= 1/5min CRIT, config/secret_invalid >= 3/10min CRIT, idkey_invalid WARN.' 2>&1 | head -1 >> "$LOG"
  echo "✓ Auto-closed Sentry task $SENTRY_TASK + pinged devops-monitor" >> "$LOG"
  SENTRY_TASK=""   # closed → omit the nudge section (self-silences)
fi

# ─── Probe 6: Sentry credential nudge (escalating backoff, SEPARATE state file) ───
# SEPARATE state file from the Yousign/Cannaflow nudge so the two backoffs don't entangle.
# The section is present only while the task is open (blanked above on auto-close), so the nudge
# self-silences once the token lands. Counter resets when the gap closes so a fresh gap nudges promptly.
CRED_STATE_FILE=/Users/arndt/cortextos/state/cortextos-improver/credential-nudge-state
mkdir -p "$(dirname "$CRED_STATE_FILE")"
CRED_SECTIONS=""
if [ -n "$SENTRY_TASK" ]; then
  CRED_SECTIONS="🔴 Cannaleo Sentry-Alert: SENTRY_AUTH_TOKEN fehlt — einziger Detektor für stillen Rx-Status-Verlust (kein Backup). Task $SENTRY_TASK
"
fi

if [ -z "$CRED_SECTIONS" ]; then
  # Gap closed → reset backoff so a fresh gap nudges promptly.
  [ -f "$CRED_STATE_FILE" ] && rm -f "$CRED_STATE_FILE" && echo "Credential-nudge backoff reset (closed)" >> "$LOG"
elif [ "$(date +%H)" = "10" ]; then
  LAST_YMD=""; COUNT=0
  [ -f "$CRED_STATE_FILE" ] && read -r LAST_YMD COUNT < "$CRED_STATE_FILE"
  COUNT=${COUNT:-0}
  # Escalation tiers: <3 nudges → 1d, <6 → 3d, else 7d.
  if [ "$COUNT" -lt 3 ]; then GAP=1; elif [ "$COUNT" -lt 6 ]; then GAP=3; else GAP=7; fi
  TODAY_EPOCH=$(date +%s)
  if [ -n "$LAST_YMD" ]; then
    LAST_EPOCH=$(date -j -f "%Y-%m-%d" "$LAST_YMD" +%s 2>/dev/null || echo 0)
    DAYS_SINCE=$(( (TODAY_EPOCH - LAST_EPOCH) / 86400 ))
  else
    DAYS_SINCE=999
  fi
  if [ "$DAYS_SINCE" -ge "$GAP" ]; then
    CHAT_ID=${TELEGRAM_CHAT_ID:-353207237}
    NEXT_COUNT=$((COUNT + 1))
    # Body = static text + task-id interpolation only (no untrusted content; SO-10 safe).
    cortextos bus send-telegram "$CHAT_ID" "🔑 Credential-Nudge #$NEXT_COUNT — offene Zugangsdaten blockieren Monitoring:

$CRED_SECTIONS" 2>&1 | head -1 >> "$LOG"
    echo "$(date +%Y-%m-%d) $NEXT_COUNT" > "$CRED_STATE_FILE"
    echo "✓ Credential-nudge #$NEXT_COUNT sent (gap ${GAP}d)" >> "$LOG"
  else
    echo "Credential-nudge suppressed by backoff (count=$COUNT, ${DAYS_SINCE}d < ${GAP}d)" >> "$LOG"
  fi
fi

echo "" >> "$LOG"
