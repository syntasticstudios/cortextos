/**
 * tests/unit/daemon/shell-cron-dispatch.test.ts — COST-LEVER-B3 Tier-S.
 *
 * Covers:
 *  - fireShellCron: exit 0 => no alert; non-zero exit => 1 PD alert;
 *    timeout => 1 PD alert; missing command => alert + return; sanitization.
 *  - Dispatcher branch: execMode='shell' routes to fireShellCron; 'pty'/absent
 *    routes to PTY injection; 'headless' logs a fallback warning then PTY.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition, CtxEnv, AgentConfig } from '../../../src/types/index.js';

// --- Mocks (must be declared before importing the SUT) ---------------------

// Bus message primitive — spy on it to count PD alerts.
const sendMessageMock = vi.fn();
vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

// child_process.spawn — return a controllable fake child.
const spawnMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    // execFileSync is used elsewhere in agent-manager; keep the real one.
    execFileSync: actual.execFileSync,
  };
});

// Capture the real onFire closure that startAgentCronScheduler hands to the
// CronScheduler, so the dispatcher branch is exercised as-shipped (not a copy).
let capturedOnFire: ((c: CronDefinition) => Promise<void>) | null = null;
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    constructor(opts: { onFire: (c: CronDefinition) => Promise<void> }) {
      capturedOnFire = opts.onFire;
    }
    start() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

// --- Fake child factory -----------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// --- Test wiring ------------------------------------------------------------

let root: string;
let agentDir: string;

function makeAgentEnv(): CtxEnv {
  return {
    instanceId: 'default',
    ctxRoot: join(root, 'ctx'),
    frameworkRoot: root,
    agentName: 'alice',
    agentDir,
    org: 'acme',
    projectRoot: root,
  };
}

/** Register a fake agent entry so fireShellCron can resolve env/config. */
function wireAgent(mgr: InstanceType<typeof AgentManager>, config: AgentConfig = {} as AgentConfig): void {
  const fakeProcess = {
    getEnv: () => makeAgentEnv(),
    getConfig: () => config,
  };
  (mgr as any).agents.set('alice', { process: fakeProcess, checker: {} });
}

function makeShellCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'src-watch',
    prompt: 'mechanical',
    schedule: '30m',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    execMode: 'shell',
    command: 'echo hi && cortextos bus update-cron-fire src-watch --interval 30m',
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shell-cron-test-'));
  agentDir = join(root, 'orgs', 'acme', 'agents', 'alice');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, 'orgs', 'acme'), { recursive: true });
  sendMessageMock.mockClear();
  spawnMock.mockClear();
  vi.useRealTimers();
});

afterEach(() => {
  try { rmSync(root, { recursive: true }); } catch { /* ignore */ }
});

function newManager(): InstanceType<typeof AgentManager> {
  return new AgentManager('default', join(root, 'ctx'), root, 'acme');
}

