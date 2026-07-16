import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { AgentConfig, CtxEnv } from '../types/index.js';

/**
 * Build the cortextOS-specific environment map for an agent.
 *
 * This is the SINGLE source of truth for the `CTX_*`/`CRM_*` variables, the
 * layered secrets (org `secrets.env` then agent `.env`), the convenience
 * aliases (`CTX_TELEGRAM_CHAT_ID`, `CTX_TIMEZONE`/`TZ`), the auto-update and
 * 1M-context guards, and `CTX_ORCHESTRATOR_AGENT`.
 *
 * It returns ONLY the derived map — it does NOT spread `process.env` (or any
 * "base" env). Callers layer it on top of their chosen base:
 *   - `AgentPTY.spawn`:   `{ ...this.getBaseEnv(), ...buildAgentCtxEnv(env, config) }`
 *   - shell-exec (Tier-S): `{ ...process.env,       ...buildAgentCtxEnv(env, config) }`
 *
 * Both the PTY agent and the Tier-S shell-exec path build their env from this
 * helper so the two can never drift (the shell cron sees exactly the same
 * `CTX_*`/secret surface the agent's own subprocesses would).
 *
 * Behaviour is intentionally byte-identical to the previous inline logic in
 * `AgentPTY.spawn`; do not add or reorder keys without matching the PTY path.
 */
