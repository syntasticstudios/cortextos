#!/usr/bin/env node
// classify-pr-cycles.mjs — CI-cycles-to-green classifier RUNNER (GitHub I/O + report).
//
// Standalone measurement helper for the devops `ci-pr-cycles-to-green` autoresearch loop.
// It refines `mean_ci_gate_failures_before_first_green` so a SAME-SHA fail->pass (a PR-body/
// label hygiene gate self-resolving, or a true infra flake) does NOT count as a code-gate
// failure, while still surfacing same-SHA transients as a flake-rate signal.
//
// LIVE-PATH (PD seam, 2026-07-17): this is a standalone `node` script invoked by the loop —
// it is NOT imported into daemon.js, so it is live-on-rebuild (no Founder-gated restart).
//
// BUILD-vs-ADOPT (PD seam): integrations-routing OWNS this helper; the devops
// ci-pr-cycles-to-green loop must ADOPT it (call it + read the flake counter) and correctness-
// review it before wiring live. See the landing-PR hand-off note.
//
// Pure classification lives in pr-cycle-classifier-lib.mjs (unit-tested). This file only does
// GitHub I/O via `gh` and formatting.
//
// SCOPING (hardened after high-effort review 2026-07-17): runs are scoped to the PR's branch
// within the PR's active window [createdAt, mergedAt||now], NOT to the PR's CURRENT commit set.
// Scoping by current commits silently dropped runs on force-pushed / rebased-away SHAs —
// exactly the high-churn PRs the metric cares about — and coupled us to GitHub's ~100-commit
// field cap. The time-window is bounded by the PR lifetime so a later reuse of the branch
// (post-merge) is not misattributed.
//
// NO SILENT CAPS: every `gh` page limit that could truncate is checked; a cap-hit is reported
// loudly (stderr WARN + a truncated flag), never silently undercounted. On any gh error the
// run FAILS LOUD (non-zero exit, no fabricated numbers) — a degraded probe is a probe failure.
//
// Usage:
//   node scripts/ci/classify-pr-cycles.mjs --repo <owner/name> [--prs 1,2,3 | --merged-since-days N]
//        [--workflow <name-substring>] [--limit N] [--run-limit N] [--log <path>] [--dry-run] [--json]

import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { classifyPrCycles } from './pr-cycle-classifier-lib.mjs';

const DEFAULT_PR_LIMIT = 100;
const DEFAULT_RUN_LIMIT = 300;

function parseArgs(argv) {
  const a = {
    repo: '', prs: null, mergedSinceDays: null, workflow: '',
    limit: DEFAULT_PR_LIMIT, runLimit: DEFAULT_RUN_LIMIT, log: '', dryRun: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = argv[++i];
    else if (k === '--prs') a.prs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--merged-since-days') a.mergedSinceDays = argv[++i];
    else if (k === '--workflow') a.workflow = argv[++i];
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--run-limit') a.runLimit = Number(argv[++i]);
    else if (k === '--log') a.log = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--json') a.json = true;
    else if (k === '-h' || k === '--help') a.help = true;
  }
  return a;
}

function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}
function warn(msg) {
  console.error(`WARN: ${msg}`);
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`gh ${args.join(' ')} failed: ${detail.trim()}`);
  }
}

// State collected across the run so a partial/truncated read is reported, never silent.
const truncations = [];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function discoverPrNumbers(repo, mergedSinceDays, limit) {
  const args = ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(limit),
    '--json', 'number,mergedAt'];
  if (mergedSinceDays != null) {
    // Filter server-side by merge date so `--limit` is not applied to newest-first BEFORE the
    // window filter (which would silently drop older-but-in-window PRs).
    args.push('--search', `merged:>=${isoDaysAgo(mergedSinceDays)}`);
  }
  const prs = JSON.parse(gh(args));
  if (prs.length >= limit) {
    truncations.push(`pr-list hit --limit ${limit} (${prs.length} returned)`);
    warn(`gh pr list returned ${prs.length} >= --limit ${limit}; more PRs may exist in the window. Raise --limit for completeness.`);
  }
  return prs.map((p) => p.number);
}

