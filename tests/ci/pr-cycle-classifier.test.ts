// Tests for the CI-cycles-to-green classifier pure logic (scripts/ci/pr-cycle-classifier-lib.mjs).
//
// Guards the signal-integrity invariant (devops ci-pr-cycles-to-green, 2026-07-17): a SAME-SHA
// fail->pass is a transient (PR-body/label hygiene gate self-resolving, or infra flake), a fail
// resolved only by a NEW head SHA is a REAL gate failure, and a post-first-green regression is
// excluded from cycles-to-FIRST-green. Includes the edge cases surfaced by the high-effort
// review 2026-07-17 (terminal-state, same-second tie, fail->pass->fail-ends-red, before-first-green).

import { describe, it, expect } from 'vitest'
// @ts-expect-error — pure ESM helper, no type declarations by design
import { classifyPr, classifyPrCycles } from '../../scripts/ci/pr-cycle-classifier-lib.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('classifyPr — same-SHA transient (the PR-Verification-Check body-gate case)', () => {
  it('fail then pass on the IDENTICAL sha is a transient, not a real gate failure', () => {
    // Mirrors the verified real case: sha 4f1dcc74 fail 09:11:11 -> pass 09:11:20 (body edited).
    const r = classifyPr({
      number: 1,
      commitShas: [A],
      runs: [
        { check: 'PR Verification Check', sha: A, conclusion: 'failure', createdAt: '2026-07-16T09:11:11Z', completedAt: '2026-07-16T09:11:21Z', runId: 1 },
        { check: 'PR Verification Check', sha: A, conclusion: 'success', createdAt: '2026-07-16T09:11:20Z', completedAt: '2026-07-16T09:11:31Z', runId: 2 },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(1)
    expect(r.sameShaTransientByCheck['PR Verification Check']).toBe(1)
  })

  it('multiple same-sha failures before a same-sha pass all count as transient runs', () => {
    const r = classifyPr({
      number: 2,
      runs: [
        { check: 'X', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'X', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:05Z', completedAt: '2026-01-01T00:00:07Z', runId: 2 },
        { check: 'X', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:00:10Z', completedAt: '2026-01-01T00:00:12Z', runId: 3 },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(2)
  })

  it('same-SECOND fix-and-rerun is ordered by runId, not misscored real (review finding #8)', () => {
    // Both runs share the same createdAt second; runId tiebreak must order success last => transient.
    const r = classifyPr({
      number: 3,
      runs: [
        { check: 'PR Verification Check', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:00Z', runId: 10 },
        { check: 'PR Verification Check', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:00Z', runId: 11 },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(1)
  })
})

describe('classifyPr — terminal state of the sha (review findings #2, #9)', () => {
  it('fail -> pass -> fail ENDING RED on the same sha is NOT a transient', () => {
    // Terminal run is a failure; the earlier same-sha success does not make it transient.
    const r = classifyPr({
      number: 4,
      runs: [
        { check: 'Build', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'Build', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:01:00Z', completedAt: '2026-01-01T00:01:02Z', runId: 2 },
        { check: 'Build', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:02:00Z', completedAt: '2026-01-01T00:02:02Z', runId: 3 },
      ],
    })
    expect(r.sameShaTransientRuns).toBe(0)
    // Ended red with an earlier green and no later success => post-first-green regression,
    // excluded from the before-first-green metric.
    expect(r.postGreenRegressions).toBe(1)
    expect(r.realGateFailures).toBe(0)
  })

  it('post-first-green regression on a LATER sha is excluded from cycles-to-first-green (finding #9)', () => {
    const r = classifyPr({
      number: 5,
      runs: [
        { check: 'Build', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'Build', sha: B, conclusion: 'failure', createdAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:00:02Z', runId: 2 },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.postGreenRegressions).toBe(1)
  })

  it('green -> break -> RE-FIX (success A, fail B, success C) is a post-green regression, NOT a before-first-green failure (precedence regression)', () => {
    // Regression guard for the precedence bug: first green already happened at A, so the B
    // break is post-first-green even though C re-fixes it — must NOT inflate the metric.
    const r = classifyPr({
      number: 12,
      runs: [
        { check: 'Build', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'Build', sha: B, conclusion: 'failure', createdAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:00:02Z', runId: 2 },
        { check: 'Build', sha: 'c'.repeat(40), conclusion: 'success', createdAt: '2026-01-01T02:00:00Z', completedAt: '2026-01-01T02:00:02Z', runId: 3 },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.postGreenRegressions).toBe(1)
  })
})

describe('classifyPr — real gate failure (needed a new commit)', () => {
  it('fail on sha A, green only on a later sha B is a REAL gate failure', () => {
    const r = classifyPr({
      number: 6,
      runs: [
        { check: 'Build', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'Build', sha: B, conclusion: 'success', createdAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:00:02Z', runId: 2 },
      ],
    })
    expect(r.realGateFailures).toBe(1)
    expect(r.sameShaTransientRuns).toBe(0)
    expect(r.details[0].resolution).toBe('new-sha')
  })

  it('a never-resolved failure is real and marked unresolved', () => {
    const r = classifyPr({
      number: 7,
      runs: [{ check: 'Build', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 }],
    })
    expect(r.realGateFailures).toBe(1)
    expect(r.details[0].resolution).toBe('unresolved')
  })
})

describe('classifyPr — non-failure conclusions', () => {
  it('cancelled runs are NOT failures (concurrency cancel-in-progress must not inflate)', () => {
    const r = classifyPr({
      number: 8,
      runs: [
        { check: 'X', sha: A, conclusion: 'cancelled', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'X', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:00:10Z', completedAt: '2026-01-01T00:00:12Z', runId: 2 },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(0)
  })

  it('timed_out counts as a failure', () => {
    const r = classifyPr({
      number: 9,
      runs: [
        { check: 'X', sha: A, conclusion: 'timed_out', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
        { check: 'X', sha: B, conclusion: 'success', createdAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:00:02Z', runId: 2 },
      ],
    })
    expect(r.realGateFailures).toBe(1)
  })
})

describe('classifyPrCycles — aggregate metric + flake-rate signal', () => {
  it('separates the refined green metric from the same-sha flake-rate signal', () => {
    const summary = classifyPrCycles([
      {
        number: 10,
        runs: [
          { check: 'PR Verification Check', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
          { check: 'PR Verification Check', sha: A, conclusion: 'success', createdAt: '2026-01-01T00:00:09Z', completedAt: '2026-01-01T00:00:11Z', runId: 2 },
        ],
      },
      {
        number: 11,
        runs: [
          { check: 'Build', sha: A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', runId: 1 },
          { check: 'Build', sha: B, conclusion: 'success', createdAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:00:02Z', runId: 2 },
        ],
      },
    ])
    expect(summary.prsAnalyzed).toBe(2)
    // Only PR 11's new-sha-resolved Build failure is a REAL gate failure.
    expect(summary.realGateFailuresBeforeFirstGreen).toBe(1)
    expect(summary.meanRealGateFailuresBeforeFirstGreen).toBe(0.5)
    // PR 10's body-gate fail->pass is surfaced as a flake, not hidden.
    expect(summary.sameShaTransientRuns).toBe(1)
    expect(summary.sameShaTransientByCheck['PR Verification Check']).toBe(1)
  })
})
