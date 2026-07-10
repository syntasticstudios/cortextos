import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  WedgeWatchdog,
  wedgeWatchdogArmed,
  wedgeWatchdogArmSuppressed,
} from '../../../src/daemon/wedge-watchdog';
import type { AgentManager } from '../../../src/daemon/agent-manager.js';

// SYS-WEDGE-DUAL-REAPER Track-3 (PD SYS-MASK-01b DECISION 2, 2026-07-10).
// The in-process .ts reaper is LOCKED to shadow: the launchd `.mjs` is the canonical
// wedge reaper, and running two armed reapers on one fleet risks double-reap /
// conflicting logic (this .ts has NO B2 activity gate, so it would reap signatures the
// .mjs deliberately spares). These tests pin the lock at the CODE level — the arm
// capability cannot be restored by CTX_WEDGE_WATCHDOG_ARMED (env / settings drift), only
// by flipping the in-code constant + review + a Founder-gated restart. Even a direct
// doRestart() call hard-stops (defense-in-depth).

const ARMED_ENV = 'CTX_WEDGE_WATCHDOG_ARMED';

function writeHb(ctxRoot: string, agent: string, isoTs: string): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'heartbeat.json'),
    JSON.stringify({
      agent, org: 'testorg', display_name: agent, status: 'x', current_task: '',
      mode: 'test', last_heartbeat: isoTs, loop_interval: '4m',
    }),
    'utf-8',
  );
}

// A fully-passing triple-gate — these tests target the ARM LOCK, not gate computation,
// so the gate is stubbed rather than reproduced from fs/cron/ps state.
function fakeGate() {
  return {
    allPassed: true, gate1_cronFired: true, gate2_hbFrozen: true, gate3_ptyCpuIdle: true,
    details: { hbAgeMs: 3 * 60 * 60 * 1000, ptyCpuPct: 0.2, ptyPid: 4242, cronFiredAt: 'x' },
  };
}

describe('WedgeWatchdog lock-to-shadow (Track-3)', () => {
  let ctxRoot: string;
  let restartAgent: ReturnType<typeof vi.fn>;
  const savedEnv = process.env[ARMED_ENV];

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'wedge-lock-'));
    restartAgent = vi.fn(async () => {});
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[ARMED_ENV];
    else process.env[ARMED_ENV] = savedEnv;
  });

  it('wedgeWatchdogArmed() is false even when CTX_WEDGE_WATCHDOG_ARMED=1 (arm source severed)', () => {
    process.env[ARMED_ENV] = '1';
    expect(wedgeWatchdogArmed()).toBe(false);
  });

  it('wedgeWatchdogArmSuppressed() is true iff env requested arming (drives the start() log)', () => {
    process.env[ARMED_ENV] = '1';
    expect(wedgeWatchdogArmSuppressed()).toBe(true);
    delete process.env[ARMED_ENV];
    expect(wedgeWatchdogArmSuppressed()).toBe(false);
  });

  it('doRestart() hard-stops under the lock: no restartAgent, LOCKED_SHADOW logged (defense-in-depth)', async () => {
    process.env[ARMED_ENV] = '1';
    const mgr = { restartAgent, getAllStatuses: () => [] } as unknown as AgentManager;
    const wd = new WedgeWatchdog(mgr, ctxRoot);
    await (wd as unknown as { doRestart(n: string, g: unknown): Promise<void> })
      .doRestart('wedged', fakeGate());
    expect(restartAgent).not.toHaveBeenCalled();
    const log = readFileSync(join(ctxRoot, 'logs', 'wedged', 'wedge-watchdog.log'), 'utf-8');
    expect(log).toContain('SHADOW_LOCKED_SHADOW');
  });

  it('checkAll() with a full gate match + env armed does NOT restart (shadow-held, not armed)', async () => {
    process.env[ARMED_ENV] = '1';
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeHb(ctxRoot, 'wedged', oldIso); // stale target
    writeHb(ctxRoot, 'other', nowIso);  // a fresh OTHER agent -> credit-refutation rail passes
    const mgr = {
      restartAgent,
      getAllStatuses: () => [{ name: 'wedged', status: 'running' }],
    } as unknown as AgentManager;
    const wd = new WedgeWatchdog(mgr, ctxRoot);
    // Stub the gate to a full match — this test isolates the arm lock at checkAll()'s
    // final rail, not the fs/cron/ps triple-gate computation.
    (wd as unknown as { evaluateTripleGate(): unknown }).evaluateTripleGate = () => fakeGate();
    await wd.checkAll();
    expect(restartAgent).not.toHaveBeenCalled();
    const log = readFileSync(join(ctxRoot, 'logs', 'wedged', 'wedge-watchdog.log'), 'utf-8');
    expect(log).toContain('SHADOW_PERMITTED_HELD');
    expect(log).not.toContain('ARMED_RESTART');
  });
});
