// Tests for the CI-cycles-to-green classifier pure logic (scripts/ci/pr-cycle-classifier-lib.mjs).
//
// Guards the core signal-integrity invariant (devops ci-pr-cycles-to-green, 2026-07-17):
// a SAME-SHA fail->pass is a transient (PR-body/label hygiene gate self-resolving, or infra
// flake) and must be EXCLUDED from the green metric but COUNTED into the flake-rate signal;
// a fail resolved only by a NEW head SHA is a REAL gate failure and counts toward the metric.

import { describe, it, expect } from 'vitest'
// @ts-expect-error — pure ESM helper, no type declarations by design
import { classifyPr, classifyPrCycles } from '../../scripts/ci/pr-cycle-classifier-lib.mjs'

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('classifyPr — same-SHA transient (the PR-Verification-Check body-gate case)', () => {
  it('fail then pass on the IDENTICAL sha is a transient, not a real gate failure', () => {
    // Mirrors the verified real case: sha 4f1dcc74 fail 09:11:11 -> pass 09:11:20 (body edited).
    const r = classifyPr({
      number: 1,
      commitShas: [SHA_A],
      runs: [
        { check: 'PR Verification Check', sha: SHA_A, conclusion: 'failure', createdAt: '2026-07-16T09:11:11Z' },
        { check: 'PR Verification Check', sha: SHA_A, conclusion: 'success', createdAt: '2026-07-16T09:11:20Z' },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(1)
    expect(r.sameShaTransientByCheck['PR Verification Check']).toBe(1)
  })

  it('multiple same-sha failures before a same-sha pass all count as transient runs', () => {
    const r = classifyPr({
      number: 2,
      commitShas: [SHA_A],
      runs: [
        { check: 'X', sha: SHA_A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z' },
        { check: 'X', sha: SHA_A, conclusion: 'failure', createdAt: '2026-01-01T00:00:05Z' },
        { check: 'X', sha: SHA_A, conclusion: 'success', createdAt: '2026-01-01T00:00:10Z' },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(2)
  })
})

describe('classifyPr — real gate failure (needed a new commit)', () => {
  it('fail on sha A, green only on a later sha B is a REAL gate failure', () => {
    const r = classifyPr({
      number: 3,
      commitShas: [SHA_A, SHA_B],
      runs: [
        { check: 'Build', sha: SHA_A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z' },
        { check: 'Build', sha: SHA_B, conclusion: 'success', createdAt: '2026-01-01T01:00:00Z' },
      ],
    })
    expect(r.realGateFailures).toBe(1)
    expect(r.sameShaTransientRuns).toBe(0)
    expect(r.details[0].resolution).toBe('new-sha')
  })

  it('a never-resolved failure is real and marked unresolved', () => {
    const r = classifyPr({
      number: 4,
      commitShas: [SHA_A],
      runs: [{ check: 'Build', sha: SHA_A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z' }],
    })
    expect(r.realGateFailures).toBe(1)
    expect(r.details[0].resolution).toBe('unresolved')
  })
})

describe('classifyPr — non-failure conclusions', () => {
  it('cancelled runs are NOT failures (concurrency cancel-in-progress must not inflate)', () => {
    const r = classifyPr({
      number: 5,
      commitShas: [SHA_A],
      runs: [
        { check: 'X', sha: SHA_A, conclusion: 'cancelled', createdAt: '2026-01-01T00:00:00Z' },
        { check: 'X', sha: SHA_A, conclusion: 'success', createdAt: '2026-01-01T00:00:10Z' },
      ],
    })
    expect(r.realGateFailures).toBe(0)
    expect(r.sameShaTransientRuns).toBe(0)
  })

  it('timed_out counts as a failure', () => {
    const r = classifyPr({
      number: 6,
      commitShas: [SHA_A, SHA_B],
      runs: [
        { check: 'X', sha: SHA_A, conclusion: 'timed_out', createdAt: '2026-01-01T00:00:00Z' },
        { check: 'X', sha: SHA_B, conclusion: 'success', createdAt: '2026-01-01T01:00:00Z' },
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
        commitShas: [SHA_A],
        runs: [
          { check: 'PR Verification Check', sha: SHA_A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z' },
          { check: 'PR Verification Check', sha: SHA_A, conclusion: 'success', createdAt: '2026-01-01T00:00:09Z' },
        ],
      },
      {
        number: 11,
        commitShas: [SHA_A, SHA_B],
        runs: [
          { check: 'Build', sha: SHA_A, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z' },
          { check: 'Build', sha: SHA_B, conclusion: 'success', createdAt: '2026-01-01T01:00:00Z' },
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
