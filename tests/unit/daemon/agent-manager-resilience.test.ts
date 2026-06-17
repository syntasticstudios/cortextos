import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// SYS-DAEMON-RESILIENCE-01 Part A — Fix 1 (assert-outcome boot, no swallow).
//
// Reproduces the partial-start failure mode: `startAgent` registers the agent
// (this.agents.set) and only AFTER an awaited `agentProcess.start()` wires the
// cron scheduler. If start() rejects, the agent is left registered with a live
// session but NO cron scheduler — and `Promise.allSettled` used to swallow the
// rejection. Fix 1 logs the rejection and asserts+recovers the missing scheduler.

// Names whose mocked AgentProcess.start() will reject (set per-test).
const FAIL_START = new Set<string>();

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    // expose config so AgentManager.startAgentCronScheduler can read process['config']
    config: Record<string, unknown>;
    constructor(name: string, _env: unknown, config: Record<string, unknown>) {
      this.name = name;
      this.config = config ?? {};
    }
    async start() {
      if (FAIL_START.has(this.name)) {
        throw new Error(`simulated start() failure for ${this.name}`);
      }
    }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'running' }; }
    onExit() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('SYS-DAEMON-RESILIENCE-01 Fix 1: assert-outcome boot (no swallow)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FAIL_START.clear();
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-resilience-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    for (const name of ['goodagent', 'failstart']) {
      const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true }));
    }
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('recovers a cron scheduler for an agent whose start() rejected (partial start)', async () => {
    FAIL_START.add('failstart');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    // Both agents are registered: failstart's this.agents.set runs BEFORE the
    // awaited start() that rejects, so it stays in the registry (partial start).
    const names = am.getAgentNames().sort();
    expect(names).toEqual(['failstart', 'goodagent']);

    // Fix 1 assert-outcome: BOTH agents end with a live cron scheduler, including
    // the one whose start() rejected (recovered via lazy-wire). Pre-fix, failstart
    // would have NO scheduler.
    expect(am.getCronScheduler('goodagent')).toBeDefined();
    expect(am.getCronScheduler('failstart')).toBeDefined();
  });

  it('does NOT swallow the rejection — it is logged', async () => {
    FAIL_START.add('failstart');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('startAgent REJECTED for "failstart"');
    expect(logged).toContain('BOOT-ASSERT');
  });

  it('healthy boot: all agents end with a scheduler and no assert-fail is logged', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    expect(am.getCronScheduler('goodagent')).toBeDefined();
    expect(am.getCronScheduler('failstart')).toBeDefined();
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('BOOT-ASSERT FAIL');
  });
});
