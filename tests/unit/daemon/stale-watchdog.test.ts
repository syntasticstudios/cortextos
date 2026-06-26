import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StaleAgentWatchdog } from '../../../src/daemon/stale-watchdog';
import { staleWatchdogEnabled } from '../../../src/daemon/index';
import type { AgentManager } from '../../../src/daemon/agent-manager';

interface Spies {
  restartAgent: ReturnType<typeof vi.fn>;
  stopAgent: ReturnType<typeof vi.fn>;
}

function fakeAgentManager(statuses: Array<{ name: string; status: string }>, spies: Spies): AgentManager {
  return {
    getAllStatuses: () => statuses,
    restartAgent: spies.restartAgent,
    stopAgent: spies.stopAgent,
  } as unknown as AgentManager;
}

function seedHeartbeat(ctxRoot: string, agent: string, lastHeartbeat: string): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ agent, last_heartbeat: lastHeartbeat }), 'utf-8');
}

/** Seed an agent's stdout.log tail so getRateLimitInfo() can scan it. */
function seedAgentLog(ctxRoot: string, agent: string, contents: string): void {
  const dir = join(ctxRoot, 'logs', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.log'), contents, 'utf-8');
}

function seedAgentConfig(frameworkRoot: string, org: string, agent: string, config: object): void {
  const dir = join(frameworkRoot, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
}

/**
 * Seed an agent's cron-execution.log with `fired` entries so the idle-but-alive
 * guard (getLastCronFireMs) sees cron evidence. Path mirrors
 * cronExecutionLogPathFor: {ctxRoot}/.cortextOS/state/agents/{agent}/cron-execution.log
 */
function seedCronLog(ctxRoot: string, agent: string, firedAtIso: string[]): void {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const lines = firedAtIso
    .map(ts => JSON.stringify({ ts, cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 0, error: null }))
    .join('\n');
  writeFileSync(join(dir, 'cron-execution.log'), lines + '\n', 'utf-8');
}

const isoMinutesAgo = (m: number): string => new Date(Date.now() - m * 60 * 1000).toISOString();

const STALE = '2020-01-01T00:00:00.000Z'; // years old → stale under any threshold
const FRESH = new Date().toISOString();
// A cron fired well after the stale heartbeat and past the 10-min processing
// grace = the daemon sent work the agent never processed = genuine wedge.
const WEDGE_CRON = (): string[] => [isoMinutesAgo(20)];

describe('staleWatchdogEnabled (safety guard)', () => {
  const original = process.env.CTX_STALE_WATCHDOG;
  afterEach(() => {
    if (original === undefined) delete process.env.CTX_STALE_WATCHDOG;
    else process.env.CTX_STALE_WATCHDOG = original;
  });

  it('is OFF by default (unset)', () => {
    delete process.env.CTX_STALE_WATCHDOG;
    expect(staleWatchdogEnabled()).toBe(false);
  });

  it('arms only on the exact value "1"', () => {
    process.env.CTX_STALE_WATCHDOG = '1';
    expect(staleWatchdogEnabled()).toBe(true);
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.CTX_STALE_WATCHDOG = v;
      expect(staleWatchdogEnabled()).toBe(false);
    }
  });
});

describe('StaleAgentWatchdog lifecycle', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-')); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('start() is idempotent and unrefs the timer; stop() clears it', () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});

    const wd = new StaleAgentWatchdog(
      fakeAgentManager([], { restartAgent: vi.fn(), stopAgent: vi.fn() }),
      ctxRoot,
      ctxRoot,
    );

    wd.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    wd.start(); // second start must not install a second interval
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    wd.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
  });
});

describe('StaleAgentWatchdog.checkAndRestart behavior', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  let spies: Spies;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-fw-'));
    spies = { restartAgent: vi.fn(), stopAgent: vi.fn() };
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('restarts a running agent whose heartbeat is stale AND has an unprocessed cron (wedge)', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    seedCronLog(ctxRoot, 'a1', WEDGE_CRON()); // cron fired after hb, past grace
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).toHaveBeenCalledWith('a1');
  });

  it('does NOT restart an agent with a fresh heartbeat', async () => {
    seedHeartbeat(ctxRoot, 'a1', FRESH);
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });

  it('does NOT restart a non-running agent even if stale', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'stopped' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });

  it('respects per-agent stale_watchdog_enabled:false', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    seedAgentConfig(frameworkRoot, 'testorg', 'a1', { stale_watchdog_enabled: false });
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });
});

/**
 * EXP-DRIVER-02 — fail-safe-on-bad-signal contract for a control-plane detector.
 *
 * Generalizes the #52 quota-watchdog probe-blind test (C1/C2/C3) to the
 * stale-watchdog. The destructive action here is restartAgent/stopAgent. The
 * rule: on a MISSING, CORRUPT, or AMBIGUOUS signal the watchdog must do nothing
 * destructive (at most wait/alert) — never restart, and never halt. A restart
 * into an exhausted quota wall is the exact crash-loop the code warns against,
 * so a rate-limited agent with no parseable reset MUST be held, not restarted.
 *
 * C2-coverage (the "real trip still fires") path is the existing
 * "restarts a running agent whose heartbeat is stale" test above.
 */
