#!/bin/bash
# Regression test for SYS-AUTH-APIKEY-01: ANTHROPIC_API_KEY auth guard.
#
# When the org authenticates via ANTHROPIC_API_KEY (no OAuth/Keychain token),
# there is no subscription "remaining %" to read. The OAuth usage endpoint the
# watchdog depends on returns 0%, which false-trips a fleet-wide pause with no
# auto-resume (incident 2026-06-29 05:24 — method=api remaining=0% stopped all
# 10 agents, fleet hung). The guard must skip the ENTIRE watchdog before any
# quota read or pause/resume decision when ANTHROPIC_API_KEY is present.
#
# Criteria:
#   (1) ANTHROPIC_API_KEY in secrets.env -> SKIP, exit 0, NO check-usage-api call,
#       NO pause even when the (stubbed) usage reads 0%.
#   (2) QUOTA_WATCHDOG_FORCE=1 bypasses the guard (escape hatch preserved).
#   (3) No secrets.env / no key -> guard does NOT skip (coverage not lost; the
#       watchdog proceeds into its normal probe path).
#
# Usage: bash quota-watchdog-apikey-guard.test.sh <quota-watchdog.sh>
set -uo pipefail
WD="$1"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

make_stub() {  # $1=stub-dir — cortextos stub records every call so we can assert no quota read happened
  local sdir="$1"
  cat > "$sdir/cortextos" <<'STUB_EOF'
#!/bin/bash
echo "$*" >> "${STUB_CALLS:-/dev/null}"
case "$1 $2" in
  # Stub reads 0% so an UNGUARDED run would trip a pause — the guard must prevent reaching here.
  "bus check-usage-api") echo '{"five_hour_utilization":1.0,"seven_day_utilization":1.0}'; exit 0 ;;
  "bus list-agents")     echo '[{"name":"a1","running":true}]'; exit 0 ;;
  "bus send-telegram")   exit 0 ;;
  "bus log-event")       exit 0 ;;
esac
case "$1" in start|stop) exit 0 ;; esac
exit 0
STUB_EOF
  chmod +x "$sdir/cortextos"
  # security stub fails (no keychain) so an unguarded run would otherwise go probe-blind
  printf '#!/bin/bash\nexit 1\n' > "$sdir/security"; chmod +x "$sdir/security"
  ln -sf "$(command -v jq)" "$sdir/jq"
  ln -sf /bin/bash "$sdir/bash"
}

run_case() {  # $1=label  env passed by caller
  local label="$1"
  local root; root="$(mktemp -d)"
  local sdir="$root/stub"; mkdir -p "$sdir"
  make_stub "$sdir"
  local fw="$root/fw"; mkdir -p "$fw/orgs/phytomedic"
  [ -n "${WITH_KEY:-}" ] && printf 'ANTHROPIC_API_KEY=sk-ant-test123\n' > "$fw/orgs/phytomedic/secrets.env"
  local calls="$root/calls.log"; : > "$calls"
  env -i HOME="$root" PATH="$sdir:/usr/bin:/bin" \
    CTX_ROOT="$root/ctx" CTX_FRAMEWORK_ROOT="$fw" CTX_ORG=phytomedic \
    WATCHDOG_BUS_AGENT=tester WATCHDOG_CHAT_ID=0 \
    STUB_CALLS="$calls" ${EXTRA_ENV:-} \
    /bin/bash "$WD" >/dev/null 2>&1
  local code=$?
  LAST_CALLS="$(cat "$calls")"
  LAST_PAUSED="$([ -f "$root/ctx/state/quota-watchdog/paused.json" ] && echo yes || echo no)"
  LAST_LOG="$(cat "$root/ctx/state/quota-watchdog/watchdog.log" 2>/dev/null)"
  LAST_CODE=$code
  rm -rf "$root"
}

echo "SYS-AUTH-APIKEY-01 guard test"

# (1) key present -> skip cleanly, never read quota, never pause
WITH_KEY=1 run_case "key-present"
[ "$LAST_CODE" = "0" ] && ok "exits 0 with key present" || bad "exit code $LAST_CODE with key present"
echo "$LAST_CALLS" | grep -q "check-usage-api" && bad "called check-usage-api despite key (guard leaked)" || ok "no check-usage-api call with key present"
[ "$LAST_PAUSED" = "no" ] && ok "no pause with key present (no false-trip)" || bad "paused agents despite key present"
echo "$LAST_LOG" | grep -q "API-key auth" && ok "logged the API-key SKIP reason" || bad "missing SKIP log line"

# (2) FORCE bypass — guard skipped, watchdog proceeds. Supply a token so it
# clears the downstream PROBE-BLIND guard and actually reaches the quota read.
WITH_KEY=1 EXTRA_ENV="QUOTA_WATCHDOG_FORCE=1 CLAUDE_CODE_OAUTH_TOKEN=tok-test" run_case "force-bypass"
echo "$LAST_CALLS" | grep -q "check-usage-api" && ok "FORCE=1 bypasses guard (reaches quota read)" || bad "FORCE=1 did not bypass guard"

# (3) no key -> guard does NOT short-circuit (coverage preserved); proceeds into probe path
run_case "no-key"
echo "$LAST_LOG" | grep -q "API-key auth" && bad "skipped without a key present (coverage lost)" || ok "no key -> guard does not skip"

echo "  ---"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
