import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart a running agent (stop + start). Re-reads config.json and .env, respawns the PTY. Does NOT restart the daemon process itself — use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // Write the .user-restart marker BEFORE triggering the restart so the
    // SessionEnd crash-alert hook reports a clean restart instead of a false
    // 🚨 CRASH alarm during the stop→start window. (BUG-036 pattern; matches
    // `cortextos bus soft-restart`.)
    const stateDir = join(homedir(), '.cortextos', options.instance, 'state', agent);
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-restart'), 'restarted via cortextos restart');
    } catch (err) {
      // Non-fatal: worst case is a transient false crash alarm. Proceed.
      console.error(`  Warning: could not write .user-restart marker: ${(err as Error).message}`);
    }

    // Use the daemon's ATOMIC restart-agent op rather than issuing separate
    // stop + start IPC calls. The daemon runs `await stopAgent(); await
    // startAgent()` as a single in-process sequence, so the start's registry
    // check happens AFTER the stop's registry delete — no cross-IPC dedup race.
    //
    // SYS-DAEMON-RESTART-DEDUP-01: the old two-call flow deduped the start
    // against the not-yet-removed registry entry. `stopAgent` takes ~6s to tear
    // down a claude-code PTY (Ctrl-C + /exit + waits) and only deletes the
    // registry entry once that completes, but the fire-and-forget stop IPC
    // returns in ~0ms. The immediately-following start therefore saw the agent
    // still "in registry" → DEDUPED → start aborted, leaving the agent STOPPED.
    const resp = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos restart' });
    if (!resp.success) {
      console.error(`  Restart failed: ${resp.error}`);
      if (resp.code === 'NOT_FOUND') {
        console.error(`  Agent "${agent}" is not running. Start it with: cortextos start ${agent}`);
      }
      process.exit(1);
    }
    console.log(`  ${resp.data}`);
  });
