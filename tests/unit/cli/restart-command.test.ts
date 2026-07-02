/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand
 * (issue #328). Companion to lifecycle-markers.test.ts which already
 * covers writeStopMarker — this file pins the command-level wiring
 * (name, required argument, --instance option, description) and the
 * IPC flow.
 *
 * SYS-DAEMON-RESTART-DEDUP-01: restart must issue the daemon's ATOMIC
 * `restart-agent` op — NOT separate `stop-agent` + `start-agent` calls.
 * The two-call flow deduped the start against the not-yet-removed
 * registry entry (stopAgent takes ~6s to tear down a claude-code PTY
 * while the fire-and-forget stop IPC returns in ~0ms), leaving the
 * agent STOPPED. The regression tests below pin the single-op flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// ---------------------------------------------------------------------------
// IPC mock — prevent real socket connections in unit tests.
// ---------------------------------------------------------------------------
const mockIpcSend = vi.fn().mockResolvedValue({ success: true, data: 'Restarting boris' });
const mockIpcIsDaemonRunning = vi.fn().mockResolvedValue(true);

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockIpcSend;
    isDaemonRunning = mockIpcIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

// Import AFTER the mock is registered.
import { restartCommand } from '../../../src/cli/restart';

describe('issue #328: cortextos restart <agent>', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('requires the <agent> positional argument', () => {
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance with a default of "default"', () => {
    const opts = restartCommand.opts();
    expect(opts.instance).toBe('default');
  });

  it('describes itself as a stop+start (not a daemon restart)', () => {
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('stop');
    expect(desc).toContain('start');
    expect(desc).toContain('daemon');
  });
});

// ---------------------------------------------------------------------------
// SYS-DAEMON-RESTART-DEDUP-01 — the action must use one atomic restart-agent op
// ---------------------------------------------------------------------------
describe('SYS-DAEMON-RESTART-DEDUP-01: atomic restart flow', () => {
  // Use a throwaway instance id so the marker lands in a temp-ish state dir
  // under the real ~/.cortextos (the action derives the path from homedir()).
  const instance = 'restart-dedup-test-' + process.pid;
  const stateDir = join(homedir(), '.cortextos', instance, 'state', 'boris');
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let scratch: string;

  beforeEach(() => {
    mockIpcSend.mockClear();
    mockIpcIsDaemonRunning.mockClear();
    mockIpcSend.mockResolvedValue({ success: true, data: 'Restarting boris' });
    mockIpcIsDaemonRunning.mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    scratch = mkdtempSync(join(tmpdir(), 'restart-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(join(homedir(), '.cortextos', instance), { recursive: true, force: true }); } catch { /* noop */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('sends exactly one atomic restart-agent op — never separate stop+start', async () => {
    await restartCommand.parseAsync(['node', 'restart', 'boris', '--instance', instance]);

    // Exactly one IPC send, and it is restart-agent (not stop-agent/start-agent).
    expect(mockIpcSend).toHaveBeenCalledTimes(1);
    const sent = mockIpcSend.mock.calls[0][0];
    expect(sent.type).toBe('restart-agent');
    expect(sent.agent).toBe('boris');

    // No stop-agent / start-agent messages were ever sent — that two-call flow
    // is what raced and deduped the start against the lingering registry entry.
    const allTypes = mockIpcSend.mock.calls.map((c) => c[0].type);
    expect(allTypes).not.toContain('stop-agent');
    expect(allTypes).not.toContain('start-agent');
  });

  it('writes a .user-restart marker before triggering the restart', async () => {
    await restartCommand.parseAsync(['node', 'restart', 'boris', '--instance', instance]);
    const marker = join(stateDir, '.user-restart');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8')).toContain('cortextos restart');
    // Must NOT write the .user-stop marker (that was the stop-phase artifact of
    // the racy two-call flow).
    expect(existsSync(join(stateDir, '.user-stop'))).toBe(false);
  });

  it('exits non-zero when the daemon reports the agent NOT_FOUND', async () => {
    mockIpcSend.mockResolvedValue({ success: false, error: 'not in registry', code: 'NOT_FOUND' });
    await expect(
      restartCommand.parseAsync(['node', 'restart', 'boris', '--instance', instance]),
    ).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
