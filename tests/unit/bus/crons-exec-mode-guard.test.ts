/**
 * tests/unit/bus/crons-exec-mode-guard.test.ts — COST-LEVER-B3 set-time guard.
 *
 * updateCron rejects moving a cron to a non-PTY exec mode ('shell'/'headless')
 * when its prompt contains an escalation verb — unless force is passed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index.js';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'exec-mode-guard-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

async function importCrons() {
  return import('../../../src/bus/crons.js');
}

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'src-watch',
    prompt: 'Run the src-watch script then update-cron-fire.',
    schedule: '30m',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateExecMode (pure)', () => {
  const CMD = 'bash run.sh && cortextos bus update-cron-fire src-watch --interval 30m';

  it('allows a clean prompt to be tiered to shell (command supplied)', async () => {
    const { validateExecMode } = await importCrons();
    const err = validateExecMode({ execMode: 'shell', command: CMD }, makeCron());
    expect(err).toBeNull();
  });

  it('rejects tiering to shell with no command (hard misconfig, not force-overridable)', async () => {
    const { validateExecMode } = await importCrons();
    expect(validateExecMode({ execMode: 'shell' }, makeCron())).toContain('no command');
    // A command already on the cron satisfies the requirement.
    expect(validateExecMode({ execMode: 'shell' }, makeCron({ command: CMD }))).toBeNull();
    // Not overridable by force — it can never run without a command.
    expect(validateExecMode({ execMode: 'shell' }, makeCron(), true)).toContain('no command');
  });

  it('rejects a prompt containing send-message when tiering to shell (no force)', async () => {
    const { validateExecMode } = await importCrons();
    const cron = makeCron({ prompt: 'Scan and send-message platform-director if bad.' });
    const err = validateExecMode({ execMode: 'shell', command: CMD }, cron);
    expect(err).toContain('send-message');
    expect(err).toContain("execMode='shell'");
  });

  it('detects each escalation verb case-insensitively', async () => {
    const { validateExecMode } = await importCrons();
    for (const verb of ['send-message', 'send-telegram', 'platform-director']) {
      const cron = makeCron({ prompt: `foo ${verb.toUpperCase()} bar` });
      expect(validateExecMode({ execMode: 'headless' }, cron)).toContain(verb);
    }
  });

  it('allows with force even when an escalation verb is present (command supplied)', async () => {
    const { validateExecMode } = await importCrons();
    const cron = makeCron({ prompt: 'alert platform-director on fail' });
    expect(validateExecMode({ execMode: 'shell', command: CMD }, cron, true)).toBeNull();
  });

  it('is a no-op for a pty/absent execMode patch (never blocks unrelated updates)', async () => {
    const { validateExecMode } = await importCrons();
    const cron = makeCron({ prompt: 'send-message platform-director' });
    expect(validateExecMode({ prompt: 'new' }, cron)).toBeNull();
    expect(validateExecMode({ execMode: 'pty' }, cron)).toBeNull();
  });
});

describe('updateCron exec-mode guard (end-to-end)', () => {
  it('sets execMode=shell on a clean cron', async () => {
    const { addCron, updateCron, getCronByName } = await importCrons();
    addCron('alice', makeCron());
    const ok = updateCron('alice', 'src-watch', {
      execMode: 'shell',
      command: 'echo ok && cortextos bus update-cron-fire src-watch --interval 30m',
    });
    expect(ok).toBe(true);
    const stored = getCronByName('alice', 'src-watch');
    expect(stored?.execMode).toBe('shell');
    expect(stored?.command).toContain('update-cron-fire');
  });

  const E2E_CMD = 'bash run.sh && cortextos bus update-cron-fire src-watch --interval 30m';

  it('throws when tiering a send-message cron to shell without force', async () => {
    const { addCron, updateCron } = await importCrons();
    addCron('alice', makeCron({ prompt: 'poll and send-message platform-director high on failure' }));
    expect(() => updateCron('alice', 'src-watch', { execMode: 'shell', command: E2E_CMD })).toThrow(/send-message/);
  });

  it('accepts the same change when force=true', async () => {
    const { addCron, updateCron, getCronByName } = await importCrons();
    addCron('alice', makeCron({ prompt: 'poll and send-message platform-director high on failure' }));
    const ok = updateCron('alice', 'src-watch', { execMode: 'shell', command: E2E_CMD }, true);
    expect(ok).toBe(true);
    expect(getCronByName('alice', 'src-watch')?.execMode).toBe('shell');
  });

  it('throws when tiering to shell with no command at all', async () => {
    const { addCron, updateCron } = await importCrons();
    addCron('alice', makeCron());
    expect(() => updateCron('alice', 'src-watch', { execMode: 'shell' })).toThrow(/no command/);
  });
});
