// restart-ineffective-detector.mjs — LIVE adapter that reads an agent's real self-healing
// artifacts into the golden-vector case shape and runs the (independently-tested) classifier.
// Keeps wedge-watchdog.mjs's change tiny: it calls evaluateAgentRestartIneffective() per agent
// and owns only the escalation side-effect. The structural classifier itself is in
// restart-ineffective-lib.mjs and is validated against restart-ineffective-golden.json.
//
// Efficiency: the structural verdict (fire/no-fire) needs ONLY restarts.log + crashes.log +
// heartbeat.json (all small). The multi-MB stdout.log is read ONLY when a fire occurs, to
// LABEL the escalation (never to gate it) — matching the spec's "label = post-fire only".
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { classifyRestartIneffective } from './restart-ineffective-lib.mjs';

export const RESTART_INEFFECTIVE_N = 3;
export const RESTART_INEFFECTIVE_SCAN_WINDOW_MS = 86400000; // 24h — matches the golden vector

function readLines(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

// Read only the trailing ~maxBytes of a (possibly large) file, return the last `maxLines`.
function tailLines(path, maxBytes, maxLines) {
  try {
    if (!existsSync(path)) return '';
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf-8').split('\n');
      return lines.slice(-maxLines).join('\n');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Build the classifier case for an agent from its real artifacts (no stdout unless asked). */
export function readAgentCase(root, name, nowMs, { withStdout = false } = {}) {
  const logsDir = join(root, 'logs', name);
  let heartbeat = null;
  try {
    heartbeat = JSON.parse(readFileSync(join(root, 'state', name, 'heartbeat.json'), 'utf-8'));
  } catch {
    heartbeat = null;
  }
  return {
    now: new Date(nowMs).toISOString(),
    heartbeat_json: heartbeat && heartbeat.last_heartbeat ? { last_heartbeat: heartbeat.last_heartbeat } : {},
    restarts_log: readLines(join(logsDir, 'restarts.log')),
    crashes_log: readLines(join(logsDir, 'crashes.log')),
    stdout_current_session: withStdout ? tailLines(join(logsDir, 'stdout.log'), 64 * 1024, 400) : '',
  };
}

/**
 * Evaluate whether restarts are demonstrably ineffective for an agent, from live artifacts.
 * Cheap path (restarts/crashes/heartbeat only); reads stdout for the label ONLY on fire.
 * @returns {{ineffective:boolean, streak:number, newestSessionId:string|null, label:string}}
 */
export function evaluateAgentRestartIneffective(root, name, nowMs,
  N = RESTART_INEFFECTIVE_N, scanWindowMs = RESTART_INEFFECTIVE_SCAN_WINDOW_MS) {
  const base = readAgentCase(root, name, nowMs, { withStdout: false });
  const verdict = classifyRestartIneffective(base, N, scanWindowMs);
  if (!verdict.ineffective) return verdict; // no fire -> label is n/a, no stdout read needed
  // Fire: read the current-session stdout tail and re-classify to LABEL the escalation.
  const withStdout = readAgentCase(root, name, nowMs, { withStdout: true });
  return classifyRestartIneffective(withStdout, N, scanWindowMs);
}