export function buildAgentCtxEnv(env: CtxEnv, config: AgentConfig): Record<string, string> {
  const ctxEnv: Record<string, string> = {
    CTX_INSTANCE_ID: env.instanceId,
    CTX_ROOT: env.ctxRoot,
    CTX_FRAMEWORK_ROOT: env.frameworkRoot,
    CTX_AGENT_NAME: env.agentName,
    CTX_ORG: env.org,
    CTX_AGENT_DIR: env.agentDir,
    CTX_PROJECT_ROOT: env.projectRoot,
    // Backward compat
    CRM_AGENT_NAME: env.agentName,
    CRM_TEMPLATE_ROOT: env.frameworkRoot,
  };

  // Source org-level shared secrets (orgs/{org}/secrets.env).
  // These are shared across all agents in the org: OPENAI_KEY, APIFY_TOKEN, GEMINI_API_KEY, etc.
  // Agent .env is loaded after and overrides org values — agent-specific keys win.
  if (env.org && env.projectRoot) {
    const orgEnvFile = join(env.projectRoot, 'orgs', env.org, 'secrets.env');
    if (existsSync(orgEnvFile)) {
      const content = readFileSync(orgEnvFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          ctxEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }
  }

  // Source agent .env file (overrides org secrets.env for same key names).
  // Contains agent-specific secrets: BOT_TOKEN, CHAT_ID, CLAUDE_CODE_OAUTH_TOKEN.
  const agentEnvFile = join(env.agentDir, '.env');
  if (existsSync(agentEnvFile)) {
    const content = readFileSync(agentEnvFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        ctxEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
  }

  // Add convenience CTX_* aliases used throughout agent templates.
  // CTX_TELEGRAM_CHAT_ID: alias for CHAT_ID from the agent's .env
  if (ctxEnv['CHAT_ID']) {
    ctxEnv['CTX_TELEGRAM_CHAT_ID'] = ctxEnv['CHAT_ID'];
  }
  // CTX_TIMEZONE: from config.json timezone field, falls back to system TZ
  const configTimezone = config.timezone;
  if (configTimezone) {
    ctxEnv['CTX_TIMEZONE'] = configTimezone;
    ctxEnv['TZ'] = configTimezone; // also set TZ so date/time system calls use correct zone
  } else if (process.env.TZ) {
    ctxEnv['CTX_TIMEZONE'] = process.env.TZ;
  }
  // Daemon-managed sessions never need in-process auto-update — SDK updates happen
  // via npm at daemon-restart-time. Without this, agents can freeze for >30 min
  // in a "Checking for updates" animation loop, burning stdout with 99-byte ticks
  // and producing no agent work. Observed on BA/FE/PO sessions (2026-05-26).
  ctxEnv['CLAUDE_CODE_DISABLE_AUTOUPDATE'] = 'true';
  ctxEnv['DISABLE_AUTOUPDATER'] = 'true';
  // FIX #3 (2026-05-26): disable claude-code auto-update check that freezes sessions
  // in update-check loop. Observed BA/FE/PO stuck in "Checking for updates" for >30min
  // while burning 99 bytes stdout (pure UI animation, no agent work).
  // Daemon-managed sessions never need in-process auto-update — we control SDK updates
  // via npm at daemon-restart-time.
  ctxEnv['CLAUDE_CODE_DISABLE_AUTOUPDATE'] = 'true';
  ctxEnv['DISABLE_AUTOUPDATER'] = 'true';

  // ┌─ SYS-1M-PREVENT: BEST-EFFORT FORWARD-GUARD; NO-OP ON CURRENT CC (v2.1.162)
  // │  because auto-1M is OPUS-ONLY there. DETECT (agent-process.ts handleExit)
  // └─ is the LOAD-BEARING, VERSION-AGNOSTIC guard. Do NOT treat this as active
  //    prevention — keep this label so a future refactor knows it is a no-op now
  //    and does not let it silently re-become a false-prevention.
  // For an explicit non-Opus model with
  // no .env choice already made, default CLAUDE_CODE_DISABLE_1M_CONTEXT=true to
  // force the standard window. Honoured by current Claude Code (v2.1.162 reads
  // it and disables 1M — see shouldDisable1MContext), but effectiveness against
  // the original improver-1M incident is LIMITED, by design and by version:
  //   - On v2.1.162 the auto-1M default is OPUS-ONLY; explicit Sonnet/Haiku do
  //     not auto-1M, so this env-set is a NO-OP for the models it targets here.
  //   - It only bites on a CC version that BOTH auto-1M's a non-Opus model AND
  //     honours this var. v2.1.111 (the incident version) auto-1M'd Sonnet but
  //     did NOT honour the var — improver's .env already had it set and still
  //     looped; the effective fix was unpinning config.model (PR #62).
  // So this is forward-looking belt-and-suspenders for a future CC regression.
  // Set ONLY when the agent's .env (sourced above) did not already choose —
  // opt-in/opt-out respected. The real guard if 1M ever gates is DETECT.
  if (shouldDisable1MContext(config, ctxEnv['CLAUDE_CODE_DISABLE_1M_CONTEXT'] !== undefined)) {
    ctxEnv['CLAUDE_CODE_DISABLE_1M_CONTEXT'] = 'true';
  }

  // CTX_ORCHESTRATOR_AGENT: read from org context.json so agents can route to orchestrator
  if (env.projectRoot && env.org) {
    try {
      const contextPath = join(env.projectRoot, 'orgs', env.org, 'context.json');
      if (existsSync(contextPath)) {
        const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (ctx.orchestrator) {
          ctxEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
        }
      }
    } catch { /* leave unset if context.json is missing or malformed */ }
  }

  return ctxEnv;
}

/**
 * Decide whether to default `CLAUDE_CODE_DISABLE_1M_CONTEXT=true` for an agent.
 *
 * Extracted alongside {@link buildAgentCtxEnv} so both the PTY path and the
 * shell-exec path share one implementation. `AgentPTY.shouldDisable1MContext`
 * re-exports this for back-compat with existing callers/tests.
 *
 * Only defaults ON for an explicit NON-Opus model when the agent's `.env` has
 * not already chosen. Opus (native 1M), a `[1m]` opt-in suffix, an unset model,
 * and an explicit `.env` setting all return `false` (leave as-is).
 */
export function shouldDisable1MContext(config: AgentConfig, explicitSetting: boolean): boolean {
  if (explicitSetting) return false;
  if (!config.model) return false;
  if (/opus/i.test(config.model)) return false;
  if (/\[1m\]/i.test(config.model)) return false;
  return true;
}