describe('fireShellCron — failure plumbing', () => {
  it('exit 0 => success, NO PD alert', async () => {
    const mgr = newManager();
    wireAgent(mgr);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = (mgr as any).fireShellCron('alice', makeShellCron());
    // Emit output then close cleanly.
    child.stdout.emit('data', Buffer.from('ok\n'));
    child.emit('close', 0);
    await p;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('/bin/bash');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('non-zero exit => exactly ONE PD alert', async () => {
    const mgr = newManager();
    wireAgent(mgr);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = (mgr as any).fireShellCron('alice', makeShellCron());
    child.stderr.emit('data', Buffer.from('boom\n'));
    child.emit('close', 2);
    await p;

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, from, to, priority, body] = sendMessageMock.mock.calls[0];
    expect(from).toBe('alice');
    expect(to).toBe('platform-director');
    expect(priority).toBe('high');
    expect(body).toContain('exit=2');
    expect(body).toContain('cron=src-watch');
  });

  it('timeout => kills the child and sends ONE PD alert', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    wireAgent(mgr);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = (mgr as any).fireShellCron('alice', makeShellCron());
    // Advance past the 5-min default timeout; never emit 'close' before that.
    await vi.advanceTimersByTimeAsync(300_001);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // The process finally closes after being killed.
    child.emit('close', null);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await p;

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][4]).toContain('timeout');
  });

  it('missing command => alert + return, does NOT spawn', async () => {
    const mgr = newManager();
    wireAgent(mgr);
    await (mgr as any).fireShellCron('alice', makeShellCron({ command: undefined }));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][4]).toContain('exit=misconfig');
  });

  it('agent not in registry => alert + return, does NOT spawn', async () => {
    const mgr = newManager();
    // no wireAgent
    await (mgr as any).fireShellCron('alice', makeShellCron());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes KEY=VALUE-looking secrets out of the alert body', async () => {
    const mgr = newManager();
    wireAgent(mgr);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = (mgr as any).fireShellCron('alice', makeShellCron());
    child.stdout.emit('data', Buffer.from('OPENAI_KEY=sk-supersecret failed here'));
    child.emit('close', 1);
    await p;

    const body = sendMessageMock.mock.calls[0][4] as string;
    expect(body).not.toContain('sk-supersecret');
    expect(body).toContain('[redacted]');
  });

  it('never throws on spawn error (handled internally + alert)', async () => {
    const mgr = newManager();
    wireAgent(mgr);
    spawnMock.mockImplementation(() => { throw new Error('ENOENT bash'); });
    await expect((mgr as any).fireShellCron('alice', makeShellCron())).resolves.toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe('dispatcher branch on execMode (real onFire closure)', () => {
  /**
   * Wire an agent + invoke the real startAgentCronScheduler to capture the
   * as-shipped onFire closure from the mocked CronScheduler.
   */
  function realOnFire(mgr: InstanceType<typeof AgentManager>): (c: CronDefinition) => Promise<void> {
    capturedOnFire = null;
    // startAgentCronScheduler reads entry.process['config']?.runtime — provide it.
    (mgr as any).agents.set('alice', {
      process: { getEnv: () => makeAgentEnv(), getConfig: () => ({} as AgentConfig), config: {} },
      checker: {},
    });
    (mgr as any).startAgentCronScheduler('alice');
    if (!capturedOnFire) throw new Error('onFire was not captured');
    return capturedOnFire;
  }

  it("execMode='shell' routes to fireShellCron (not PTY injection)", async () => {
    const mgr = newManager();
    const onFire = realOnFire(mgr);
    const fireShellSpy = vi.spyOn(mgr as any, 'fireShellCron').mockResolvedValue(undefined);
    const injectSpy = vi.spyOn(mgr as any, 'injectAgent').mockReturnValue(true);

    await onFire(makeShellCron());
    expect(fireShellSpy).toHaveBeenCalledTimes(1);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it("absent/'pty' execMode uses PTY injection (not fireShellCron)", async () => {
    const mgr = newManager();
    const onFire = realOnFire(mgr);
    const fireShellSpy = vi.spyOn(mgr as any, 'fireShellCron').mockResolvedValue(undefined);
    const injectSpy = vi.spyOn(mgr as any, 'injectAgent').mockReturnValue(true);

    await onFire(makeShellCron({ execMode: undefined, command: undefined }));
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(fireShellSpy).not.toHaveBeenCalled();
  });

  it("'headless' logs a fallback warning and uses PTY injection", async () => {
    const mgr = newManager();
    const onFire = realOnFire(mgr);
    const fireShellSpy = vi.spyOn(mgr as any, 'fireShellCron').mockResolvedValue(undefined);
    const injectSpy = vi.spyOn(mgr as any, 'injectAgent').mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await onFire(makeShellCron({ execMode: 'headless', command: undefined }));

    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(fireShellSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some(c => String(c[0]).includes('headless not yet implemented'))).toBe(true);
    logSpy.mockRestore();
  });
});