describe('StaleAgentWatchdog fail-safe on bad/missing/ambiguous signal (EXP-DRIVER-02)', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  let spies: Spies;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-fs-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-fs-fw-'));
    spies = { restartAgent: vi.fn(), stopAgent: vi.fn() };
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  // C1-analog: no heartbeat file at all (agent may be booting, or signal lost).
  it('C1: missing heartbeat → no restart, no stop (signal absent ≠ frozen)', async () => {
    // Intentionally do NOT seed a heartbeat for a1.
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
    expect(spies.stopAgent).not.toHaveBeenCalled();
  });

  // C1-analog: heartbeat file exists but the timestamp is unparseable garbage.
  // isHeartbeatStale must not treat a NaN age as "stale" and trigger a restart.
  it('C1b: corrupt heartbeat timestamp → no restart (NaN age ≠ stale)', async () => {
    seedHeartbeat(ctxRoot, 'a1', 'not-a-real-timestamp');
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
    expect(spies.stopAgent).not.toHaveBeenCalled();
  });

  // C1-analog: heartbeat record present but the timestamp field is empty.
  it('C1c: empty heartbeat timestamp → no restart', async () => {
    seedHeartbeat(ctxRoot, 'a1', '');
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
    expect(spies.stopAgent).not.toHaveBeenCalled();
  });

  // C3-analog (the load-bearing one): stale AND rate-limited, but the reset time
  // cannot be parsed. Restarting now would slam an exhausted quota — the crash
  // loop the RATE_LIMIT_BLIND_WAIT_MS fallback exists to prevent. First tick must
  // hold (schedule the blind wait), NOT restart.
  it('C3: stale + rate-limited with no parseable reset → hold, do NOT restart', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    seedAgentLog(ctxRoot, 'a1', "Some output\nYou've hit your limit\nmore output\n");
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
    expect(spies.stopAgent).not.toHaveBeenCalled();
  });

  // C2-analog: stale with NO rate-limit signal in the log = genuine freeze.
  // Coverage must NOT be lost — the recoverable restart still fires.
  it('C2: stale + no rate-limit signal + unprocessed cron → restart still fires (coverage preserved)', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    seedAgentLog(ctxRoot, 'a1', 'normal heartbeat output\nworking on task\n');
    seedCronLog(ctxRoot, 'a1', WEDGE_CRON()); // wedge: cron fired but unprocessed
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).toHaveBeenCalledWith('a1');
  });
});

/**
 * SYS-STALE-WATCHDOG-IDLE-FP — idle-but-alive must NOT be restarted.
 *
 * A stale heartbeat with no UNPROCESSED cron means the agent simply hasn't been
 * given work since it last checked in (sparse crons refresh the heartbeat only
 * when they fire). The flat 15-min threshold conflated this with a wedge and
 * restarted healthy idle agents every cycle, climbing the crash counter toward
 * a false daily HALT. The guard requires an unprocessed cron (fired after the
 * heartbeat, past the processing grace) before treating staleness as a wedge.
 */
describe('StaleAgentWatchdog idle-but-alive guard (SYS-STALE-WATCHDOG-IDLE-FP)', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  let spies: Spies;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-idle-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-idle-fw-'));
    spies = { restartAgent: vi.fn(), stopAgent: vi.fn() };
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  // Stale heartbeat, but NO cron log at all → no work was sent → idle, not wedged.
  it('stale + no cron evidence → no restart (idle-but-alive)', async () => {
    seedHeartbeat(ctxRoot, 'a1', isoMinutesAgo(30));
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
    expect(spies.stopAgent).not.toHaveBeenCalled();
  });

  // Newest cron fired BEFORE the last heartbeat → the agent already pinged after
  // its last work → idle since then, not wedged.
  it('stale + newest cron older than heartbeat → no restart', async () => {
    seedHeartbeat(ctxRoot, 'a1', isoMinutesAgo(30));
    seedCronLog(ctxRoot, 'a1', [isoMinutesAgo(45)]); // cron predates the heartbeat
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });

  // Cron fired after the heartbeat but still within the processing grace → the
  // agent may still be booting/processing it → don't declare a wedge yet.
  it('stale + cron after heartbeat but within processing grace → no restart', async () => {
    seedHeartbeat(ctxRoot, 'a1', isoMinutesAgo(30));
    seedCronLog(ctxRoot, 'a1', [isoMinutesAgo(3)]); // < 10-min grace
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });

  // Cron fired after the heartbeat AND past the grace → unprocessed work → wedge.
  it('stale + unprocessed cron past grace → restart (genuine wedge)', async () => {
    seedHeartbeat(ctxRoot, 'a1', isoMinutesAgo(30));
    seedCronLog(ctxRoot, 'a1', [isoMinutesAgo(45), isoMinutesAgo(20)]); // newest is past grace
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).toHaveBeenCalledWith('a1');
  });
});
