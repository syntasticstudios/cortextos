/**
 * tests/unit/pty/agent-env.test.ts — COST-LEVER-B3 shared env-builder.
 *
 * buildAgentCtxEnv is the single source of truth for the agent's CTX_ + secrets
 * environment, reused by both the PTY spawn path and the Tier-S shell-exec
 * cron path. These tests pin the load order (agent .env overrides org
 * secrets.env) and the presence of the load-bearing CTX_* keys.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildAgentCtxEnv } from '../../../src/pty/agent-env.js';
import type { CtxEnv, AgentConfig } from '../../../src/types/index.js';

let root: string;
let projectRoot: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
  projectRoot = root;
  agentDir = join(root, 'orgs', 'acme', 'agents', 'alice');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, 'orgs', 'acme'), { recursive: true });
});

afterEach(() => {
  try { rmSync(root, { recursive: true }); } catch { /* ignore */ }
});

function makeEnv(): CtxEnv {
  return {
    instanceId: 'default',
    ctxRoot: join(root, 'ctx'),
    frameworkRoot: root,
    agentName: 'alice',
    agentDir,
    org: 'acme',
    projectRoot,
  };
}

describe('buildAgentCtxEnv', () => {
  it('returns the load-bearing CTX_* identity keys', () => {
    const env = buildAgentCtxEnv(makeEnv(), {} as AgentConfig);
    expect(env.CTX_AGENT_NAME).toBe('alice');
    expect(env.CTX_FRAMEWORK_ROOT).toBe(root);
    expect(env.CTX_ORG).toBe('acme');
    expect(env.CTX_INSTANCE_ID).toBe('default');
    // Backward-compat aliases preserved.
    expect(env.CRM_AGENT_NAME).toBe('alice');
  });

  it('sources a key from org secrets.env', () => {
    writeFileSync(join(root, 'orgs', 'acme', 'secrets.env'), 'OPENAI_KEY=org-secret-123\n# comment\n');
    const env = buildAgentCtxEnv(makeEnv(), {} as AgentConfig);
    expect(env.OPENAI_KEY).toBe('org-secret-123');
  });

  it('lets agent .env override org secrets.env for the same key', () => {
    writeFileSync(join(root, 'orgs', 'acme', 'secrets.env'), 'SHARED=org-value\nORG_ONLY=org\n');
    writeFileSync(join(agentDir, '.env'), 'SHARED=agent-value\nBOT_TOKEN=abc\n');
    const env = buildAgentCtxEnv(makeEnv(), {} as AgentConfig);
    expect(env.SHARED).toBe('agent-value'); // agent .env wins
    expect(env.ORG_ONLY).toBe('org');        // org-only key preserved
    expect(env.BOT_TOKEN).toBe('abc');
  });

  it('derives CTX_TELEGRAM_CHAT_ID from CHAT_ID in agent .env', () => {
    writeFileSync(join(agentDir, '.env'), 'CHAT_ID=999\n');
    const env = buildAgentCtxEnv(makeEnv(), {} as AgentConfig);
    expect(env.CTX_TELEGRAM_CHAT_ID).toBe('999');
  });

  it('does NOT spread process.env (only derived keys)', () => {
    const env = buildAgentCtxEnv(makeEnv(), {} as AgentConfig);
    // A random process.env key must not leak into the derived map.
    expect(env.PATH).toBeUndefined();
  });
});