function loadPr(repo, number, workflowFilter, runLimit) {
  const meta = JSON.parse(gh(['pr', 'view', String(number), '--repo', repo,
    '--json', 'number,headRefName,createdAt,mergedAt,closedAt']));
  const startMs = Date.parse(meta.createdAt) || 0;
  const endMs = Date.parse(meta.mergedAt || meta.closedAt || '') || Date.now();

  const runsRaw = JSON.parse(gh(['run', 'list', '--repo', repo, '--branch', meta.headRefName,
    '--limit', String(runLimit),
    '--json', 'databaseId,headSha,workflowName,name,conclusion,status,createdAt,updatedAt']));
  if (runsRaw.length >= runLimit) {
    truncations.push(`pr#${number} run-list hit --run-limit ${runLimit}`);
    warn(`PR #${number}: gh run list hit --run-limit ${runLimit}; oldest runs may be dropped. Raise --run-limit.`);
  }

  const runs = runsRaw
    // completed runs only; scope to THIS PR's lifetime window (captures force-pushed SHAs,
    // excludes later branch reuse after merge).
    .filter((r) => r.status === 'completed')
    .filter((r) => {
      const c = Date.parse(r.createdAt) || 0;
      return c >= startMs && c <= endMs;
    })
    .map((r) => ({
      check: r.workflowName || r.name,
      sha: r.headSha,
      conclusion: r.conclusion,
      createdAt: r.createdAt,
      completedAt: r.updatedAt,
      runId: r.databaseId,
    }))
    .filter((r) => !workflowFilter || (r.check || '').toLowerCase().includes(workflowFilter.toLowerCase()));

  return { number, runs };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.repo) {
    console.log('usage: classify-pr-cycles.mjs --repo <owner/name> [--prs 1,2 | --merged-since-days N] [--workflow name] [--limit N] [--run-limit N] [--dry-run] [--json]');
    process.exit(a.repo ? 0 : 2);
  }
  if (!Number.isFinite(a.limit) || a.limit <= 0) die(`--limit must be a positive number (got "${a.limit}")`, 2);
  if (!Number.isFinite(a.runLimit) || a.runLimit <= 0) die(`--run-limit must be a positive number (got "${a.runLimit}")`, 2);

  let mergedSinceDays = null;
  if (a.mergedSinceDays != null) {
    mergedSinceDays = Number(a.mergedSinceDays);
    if (!Number.isFinite(mergedSinceDays) || mergedSinceDays <= 0) {
      die(`--merged-since-days must be a positive number (got "${a.mergedSinceDays}")`, 2);
    }
  }

  let numbers;
  try {
    numbers = a.prs && a.prs.length ? a.prs : discoverPrNumbers(a.repo, mergedSinceDays, a.limit);
    if (!numbers.length) die('No PRs to analyze (check --repo / --merged-since-days / --limit).');
    var prs = numbers.map((n) => loadPr(a.repo, n, a.workflow, a.runLimit));
  } catch (e) {
    // Fail loud — a degraded probe is a probe failure, never a fabricated 0.
    die(e.message);
  }

  const summary = classifyPrCycles(prs);
  summary.repo = a.repo;
  summary.prNumbers = numbers;
  summary.workflowFilter = a.workflow || null;
  summary.truncated = truncations.length > 0;
  summary.truncations = truncations;

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
      postGreenRegressions: summary.postGreenRegressions,
      truncated: summary.truncated,
    });
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + '\n');
      summary.logPath = logPath;
    } catch (e) {
      warn(`could not append flake-rate log at ${logPath}: ${e.message}`);
    }
  }

  if (a.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const m = summary.meanRealGateFailuresBeforeFirstGreen;
    console.log(`CI cycles-to-green — ${a.repo} (${summary.prsAnalyzed} PRs${summary.workflowFilter ? `, workflow~"${summary.workflowFilter}"` : ''})`);
    console.log(`  REAL gate failures before first green (new-sha-resolved): ${summary.realGateFailuresBeforeFirstGreen} (mean ${m.toFixed(3)}/PR)`);
    console.log(`  same-SHA transients EXCLUDED (flake-rate signal): ${summary.sameShaTransientRuns}`);
    for (const [c, n] of Object.entries(summary.sameShaTransientByCheck)) {
      console.log(`    - ${c}: ${n} same-sha fail->pass`);
    }
    if (summary.postGreenRegressions) console.log(`  post-first-green regressions EXCLUDED: ${summary.postGreenRegressions}`);
    if (summary.truncated) console.log(`  ⚠ TRUNCATED (metric may undercount): ${summary.truncations.join('; ')}`);
    if (summary.logPath) console.log(`  flake-rate log: ${summary.logPath}`);
  }

  // Signal truncation to callers (devops loop) via a distinct non-zero exit while still having
  // printed the (partial) result — so an automated read can detect "completeness not guaranteed".
  if (summary.truncated) process.exit(3);
}

main();
