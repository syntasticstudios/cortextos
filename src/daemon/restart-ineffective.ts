/**
 * restart-ineffective.ts — daemon-internal (in-process) implementation of the LOCKED
 * SELF-HEAL-GUARD-02 classifier. This is ONE of two INDEPENDENT implementations of the
 * same contract (the other is scripts/self-healing/wedge-watchdog.mjs, out-of-process);
 * BOTH validate against scripts/self-healing/tests/restart-ineffective-golden.json — same
 * verdict (no divergence) + independent failure modes (true redundancy).
 *
 * The trigger is STRUCTURAL and auth-mode-AGNOSTIC: it fires on the demonstrable fact
 * "restart isn't working" — N consecutive watchdog restarts (each a fresh session = reap
 * worked) with the heartbeat still frozen — regardless of cause (not-logged-in / 429 /
 * credit-hold). A restart cannot fix any of those, so it must not burn the crash budget
 * to a silent HALT. See restart-ineffective-spec.md.
 */

/** A parsed heartbeat store (state/<agent>/heartbeat.json). */
export interface HeartbeatJson {
  last_heartbeat?: string;
}

export interface ClassifyInputs {
  /** Raw restarts.log lines (may include non-stale_restart entries; only WATCHDOG stale_restart count). */
  restartsLog: string[];
  /** Raw crashes.log lines (only type=crash respawns count for session-ids). */
  crashesLog: string[];
  /** The agent's current heartbeat store; last_heartbeat is the last-advance timestamp. */
  heartbeatJson: HeartbeatJson | null;
  /** Reference "now" (epoch ms) — the scan-window floor is now - scanWindowMs. */
  nowMs: number;
  /** Fire threshold (default 3, matches MAX_RATE_LIMIT_RESTARTS_PER_DAY). */
  n?: number;
  /** Scan window (default 24h). */
  scanWindowMs?: number;
}

export interface ClassifyResult {
  ineffective: boolean;
  streak: number;
  newestSessionId: string | null;
}

const TS_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;
const STALE_RE = /WATCHDOG: stale_restart/;
const TYPE_RE = /type=(\S+)/;
const SESSION_RE = /session=([0-9a-f-]+)/;

/** Parse an ISO-8601 Z timestamp (with or without millis) to epoch ms; null if unparseable. */
export function epochMs(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts); // Date.parse handles both millis and no-millis ISO-Z
  return Number.isNaN(t) ? null : t;
}

function firstTsMs(line: string): number | null {
  const m = TS_RE.exec(line);
  return m ? epochMs(m[1]) : null;
}

/**
 * Classify whether restarts are demonstrably NOT working for an agent (LOCKED spec v2):
 *  T0 = max(epoch(last_heartbeat) or 0, now - scanWindow)   [last_heartbeat = last hb advance]
 *  streak = WATCHDOG stale_restart entries with ts > T0
 *  reapWorking = GREEDY 1:1 pairing of streak restarts → earliest unused type=crash after each,
 *                all paired AND session-ids distinct  (type=crash only; excludes type=daemon-stop)
 *  ineffective = streak >= N AND reapWorking
 */
export function classifyRestartIneffective(inputs: ClassifyInputs): ClassifyResult {
  const n = inputs.n ?? 3;
  const scanWindowMs = inputs.scanWindowMs ?? 86_400_000;
  const hbMs = epochMs(inputs.heartbeatJson?.last_heartbeat) ?? 0;
  const t0 = Math.max(hbMs, inputs.nowMs - scanWindowMs);

  // streak: stale_restart entries with epoch(ts) > T0 (epoch compare — no string compare)
  const streakTs = inputs.restartsLog
    .filter((l) => STALE_RE.test(l))
    .map(firstTsMs)
    .filter((t): t is number => t !== null && t > t0)
    .sort((a, b) => a - b);
  const streak = streakTs.length;

  // type=crash respawns only (exclude type=daemon-stop/halted), sorted by ts
  const crashOnly = inputs.crashesLog
    .map((l): { sid: string; ts: number } | null => {
      const typ = TYPE_RE.exec(l);
      const sid = SESSION_RE.exec(l);
      const ts = firstTsMs(l);
      if (!typ || typ[1] !== 'crash' || !sid || ts === null) return null;
      return { sid: sid[1], ts };
    })
    .filter((x): x is { sid: string; ts: number } => x !== null)
    .sort((a, b) => a.ts - b.ts);

  // reapWorking: greedy 1:1 pairing — each streak restart → earliest unused crash after it.
  let j = 0;
  const paired: string[] = [];
  let pairingOk = true;
  for (const rTs of streakTs) {
    while (j < crashOnly.length && crashOnly[j].ts <= rTs) j++;
    if (j >= crashOnly.length) { pairingOk = false; break; }
    paired.push(crashOnly[j].sid);
    j++;
  }
  const reapWorking =
    streak > 0 && pairingOk && new Set(paired).size === paired.length && paired.length === streak;

  const newestSessionId = crashOnly.length ? crashOnly[crashOnly.length - 1].sid : null;
  const ineffective = streak >= n && reapWorking;

  return { ineffective, streak, newestSessionId };
}

/** Escalation-label classifiers (post-fire ONLY, current-session stdout — never gates the trigger). */
const NOT_LOGGED_IN = [/Not logged in/, /(Please )?run \/login/i, /· API Usage Billing/];
const RATE_LIMIT = [/\/rate-limit-options/, /rate limit/i];

export function labelCause(currentSessionStdout: string): 'not-logged-in' | 'rate-limit' | 'unknown-needs-eyes' {
  if (NOT_LOGGED_IN.some((r) => r.test(currentSessionStdout))) return 'not-logged-in';
  if (RATE_LIMIT.some((r) => r.test(currentSessionStdout))) return 'rate-limit';
  return 'unknown-needs-eyes';
}
