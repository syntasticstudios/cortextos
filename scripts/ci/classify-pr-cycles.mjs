#!/usr/bin/env node
// classify-pr-cycles.mjs — CI-cycles-to-green classifier RUNNER (GitHub I/O + report).
//
// Standalone measurement helper for the devops `ci-pr-cycles-to-green` autoresearch loop.
// It refines `mean_ci_gate_failures_before_first_green` so a SAME-SHA fail->pass (a PR-body/
// label hygiene gate self-resolving, or a true infra flake) does NOT count as a code-gate
// failure, while still surfacing same-SHA transients as a flake-rate signal.
//
// LIVE-PATH (PD seam 2, 2026-07-17): this is a standalone `node` script invoked by the loop —
// it is NOT imported into daemon.js, so it is live-on-rebuild (no Founder-gated restart).
//
// BUILD-vs-ADOPT (PD seam 1): integrations-routing OWNS this helper; the devops
// ci-pr-cycles-to-green loop must ADOPT it (call it + read the flake counter). See the
// hand-off note in the landing PR.
//
// Pure classification lives in pr-cycle-classifier-lib.mjs (unit-tested). This file only does
// GitHub I/O via `gh` and formatting.
//
// Usage:
//   node scripts/ci/classify-pr-cycles.mjs --repo <owner/name> [--prs 1,2,3 | --merged-since-days N]
//        [--workflow <file.yml>] [--limit N] [--log <path>] [--dry-run] [--json]
//
// Requires: `gh` CLI authenticated for --repo. On any gh error the run FAILS LOUD (non-zero
// exit, no fabricated numbers) — a degraded probe is a probe failure, never a "0 failures".

import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { classifyPrCycles } from './pr-cycle-classifier-lib.mjs';

function parseArgs(argv) {
  const a = { repo: '', prs: null, mergedSinceDays: null, workflow: '', limit: 20, log: '', dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = argv[++i];
    else if (k === '--prs') a.prs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--merged-since-days') a.mergedSinceDays = Number(argv[++i]);
    else if (k === '--workflow') a.workflow = argv[++i];
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--log') a.log = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--json') a.json = true;
    else if (k === '-h' || k === '--help') a.help = true;
  }
  return a;
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`gh ${args.join(' ')} failed: ${msg.trim()}`);
  }
}

function discoverPrNumbers(repo, mergedSinceDays, limit) {
  const out = gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(limit),
    '--json', 'number,mergedAt']);
  const prs = JSON.parse(out);
  if (!mergedSinceDays) return prs.map((p) => p.number);
  const cutoff = Date.now() - mergedSinceDays * 86400_000;
  return prs.filter((p) => Date.parse(p.mergedAt) >= cutoff).map((p) => p.number);
}

function loadPr(repo, number) {
  const meta = JSON.parse(gh(['pr', 'view', String(number), '--repo', repo,
    '--json', 'number,headRefName,commits']));
  // commits are returned oldest->newest; oid is the full sha.
  const commitShas = (meta.commits || []).map((c) => c.oid).filter(Boolean);
  const commitSet = new Set(commitShas);

  const runsRaw = JSON.parse(gh(['run', 'list', '--repo', repo, '--branch', meta.headRefName,
    '--limit', '200',
    '--json', 'headSha,workflowName,name,conclusion,status,createdAt']));
  // Scope to THIS PR's commits + completed runs only; a branch may be reused across PRs.
  const runs = runsRaw
    .filter((r) => r.status === 'completed' && commitSet.has(r.headSha))
    .map((r) => ({ check: r.workflowName || r.name, sha: r.headSha, conclusion: r.conclusion, createdAt: r.createdAt }));
  return { number, commitShas, runs };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.repo) {
    console.log('usage: classify-pr-cycles.mjs --repo <owner/name> [--prs 1,2 | --merged-since-days N] [--dry-run] [--json]');
    process.exit(a.repo ? 0 : 2);
  }

  let numbers = a.prs && a.prs.length ? a.prs : discoverPrNumbers(a.repo, a.mergedSinceDays, a.limit);
  if (!numbers.length) {
    console.error('No PRs to analyze (check --repo / --merged-since-days / --limit).');
    process.exit(1);
  }

  const prs = numbers.map((n) => loadPr(a.repo, n));
  const summary = classifyPrCycles(prs);
  summary.repo = a.repo;
  summary.prNumbers = numbers;

  // Observable flake-rate log line (PD guardrail — suppression must never be silent).
  if (!a.dryRun) {
    const logPath = a.log
      || join(process.env.CTX_FRAMEWORK_ROOT || process.cwd(), 'logs', 'ci-flake-rate.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      repo: a.repo,
      prsAnalyzed: summary.prsAnalyzed,
      realGateFailuresBeforeFirstGreen: summary.realGateFailuresBeforeFirstGreen,
      meanRealGateFailuresBeforeFirstGreen: summary.meanRealGateFailuresBeforeFirstGreen,
      sameShaTransientRuns: summary.sameShaTransientRuns,
      sameShaTransientByCheck: summary.sameShaTransientByCheck,
    });
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + '\n');
      summary.logPath = logPath;
    } catch (e) {
      console.error(`WARN: could not append flake-rate log at ${logPath}: ${e.message}`);
    }
  }

  if (a.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const m = summary.meanRealGateFailuresBeforeFirstGreen;
    console.log(`CI cycles-to-green — ${a.repo} (${summary.prsAnalyzed} PRs)`);
    console.log(`  REAL gate failures before first green (new-sha-resolved): ${summary.realGateFailuresBeforeFirstGreen} (mean ${m.toFixed(3)}/PR)`);
    console.log(`  same-SHA transients EXCLUDED (flake-rate signal): ${summary.sameShaTransientRuns}`);
    for (const [c, n] of Object.entries(summary.sameShaTransientByCheck)) {
      console.log(`    - ${c}: ${n} same-sha fail->pass`);
    }
    if (summary.logPath) console.log(`  flake-rate log: ${summary.logPath}`);
  }
}

main();
