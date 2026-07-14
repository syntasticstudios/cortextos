// restart-ineffective-lib.mjs — OOP (.mjs) side of the SELF-HEAL-GUARD-02
// "restart-cannot-fix-this" classifier. INDEPENDENT re-implementation of the LOCKED
// algorithm in scripts/self-healing/tests/restart-ineffective-spec.md; validated
// byte-for-byte against scripts/self-healing/tests/restart-ineffective-golden.json
// (see restart-ineffective.test.mjs). The daemon-internal side (src/daemon/stale-watchdog.ts)
// implements the SAME contract independently — two impls + one golden vector = same verdict
// (no divergence) AND independent failure modes (true redundancy). This file is pure/
// dependency-free so the test can exercise it in isolation.
//
// Algorithm (v2, auth-mode-agnostic — grounded in the 2026-07-13 IR auth-loss loop):
//   T0      = max(epoch(heartbeat.last_heartbeat) || 0, epoch(now) - scanWindowMs)
//   streak  = "WATCHDOG: stale_restart" restarts with epoch(ts) > T0
//   reap    = GREEDY 1:1 pairing — each streak restart -> earliest unused type=crash with
//             ts > restart_ts; all restarts paired AND paired session-ids distinct
//   ineffective = streak >= N && reap
//   label (post-fire only) classifies the CURRENT-session stdout for the escalation message;
//         it NEVER gates the trigger (that would reintroduce the string-proxy fragility).

const TS_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;
const STALE_RE = /WATCHDOG: stale_restart/;
const TYPE_RE = /type=(\S+)/;
const SESSION_RE = /session=([0-9a-f-]+)/;

// Post-fire escalation LABEL patterns (classification only, never a trigger gate).
const NOT_LOGGED_IN = [/Not logged in/, /(Please )?run \/login/i, /· API Usage Billing/];
const RATE_LIMIT = [/\/rate-limit-options/, /rate limit/i];

/** Parse an ISO-8601 Z timestamp (with or without millis) to epoch ms; null if unparseable. */
export function epochMs(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms of the first ISO timestamp found in a log line; null if none/unparseable. */
export function firstTsMs(line) {
  const m = TS_RE.exec(line);
  return m ? epochMs(m[1]) : null;
}

function labelFor(stdout) {
  const s = stdout || '';
  if (NOT_LOGGED_IN.some((p) => p.test(s))) return 'not-logged-in';
  if (RATE_LIMIT.some((p) => p.test(s))) return 'rate-limit';
  return 'unknown-needs-eyes';
}

/**
 * Classify whether restarts are demonstrably ineffective for an agent.
 * @param {{now:string, heartbeat_json?:{last_heartbeat?:string}, restarts_log:string[],
 *          crashes_log:string[], stdout_current_session?:string}} c
 * @param {number} N fire threshold (default 3)
 * @param {number} scanWindowMs floor window for T0 (default 24h)
 * @returns {{ineffective:boolean, streak:number, newestSessionId:string|null, label:string}}
 */
export function classifyRestartIneffective(c, N, scanWindowMs) {
  const nowMs = epochMs(c.now);
  const hbMs = epochMs(c.heartbeat_json && c.heartbeat_json.last_heartbeat) || 0;
  // T0 = last heartbeat advance, floored to the scan window (findings 3 + 4).
  const T0 = Math.max(hbMs, nowMs - scanWindowMs);

  // streak = stale_restart entries with ts > T0 (epoch compare — finding 1), ascending.
  const streakTs = c.restarts_log
    .filter((l) => STALE_RE.test(l))
    .map(firstTsMs)
    .filter((t) => t !== null && t > T0)
    .sort((a, b) => a - b);
  const streak = streakTs.length;

  // respawn lines: type=crash ONLY (exclude daemon-stop/halted — finding 2), ascending by ts.
  const crashOnly = c.crashes_log
    .map((l) => {
      const tm = TYPE_RE.exec(l);
      const sm = SESSION_RE.exec(l);
      return { type: tm ? tm[1] : null, sid: sm ? sm[1] : null, t: firstTsMs(l) };
    })
    .filter((x) => x.type === 'crash' && x.sid && x.t !== null)
    .sort((a, b) => a.t - b.t);

  // reapWorking = GREEDY 1:1 pairing (finding 5b): each streak restart -> earliest unused
  // type=crash with ts > restart_ts. All restarts must pair AND paired sessions distinct.
  let j = 0;
  let paired = [];
  let pairedOk = true;
  for (const rTs of streakTs) {
    while (j < crashOnly.length && crashOnly[j].t <= rTs) j += 1;
    if (j >= crashOnly.length) { pairedOk = false; break; }
    paired.push(crashOnly[j].sid);
    j += 1;
  }
  const distinct = new Set(paired).size === paired.length;
  const reapWorking = streak > 0 && pairedOk && distinct && paired.length === streak;

  // newestSessionId: newest type=crash line only (finding 2 minor).
  const newestSessionId = crashOnly.length ? crashOnly[crashOnly.length - 1].sid : null;

  const ineffective = streak >= N && reapWorking;

  let label;
  if (streak >= N && !reapWorking) label = 'reap-failure-not-this-class';
  else if (!ineffective) label = 'n/a';
  else label = labelFor(c.stdout_current_session);

  return { ineffective, streak, newestSessionId, label };
}
