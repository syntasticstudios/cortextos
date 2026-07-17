// pr-cycle-classifier-lib.mjs — PURE classification logic for CI-cycles-to-green.
//
// Problem (devops weekly ci-pr-cycles-to-green read, filed 2026-07-17, 2wk trigger crossed):
// the `mean_ci_gate_failures_before_first_green` metric counts SAME-SHA fail->pass transitions
// as CI gate failures. But the phytomedic `PR Verification Check` (screenshot-mandate /
// migration-execution-gate) is a PR-BODY/LABEL hygiene gate that hard-fails via core.setFailed
// until the author populates the PR body, then PASSES on a later edit/label event — SAME head
// SHA, zero code change (verified: sha 4f1dcc74, fail 09:11:11 -> pass 09:11:20, +9s, body
// edited between). A same-SHA fail->pass is NOT a real code-gate failure; counting it (a)
// inflates the green metric and (b) — the real risk — trains reviewers to wave off any
// fail->pass re-run as "just a flake", masking a genuine break.
//
// Fix (option b, PD-endorsed): classify a gate failure as REAL only when it required a NEW head
// SHA (a code change) to go green. A same-SHA fail->pass is a transient — EXCLUDED from the
// green metric but NOT hidden: it is counted per-check into a flake-rate signal (PD guardrail
// 2026-07-17 — a rising same-SHA flake rate on a CODE check is itself a real health signal, so
// suppression must never be silent).
//
// This file is PURE (no I/O) so it is unit-testable without live `gh`. The runner
// (classify-pr-cycles.mjs) does the GitHub I/O and calls classifyPrCycles().

// Conclusions that count as a real failing run. `cancelled`/`skipped`/`neutral`/`stale` are
// NOT failures (a cancelled run — e.g. from concurrency cancel-in-progress — is not a gate
// failure and must not inflate the metric). `timed_out` is treated as a failure.
export const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out']);

/**
 * Classify one PR's check runs.
 *
 * @param {object} pr
 * @param {number|string} pr.number
 * @param {string[]} pr.commitShas   full head SHAs in chronological (oldest->newest) order
 * @param {Array<{check:string, sha:string, conclusion:string, createdAt:string}>} pr.runs
 * @returns {{
 *   number:number|string,
 *   realGateFailures:number,                 // failures that required a NEW sha (real, count toward green metric)
 *   sameShaTransientRuns:number,             // failing runs later resolved on the SAME sha (excluded, flake-rate)
 *   sameShaTransientByCheck:Record<string,number>,
 *   realGateFailureByCheck:Record<string,number>,
 *   details:Array<object>,
 * }}
 */
export function classifyPr(pr) {
  const commitOrder = new Map((pr.commitShas || []).map((s, i) => [s, i]));
  // Group runs by check, then by sha.
  const byCheck = new Map();
  for (const r of pr.runs || []) {
    if (!byCheck.has(r.check)) byCheck.set(r.check, []);
    byCheck.get(r.check).push(r);
  }

  let realGateFailures = 0;
  let sameShaTransientRuns = 0;
  const sameShaTransientByCheck = {};
  const realGateFailureByCheck = {};
  const details = [];

  for (const [check, runs] of byCheck) {
    // Stable chronological order.
    const sorted = [...runs].sort((a, b) => tms(a.createdAt) - tms(b.createdAt));
    // Per-sha buckets for this check.
    const shas = new Map();
    for (const r of sorted) {
      if (!shas.has(r.sha)) shas.set(r.sha, []);
      shas.get(r.sha).push(r);
    }

    for (const [sha, shaRuns] of shas) {
      const failures = shaRuns.filter((r) => FAILURE_CONCLUSIONS.has(r.conclusion));
      if (failures.length === 0) continue;
      const firstFailAt = tms(failures[0].createdAt);
      // A LATER success on the SAME sha => the identical code passed => transient (no code fix).
      const laterSuccessSameSha = shaRuns.some(
        (r) => r.conclusion === 'success' && tms(r.createdAt) > firstFailAt,
      );

      if (laterSuccessSameSha) {
        sameShaTransientRuns += failures.length;
        sameShaTransientByCheck[check] = (sameShaTransientByCheck[check] || 0) + failures.length;
        details.push({ check, sha, kind: 'same-sha-transient', failingRuns: failures.length });
      } else {
        // Not resolved on this sha. Real gate failure — going green needed a new commit
        // (or it never went green). Count once per (check, sha) failing group.
        realGateFailures += 1;
        realGateFailureByCheck[check] = (realGateFailureByCheck[check] || 0) + 1;
        const resolvedByNewSha = resolvedLater(check, sha, shas, commitOrder);
        details.push({
          check,
          sha,
          kind: 'real-gate-failure',
          failingRuns: failures.length,
          resolution: resolvedByNewSha ? 'new-sha' : 'unresolved',
        });
      }
    }
  }

  return {
    number: pr.number,
    realGateFailures,
    sameShaTransientRuns,
    sameShaTransientByCheck,
    realGateFailureByCheck,
    details,
  };
}

/** Did `check` go green on a sha that is chronologically AFTER `sha`? */
function resolvedLater(check, sha, shasMap, commitOrder) {
  const idx = commitOrder.has(sha) ? commitOrder.get(sha) : -1;
  for (const [otherSha, runs] of shasMap) {
    if (otherSha === sha) continue;
    const otherIdx = commitOrder.has(otherSha) ? commitOrder.get(otherSha) : -1;
    // Prefer commit-order; fall back to any other sha with a success if order unknown.
    const isLater = idx >= 0 && otherIdx >= 0 ? otherIdx > idx : true;
    if (isLater && runs.some((r) => r.conclusion === 'success')) return true;
  }
  return false;
}

/**
 * Aggregate across PRs, producing the refined green metric + the flake-rate signal.
 * @param {Array} prs  array of pr objects (see classifyPr)
 * @returns aggregate summary
 */
export function classifyPrCycles(prs) {
  const perPr = (prs || []).map(classifyPr);
  const prsAnalyzed = perPr.length;
  const realTotal = perPr.reduce((n, p) => n + p.realGateFailures, 0);
  const transientTotal = perPr.reduce((n, p) => n + p.sameShaTransientRuns, 0);

  const sameShaTransientByCheck = {};
  const realGateFailureByCheck = {};
  for (const p of perPr) {
    for (const [c, n] of Object.entries(p.sameShaTransientByCheck)) {
      sameShaTransientByCheck[c] = (sameShaTransientByCheck[c] || 0) + n;
    }
    for (const [c, n] of Object.entries(p.realGateFailureByCheck)) {
      realGateFailureByCheck[c] = (realGateFailureByCheck[c] || 0) + n;
    }
  }

  return {
    prsAnalyzed,
    // The REFINED metric: only new-sha-resolved (real) gate failures count toward cycles-to-green.
    realGateFailuresBeforeFirstGreen: realTotal,
    meanRealGateFailuresBeforeFirstGreen: prsAnalyzed ? realTotal / prsAnalyzed : 0,
    realGateFailureByCheck,
    // The flake-rate signal (NOT hidden — PD guardrail). Rising value on a code check = real.
    sameShaTransientRuns: transientTotal,
    sameShaTransientByCheck,
    perPr,
  };
}

function tms(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
