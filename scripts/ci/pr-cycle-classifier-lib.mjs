// pr-cycle-classifier-lib.mjs — PURE classification logic for CI-cycles-to-green.
//
// Problem (devops weekly ci-pr-cycles-to-green read, filed 2026-07-17, 2wk trigger crossed):
// the `mean_ci_gate_failures_before_first_green` metric counts SAME-SHA fail->pass transitions
// as CI gate failures. But the phytomedic `PR Verification Check` (screenshot-mandate /
// migration-execution-gate) and `Edge-Case Awareness Check` are PR-BODY/LABEL hygiene gates
// that hard-fail via core.setFailed until the author populates the PR body, then PASS on a
// later edit/label event — SAME head SHA, zero code change (verified: PR #1638 sha 4f1dcc74,
// fail 09:11:11 -> pass 09:11:20). A same-SHA fail->pass is NOT a real code-gate failure;
// counting it (a) inflates the green metric and (b) — the real risk — trains reviewers to wave
// off any fail->pass re-run as "just a flake", masking a genuine break.
//
// Fix (option b, PD-endorsed): a gate failure is REAL only when a NEW head SHA (a code change)
// was needed to go green. A same-SHA fail->pass is a transient — EXCLUDED from the green metric
// but NOT hidden: counted per-check into a flake-rate signal (PD guardrail 2026-07-17 — a
// rising same-SHA flake rate on a CODE check is itself a real health signal).
//
// CLASSIFICATION MODEL (hardened after high-effort review 2026-07-17):
//   * GENERIC — keyed purely on the resolution SHA, never on a check-name allowlist, so a
//     future body-gate is auto-covered with zero code change.
//   * TERMINAL-STATE, not "any later success": for each (check, sha) we look at the sha's
//     terminal (last) run. Terminal-success => earlier failures on that sha are transients
//     (fixes fail->pass->fail-ends-RED being mis-scored transient). Terminal-failure => the
//     sha ended red; whether it counts depends on the resolution SHA (below).
//   * ORDER BY COMPLETION TIME then run id — GitHub `createdAt` is CREATE (queue) time at
//     1s resolution; ties and out-of-order completions would misorder fail vs pass. We order
//     by completedAt (updatedAt) with a monotonic run-id tiebreak, so a same-second fix-and-
//     rerun is ordered correctly.
//   * BEFORE-FIRST-GREEN boundary honored: a terminal-failure sha whose only success is
//     EARLIER (the check already went green, then a later commit re-broke it) is a
//     post-first-green regression — reported separately, NOT counted toward
//     realGateFailuresBeforeFirstGreen (which would inflate cycles-to-FIRST-green).
//
// This file is PURE (no I/O) so it is unit-testable without live `gh`. The runner
// (classify-pr-cycles.mjs) does the GitHub I/O and calls classifyPrCycles().

// Conclusions that count as a real failing run. `cancelled`/`skipped`/`neutral`/`stale` are
// NOT failures (a cancelled run — e.g. from concurrency cancel-in-progress — is not a gate
// failure and must not inflate the metric). `timed_out` is treated as a failure.
export const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out']);
// Conclusions that establish a sha's end-state (define "terminal" run). Non-terminal
// conclusions (cancelled/skipped/neutral/action_required) do not decide green-vs-red.
const TERMINAL_CONCLUSIONS = new Set(['success', 'failure', 'timed_out']);

function orderVal(r) {
  // Completion time (updatedAt/completedAt) is the true ordering signal; createdAt is queue
  // time. Fall back to createdAt if completion is absent.
  const t = Date.parse(r.completedAt || r.createdAt || '');
  return { t: Number.isNaN(t) ? 0 : t, id: Number(r.runId) || 0 };
}
function cmpRuns(a, b) {
  const ka = orderVal(a);
  const kb = orderVal(b);
  return ka.t - kb.t || ka.id - kb.id;
}
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/**
 * Classify one PR's check runs.
 *
 * @param {object} pr
 * @param {number|string} pr.number
 * @param {Array<{check:string, sha:string, conclusion:string, createdAt:string, completedAt?:string, runId?:number|string}>} pr.runs
 * @returns {{
 *   number:number|string,
 *   realGateFailures:number,                 // failures resolved by a NEW sha or never resolved (count toward green metric)
 *   sameShaTransientRuns:number,             // failing runs on a sha that ENDED green (excluded, flake-rate)
 *   postGreenRegressions:number,             // sha ended red AFTER the check first went green (excluded from before-first-green)
 *   sameShaTransientByCheck:Record<string,number>,
 *   realGateFailureByCheck:Record<string,number>,
 *   details:Array<object>,
 * }}
 */
