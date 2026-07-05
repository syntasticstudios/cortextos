/**
 * tests/unit/bus/heartbeat-derive.test.ts
 *
 * Regression coverage for deriveHeartbeatIntervalMs (src/bus/heartbeat.ts).
 *
 * Bug (task_1782996240022): read-all-heartbeats hardcoded a fixed 2h STALE
 * threshold, so any agent whose heartbeat cron fires slower than 2h (4h
 * backend-architect / frontend-dev crons) was false-flagged STALE for ~2h of
 * every cycle. The fix derives a per-agent cadence from the agent's own
 * 'heartbeat' cron schedule. This test locks in that derivation for the
 * schedule shapes seen in the live fleet (shorthand, anchored every-N-hours,
 * and sub-hourly comma-list cron expressions), plus the graceful NaN fallback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeCrons } from '../../../src/bus/crons';
import type { CronDefinition } from '../../../src/types/index';
import { deriveHeartbeatIntervalMs } from '../../../src/bus/heartbeat';

const MIN = 60_000;
const HR = 3_600_000;

let tmpRoot: string;
let prevCtxRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hb-derive-'));
  prevCtxRoot = process.env.CTX_ROOT;
  process.env.CTX_ROOT = tmpRoot;
});

afterEach(() => {
  if (prevCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = prevCtxRoot;
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

function cron(name: string, schedule: string): CronDefinition {
  return {
    name,
    prompt: `run ${name}`,
    schedule,
    enabled: true,
    created_at: '2026-07-05T00:00:00.000Z',
  };
}

describe('deriveHeartbeatIntervalMs', () => {
  it('shorthand cadence: "4h" -> 4h (cannametrics-data)', () => {
    writeCrons('agent-a', [cron('heartbeat', '4h')]);
    expect(deriveHeartbeatIntervalMs('agent-a')).toBe(4 * HR);
  });

  it('anchored every-4-hours cron: "12 */4 * * *" -> 4h (backend-architect)', () => {
    writeCrons('agent-b', [cron('heartbeat', '12 */4 * * *')]);
    expect(deriveHeartbeatIntervalMs('agent-b')).toBe(4 * HR);
  });

  it('sub-hourly comma-list cron: "9,39 * * * *" -> 30m (integrations-routing)', () => {
    writeCrons('agent-c', [cron('heartbeat', '9,39 * * * *')]);
    expect(deriveHeartbeatIntervalMs('agent-c')).toBe(30 * MIN);
  });

  it('picks the "heartbeat" cron out of a multi-cron file', () => {
    writeCrons('agent-d', [
      cron('morning-briefing', '0 8 * * *'),
      cron('heartbeat', '38 * * * *'),
      cron('nightly', '0 2 * * *'),
    ]);
    expect(deriveHeartbeatIntervalMs('agent-d')).toBe(60 * MIN);
  });

  it('returns NaN when the agent has no crons file', () => {
    expect(Number.isNaN(deriveHeartbeatIntervalMs('nonexistent-agent'))).toBe(true);
  });

  it('returns NaN when there is no heartbeat cron', () => {
    writeCrons('agent-e', [cron('nightly', '0 2 * * *')]);
    expect(Number.isNaN(deriveHeartbeatIntervalMs('agent-e'))).toBe(true);
  });
});
