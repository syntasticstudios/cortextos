import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyRestartIneffective,
  labelCause,
  type ClassifyInputs,
} from '../src/daemon/restart-ineffective.js';

/**
 * The daemon-internal (.ts) half of the SELF-HEAL-GUARD-02 anti-divergence guarantee:
 * this loads the SAME shared golden vector that the OOP wedge-watchdog (.mjs) test loads
 * (scripts/self-healing/tests/restart-ineffective-golden.json) and the reference oracle
 * (restart-ineffective-refcheck.py) validates. Two independent implementations, one
 * executable contract — same verdict, independent failure modes.
 */

interface GoldenCase {
  name: string;
  now: string;
  heartbeat_json: { last_heartbeat?: string } | null;
  restarts_log: string[];
  crashes_log: string[];
  stdout_current_session: string;
  expected: { ineffective: boolean; streak: number; newestSessionId: string | null; label: string };
}
interface Golden { N: number; scan_window_ms: number; cases: GoldenCase[] }

const golden: Golden = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'scripts', 'self-healing', 'tests', 'restart-ineffective-golden.json'),
    'utf-8',
  ),
);

// Mirror the spec's label rule (post-fire only; reap-failure & no-fire never reach labelCause).
function labelFor(c: GoldenCase, r: { ineffective: boolean; streak: number }): string {
  if (r.streak >= golden.N && !r.ineffective) return 'reap-failure-not-this-class';
  if (!r.ineffective) return 'n/a';
  return labelCause(c.stdout_current_session);
}

describe('classifyRestartIneffective — shared golden vector', () => {
  it('matches every golden case (same verdicts as the .mjs + refcheck oracle)', () => {
    for (const c of golden.cases) {
      const inputs: ClassifyInputs = {
        restartsLog: c.restarts_log,
        crashesLog: c.crashes_log,
        heartbeatJson: c.heartbeat_json,
        nowMs: Date.parse(c.now),
        n: golden.N,
        scanWindowMs: golden.scan_window_ms,
      };
      const r = classifyRestartIneffective(inputs);
      const got = {
        ineffective: r.ineffective,
        streak: r.streak,
        newestSessionId: r.newestSessionId,
        label: labelFor(c, r),
      };
      expect(got, `case ${c.name}`).toEqual(c.expected);
    }
  });

  it('covers all 11 locked cases', () => {
    expect(golden.cases.length).toBe(11);
  });
});
