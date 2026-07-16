#!/usr/bin/env bash
# tool-trace-hook.sh — PostToolUse observability hook (OBSERV-01).
#
# Appends ONE content-free JSONL trace line per tool call to
#   $CTX_FRAMEWORK_ROOT/state/<agent>/tool-trace.jsonl
# to power agent-behavior-audit dimensions that the thin PTY stdout.log cannot show:
#   (a) token-waste-loop  — same (tool+sig) repeating within a session window
#   (d) skill-compliance  — was a Skill(<mandatory>) called before the first
#                            Edit/Write in a session (code-touch without skill)
# and wedge-forensics — the lead-up sequence of calls before an agent goes silent
# (the class of signal that would have made the 2026-07-13 integrations-routing
#  stale_restart loop tractable to root-cause).
#
# STRUCTURAL PII-SAFETY — captures tool NAME + a BOUNDED, content-free `sig` +
# timing ONLY. It NEVER captures tool arguments, file contents, prompt/message
# text, or task descriptions. Even a leaked trace file carries zero task/patient text.
#   • Bash  → argv[0] ONLY, plus subcommand token-2 ONLY IF argv[0] is on the
#             STRUCTURED-CLI ALLOWLIST (default-closed: echo/printf/curl/wget/ssh/
#             psql/mysql and any UNKNOWN command emit argv[0] alone, so token-2 —
#             which for content-first commands is a URL / inline SQL / literal
#             string — is structurally never recorded). Allowlist-not-denylist.
#             SECOND-LEVEL allowlist: `cortextos bus` alone exposes ONE further
#             token — the bus VERB (argv[2]: update-heartbeat/send-message/…), so
#             the sig discriminates idle bookkeeping from working calls. For
#             `cortextos bus <verb> …`, argv[2] is ALWAYS the safe CLI verb and
#             content is ALWAYS argv[3+] (message bodies, task titles, activity
#             text) which is NEVER captured — verb-token-only, default-closed
#             beyond it. Extends the content-free invariant; does not breach it.
#   • Read/Edit/Write/NotebookEdit → last-2 dir segments + extension (filename
#             dropped); paths under PII-adjacent trees (task store, patient/
#             clinical/anamnese/rezept) collapse to "<redacted>".
#   • Skill → skill name verbatim (this is what powers dim d).
#   • mcp__* / Task / others → tool name alone (already content-free).
#
# A hook must NEVER fail its tool call: all work is best-effort and the script
# ALWAYS exits 0. Fleet-wide capture (all agents); the audit parser
# (tool-trace-audit.py) consumes only the 6 specialists.
#
# Wired as a PostToolUse hook via settings.json (applied per the settings-drift
# doctrine — no daemon change, freeze-safe, no restart). See OBSERV-01.

set -uo pipefail

# Never let hook work escape as a failure to the tool call.
INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0   # jq absent → silent no-op

