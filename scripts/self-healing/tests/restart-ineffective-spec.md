# restart-ineffective — LOCKED classifier spec (SELF-HEAL-GUARD-02)

The daemon-internal stale watchdog (`src/daemon/stale-watchdog.ts`, `.ts`) and the
out-of-process wedge-watchdog (`scripts/self-healing/wedge-watchdog.mjs`, `.mjs`)
each implement this classifier **independently** and both validate against the same
[golden vector](restart-ineffective-golden.json). Two independent implementations +
one executable contract = same verdict (no divergence) **and** independent failure
modes (true redundancy — a bug or stale build in one cannot blind both). This is
PD's "one awareness source" as an executable contract, not shared code.

## Why this exists
IR ran an 8-count hourly `WATCHDOG: stale_restart` loop 2026-07-13 (crash_count 1→8,
~2 from the 10-HALT), cleared only by a full daemon SIGTERM. Root cause: **auth-loss**
(session not-logged-in → no LLM calls → no heartbeat advance). The existing rate-limit
guard missed it on BOTH counts: it is (a) **string-based** (would not match "Not logged
in") and (b) **gated off for API-key orgs** via `isApiKeyAuth()` (phytomedic is api-key
auth). A **restart cannot fix** auth-loss / credit-hold / 429 — so the trigger must be
**structural and auth-mode-AGNOSTIC**: it fires on the demonstrable fact *"restart isn't
working,"* independent of cause.

## Inputs (all persisted artifacts both paths read identically)
- **restarts.log** — `[<ts>] WATCHDOG: stale_restart crash_count=<n>` lines (+ `HALTED:`).
  Timestamps here are **no-millis** (`[2026-07-13T00:40:46Z]`).
- **crashes.log** — `<ts> type=<crash|daemon-stop|…> reason=… session=<uuid> …`.
  Timestamps here **have millis** (`00:40:47.405Z`). Both `type=crash` AND
  `type=daemon-stop` lines carry `session=` — only `type=crash` are respawns.
- **heartbeat store** — `state/{agent}/heartbeat.json` = `{ "last_heartbeat": "<iso>" }`
  (single CURRENT value, millis; `src/bus/heartbeat.ts`). `last_heartbeat` IS the
  timestamp of the most recent successful heartbeat = "when hb last advanced".
- **N** = 3 (matches `MAX_RATE_LIMIT_RESTARTS_PER_DAY`); **scan_window** = 24h; **now**.

## Algorithm (LOCKED v2 — pins from real-log review; see the golden vector)
**All timestamp comparisons are epoch-ms.** Parse ISO to epoch (handles mixed
millis/no-millis); a raw string compare misorders `…16.993Z` vs `…16Z` (`.`<`Z`) and
silently under/over-counts the streak. *(golden case 6 fails a string-compare impl.)*

1. **T0** = `max( epoch(heartbeat.json.last_heartbeat) or 0 , epoch(now) − scan_window )`.
   `last_heartbeat` is literally "when hb last advanced" — no history needed. A healthy
   agent has a recent `last_heartbeat` ⇒ recent T0 ⇒ streak 0 ⇒ cannot false-fire. The
   scan-window floor bounds ancient restarts and the hb-missing case (T0 = now − window).
   *(hb-advance is the TIMESTAMP, never the status string — status is always "alive".)*
2. **streak** = count of `WATCHDOG: stale_restart` restarts.log entries with
   `epoch(ts) > T0`. (The `>T0` filter naturally excludes restarts before the last
   recovery, so a re-wedge after a recovery counts only its own restarts.)
3. **reapWorking** = the `type=crash` **only** respawn lines (exclude `type=daemon-stop`)
   with `epoch(ts) > T0` have **distinct** session-ids **and** their count `== streak`
   (paired 1:1 to the restarts, not filtered independently). Count `!= streak` or a
   repeated session ⇒ `reapWorking = false` (conservative). A persisting same-session-id
   is **reap-failure** — a different class, not this trigger.
   *(golden case 7 fails a count-all-`session=` impl.)*
4. **newestSessionId** = session of the newest `type=crash` line **only**.
5. **ineffective** = `(streak >= N) AND reapWorking`. (hbFrozen is implicit: N restarts
   after T0 with T0 still == current `last_heartbeat` ⇒ hb never advanced despite N restarts.)
6. On `ineffective`: exponential backoff + **do NOT increment crash_count** + **pause-
   until-clear** + **escalate**. Never restart-spam past this.
7. **clear/reset**: hb advances ⇒ `last_heartbeat` moves ⇒ T0 moves forward ⇒ streak
   drops to 0 next classify ⇒ normal restart policy resumes. This also makes a stale
   signature from a prior recovered episode unable to fire (recovery advanced hb).

## Escalation label (post-fire ONLY, current-session-bounded)
Once `ineffective` fires, scan the CURRENT session's stdout tail (after the most-recent
respawn boundary) to LABEL the cause for the escalation message — this NEVER gates the
trigger (that would reintroduce the string-proxy fragility):
- `not-logged-in` — `/Not logged in/`, `/(Please )?run \/login/i`, or the header
  `· API Usage Billing` (vs healthy `· Claude Max`). → `[HUMAN]` re-login task + page; **no restart**.
- `rate-limit` — existing `RATE_LIMIT_PATTERNS` (`/rate-limit-options`, `rate limit`, …).
- `credit-exhausted` — *unknown-until-sample* (no verbatim string captured yet).
- anything else / unrecognized → **still escalate** as `restart-ineffective, unknown cause,
  needs eyes`. Never go silent.

## Auth-mode-agnostic (critical)
The classifier MUST NOT be gated by `isApiKeyAuth()`. The structural signal is
independent of auth mode; gating it off for api-key orgs is exactly the hole that let IR
march to 8. (The old rate-limit *quota* logic may stay auth-gated; this new trigger does not.)
