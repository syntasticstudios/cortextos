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

## Inputs (all three are persisted artifacts both paths can read identically)
- **restarts.log** — `[<ts>] WATCHDOG: stale_restart crash_count=<n>` lines (+ `HALTED:`).
- **crashes.log** — `<ts> type=crash ... session=<uuid> ...` (session-id per respawn).
- **heartbeat store** — the agent's heartbeat value/timestamp history (to decide advance).
- **N** — fire threshold (default **3**, matching existing `MAX_RATE_LIMIT_RESTARTS_PER_DAY`).

## Algorithm (locked)
1. **T0** = timestamp of the most recent heartbeat **ADVANCE** for the agent (hb value
   changed). If hb never advanced in the scan window, `T0 = window start`.
2. **streak** = count of `WATCHDOG: stale_restart` entries in restarts.log with `ts > T0`
   — i.e. watchdog restarts that did **not** result in recovery (no hb advance after).
3. **reapWorking** = the session-ids (crashes.log) across the streak's respawns are
   **distinct** (a NEW session each restart = reap succeeded). If the SAME session-id
   persists across "restarts", reap is failing — that is a **different** failure class
   (reap-failure), **not** this trigger.
4. **newestSessionId** = session-id of the most recent crashes.log respawn.
5. **ineffective** = `(streak >= N) AND reapWorking`.
6. On `ineffective`: exponential backoff + **do NOT increment crash_count** toward
   max_crashes + **pause-until-clear** + **escalate**. Never restart-spam past this.
7. **clear/reset**: when hb advances (recovery), `streak → 0`, normal restart policy
   resumes. (Structurally: the next classify sees `T0` move forward, so `streak` drops.)

The hb-advance boundary (step 1) is what makes step 3's "streak" self-resetting and makes
a **stale** signature from a prior recovered episode unable to fire — if the agent
recovered, hb advanced, so those old restarts fall before T0.

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