# --- parse payload in ONE jq pass (tool, session, cwd, outcome, primary raw input) ---
# Fields are joined with the ASCII Unit Separator (0x1F): a NON-whitespace delimiter,
# so `read` preserves EMPTY middle fields (a whitespace delimiter like tab collapses
# them, misaligning the fields when e.g. cwd is absent). Internal 0x1F/newlines/tabs
# in a field are squashed to a space so the record stays a single clean line.
SEP=$'\x1f'
PARSED=$(printf '%s' "$INPUT" | jq -r --arg sep "$SEP" '
  [ (.tool_name // "unknown"),
    ((.session_id // "") | tostring | .[0:8]),
    (.cwd // ""),
    (if (.tool_response.error // .tool_response.is_error // false) then "error" else "ok" end),
    ((.tool_input.command // .tool_input.file_path // .tool_input.notebook_path // .tool_input.skill // .tool_input.skill_name // "") | tostring | gsub("[\n\r\t]";" ") | .[0:1024])
  ] | join($sep)' 2>/dev/null) || exit 0

IFS=$'\x1f' read -r TOOL SESSION CWD OUTCOME RAW <<<"$PARSED"
[ -z "${TOOL:-}" ] && exit 0

# --- resolve agent name (env first, then cwd .../agents/<name>, then basename) ---
AGENT="${CTX_AGENT_NAME:-}"
[ -z "$AGENT" ] && AGENT=$(printf '%s' "$CWD" | sed -nE 's#.*/agents/([^/]+).*#\1#p')
[ -z "$AGENT" ] && AGENT=$(basename "${CWD:-unknown}" 2>/dev/null || echo unknown)
[ -z "$AGENT" ] && AGENT=unknown

# --- structured-CLI allowlist (default-closed): only these expose subcommand token-2 ---
is_structured_cli() {
  case "$1" in
    git|cortextos|npm|npx|pnpm|yarn|jq|gh|docker|kubectl|systemctl|launchctl|node|python|python3|pip|pip3|cargo|go|brew) return 0 ;;
    *) return 1 ;;
  esac
}

# --- redact a file path → last-2 dir segments + ".ext", or "<redacted>" for PII trees ---
redact_path() {
  local p="$1"
  # PII-adjacent trees: task store + any clinical/patient-adjacent segment.
  case "$p" in
    */tasks/*|*/.cortextos/*tasks*|*patient*|*Patient*|*clinical*|*klinik*|*anamnese*|*Anamnese*|*rezept*|*Rezept*|*prescription*)
      printf '<redacted>'; return ;;
  esac
  local dir ext base g2 g1
  dir=$(dirname "$p" 2>/dev/null); base=$(basename "$p" 2>/dev/null)
  case "$base" in *.*) ext=".${base##*.}" ;; *) ext="" ;; esac
  g1=$(basename "$dir" 2>/dev/null)
  g2=$(basename "$(dirname "$dir" 2>/dev/null)" 2>/dev/null)
  if [ -n "$g2" ] && [ "$g2" != "/" ] && [ "$g2" != "." ]; then
    printf '%s/%s/*%s' "$g2" "$g1" "$ext"
  elif [ -n "$g1" ] && [ "$g1" != "/" ] && [ "$g1" != "." ]; then
    printf '%s/*%s' "$g1" "$ext"
  else
    printf '*%s' "$ext"
  fi
}

# --- compute the bounded, content-free sig ---
SIG=""
case "$TOOL" in
  Bash)
    # argv[0] = first token that is NOT a VAR=value env-assignment prefix.
    cmd0=""
    for tok in $RAW; do
      case "$tok" in
        [A-Za-z_]*=*) continue ;;   # skip leading env assignments (VAR=val)
        *) cmd0="$tok"; break ;;
      esac
    done
    [ -z "$cmd0" ] && cmd0="sh"
    b=$(basename "$cmd0" 2>/dev/null || echo sh)
    if is_structured_cli "$b"; then
      # subcommand = the next token after argv[0] (skip env prefixes + argv[0] itself)
      sub=$(printf '%s' "$RAW" | awk '{for(i=1;i<=NF;i++){if($i ~ /^[A-Za-z_][A-Za-z0-9_]*=/)continue; if(!seen){seen=1;continue} print $i; exit}}' 2>/dev/null)
      case "$sub" in
        ""|-*) SIG="$b" ;;          # no subcommand or an option flag → argv[0] alone
        *)
          SIG="$b $sub"
          # SECOND-LEVEL allowlist (ONLY 'cortextos bus'): expose the bus VERB token
          # (argv[2]) so idle bookkeeping (update-heartbeat/check-inbox/update-cron-fire)
          # separates from working calls. argv[2] is ALWAYS the safe CLI verb; content
          # is ALWAYS argv[3+] and is NEVER read. Default-closed beyond the verb token.
          if [ "$b" = "cortextos" ] && [ "$sub" = "bus" ]; then
            verb=$(printf '%s' "$RAW" | awk '{c=0;for(i=1;i<=NF;i++){if($i ~ /^[A-Za-z_][A-Za-z0-9_]*=/)continue; c++; if(c==3){print $i; exit}}}' 2>/dev/null)
            case "$verb" in
              ""|-*) : ;;                  # no verb / option flag → keep 'cortextos bus'
              *) SIG="$b bus:$verb" ;;      # e.g. 'cortextos bus:update-heartbeat'
            esac
          fi
          ;;
      esac
    else
      SIG="$b"                        # default-closed: unknown/content-first cmd → argv[0] only
    fi
    ;;
  Read|Edit|Write|MultiEdit|NotebookEdit)
    [ -n "$RAW" ] && SIG=$(redact_path "$RAW") ;;
  Skill)
    SIG="$RAW" ;;                     # skill name (powers dim d)
  *)
    SIG="" ;;                         # mcp__*/Task/etc — tool name alone suffices
esac

# --- high-res ts (perl is universal on macOS/Linux; fall back to second precision) ---
TS=$(perl -MTime::HiRes -e 'my $t=Time::HiRes::time();my @g=gmtime($t);printf "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",$g[5]+1900,$g[4]+1,$g[3],$g[2],$g[1],$g[0],($t-int($t))*1000' 2>/dev/null) \
  || TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)

# --- build a guaranteed-valid JSON line (jq escapes sig safely) ---
LINE=$(jq -cn --arg ts "$TS" --arg agent "$AGENT" --arg session "$SESSION" \
  --arg tool "$TOOL" --arg sig "$SIG" --arg outcome "$OUTCOME" \
  '{ts:$ts,agent:$agent,session:$session,tool:$tool,sig:$sig,outcome:$outcome}' 2>/dev/null) || exit 0

# --- append + cheap size-guarded prune (rewrite only when > ~1.5MB → keep last 5000) ---
TRACE_DIR="${CTX_FRAMEWORK_ROOT:-.}/state/$AGENT"
mkdir -p "$TRACE_DIR" 2>/dev/null || exit 0
TRACE="$TRACE_DIR/tool-trace.jsonl"
printf '%s\n' "$LINE" >> "$TRACE" 2>/dev/null || exit 0

SZ=$(stat -f%z "$TRACE" 2>/dev/null || stat -c%s "$TRACE" 2>/dev/null || echo 0)
if [ "${SZ:-0}" -gt 1500000 ]; then
  tail -n 5000 "$TRACE" > "$TRACE.tmp" 2>/dev/null && mv "$TRACE.tmp" "$TRACE" 2>/dev/null
fi

exit 0