export function classifyPr(pr) {
  const byCheck = groupBy(pr.runs || [], (r) => r.check);

  let realGateFailures = 0;
  let sameShaTransientRuns = 0;
  let postGreenRegressions = 0;
  const sameShaTransientByCheck = {};
  const realGateFailureByCheck = {};
  const details = [];

  for (const [check, runsRaw] of byCheck) {
    const runs = [...runsRaw].sort(cmpRuns);
    runs.forEach((r, i) => (r.__i = i)); // global order index within this check

    const byShaGroup = groupBy(runs, (r) => r.sha);
    for (const [sha, shaRuns] of byShaGroup) {
      const failures = shaRuns.filter((r) => FAILURE_CONCLUSIONS.has(r.conclusion));
      if (failures.length === 0) continue;

      // Terminal run of THIS sha (last run with a terminal conclusion).
      const terminals = shaRuns.filter((r) => TERMINAL_CONCLUSIONS.has(r.conclusion));
      const terminal = terminals[terminals.length - 1];

      if (terminal && terminal.conclusion === 'success') {
        // Sha ended GREEN — the identical code passed => the failures were transient
        // (body/label gate self-resolve, or an infra flake). Excluded from the green metric;
        // surfaced to the flake-rate signal.
        sameShaTransientRuns += failures.length;
        sameShaTransientByCheck[check] = (sameShaTransientByCheck[check] || 0) + failures.length;
        details.push({ check, sha, kind: 'same-sha-transient', failingRuns: failures.length });
        continue;
      }

      // Sha ended RED. Decide by the resolution SHA (generic — no check-name keying).
      const lastFailIdx = Math.max(...failures.map((r) => r.__i));
      const successBefore = runs.some((r) => r.conclusion === 'success' && r.__i < lastFailIdx);
      const successAfter = runs.some((r) => r.conclusion === 'success' && r.__i > lastFailIdx);

      // Precedence matters: test successBefore (first-green-already-reached) FIRST. A sha that
      // ended red AFTER the check first went green is a post-first-green regression EVEN IF it
      // is later re-fixed (successAfter also true) — the cycle-to-FIRST-green already completed
      // at that first green, so this must not inflate realGateFailuresBeforeFirstGreen. (If
      // successAfter were tested first it would mis-count the green->break->refix case.)
      if (successBefore) {
        // The check already went green earlier; this red is a post-first-green regression.
        // NOT a cycle-to-FIRST-green — excluded from the metric, reported separately.
        postGreenRegressions += 1;
        details.push({ check, sha, kind: 'post-green-regression', failingRuns: failures.length });
      } else if (successAfter) {
        // Never green before this sha's last failure, but green came AFTER => a new commit was
        // required. A same-sha success after the last failure would have made the terminal a
        // success, so this success is necessarily on a later sha => 'new-sha'.
        realGateFailures += 1;
        realGateFailureByCheck[check] = (realGateFailureByCheck[check] || 0) + 1;
        details.push({ check, sha, kind: 'real-gate-failure', failingRuns: failures.length, resolution: 'new-sha' });
      } else {
        // Never green for this check => unresolved real failure.
        realGateFailures += 1;
        realGateFailureByCheck[check] = (realGateFailureByCheck[check] || 0) + 1;
        details.push({ check, sha, kind: 'real-gate-failure', failingRuns: failures.length, resolution: 'unresolved' });
      }
    }
  }

  return {
    number: pr.number,
    realGateFailures,
    sameShaTransientRuns,
    postGreenRegressions,
    sameShaTransientByCheck,
    realGateFailureByCheck,
    details,
  };
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
  const postGreenTotal = perPr.reduce((n, p) => n + p.postGreenRegressions, 0);

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
    // The REFINED metric: only new-sha-resolved (or never-green) failures count toward cycles-
    // to-first-green. Same-sha transients and post-first-green regressions are excluded.
    realGateFailuresBeforeFirstGreen: realTotal,
    meanRealGateFailuresBeforeFirstGreen: prsAnalyzed ? realTotal / prsAnalyzed : 0,
    realGateFailureByCheck,
    // The flake-rate signal (NOT hidden — PD guardrail). Rising value on a code check = real.
    sameShaTransientRuns: transientTotal,
    sameShaTransientByCheck,
    // Post-first-green regressions — excluded from the metric but surfaced (own signal).
    postGreenRegressions: postGreenTotal,
    perPr,
  };
}
