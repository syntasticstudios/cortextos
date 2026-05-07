# Batch 5+6 Phase Tracker — B2B Flow + Admin Shadow + Polish
Created: 2026-05-07T18:05Z | Updated: 2026-05-07T20:05Z (evening merge wave)
Total: 24 tasks across 3 phases (~3 weeks)

## PHASE 1 — Foundation (this weekend, ETA 3-4 days)
| Task | Owner | Status | Depends On | Task ID |
|------|-------|--------|------------|---------|
| ADMIN-SHADOW-01 Schema + Tab-Struktur | backend-architect | PR #533 OPEN | — (FOUNDATION) | task_1778177142118_970 |
| B2B-03 Email-Template + PDF | frontend-dev | PR #535 OPEN (P1 fixes pushed) | — | task_1778176957261_944 |
| B2B-02 Email-Trigger Backend | backend-architect | ✅ MERGED #536 (19:47 UTC) | B2B-03 + SHADOW-01 | task_1778176957342_271 |
| UPLOAD-03 Image-Upload Convex | backend-architect | PR #534 OPEN | — | task_1778176957419_160 |
| POLISH-04 E2E Patient-Funnel | frontend-dev | DISPATCHED | — | task_1778176957489_020 |

## PHASE 2 — Core B2B Loop (Week 2, ETA 5-7 days)
| Task | Owner | Status | Depends On | Task ID |
|------|-------|--------|------------|---------|
| B2B-01 Hersteller-Bestellungen Page | frontend-dev | ✅ MERGED #538 (19:38 UTC) | B2B-02 | task_1778176965922_102 |
| ADMIN-SHADOW-03 Admin Order on-behalf | frontend-dev | PR #543 OPEN (P1 fixes pushed) | B2B-01 + SHADOW-01 | task_1778177142245_766 |
| B2B-04 Status-Workflow + Live-Sync | backend-architect | PR #537 OPEN (5/5 ✅ merge-ready) | B2B-01 + B2B-02 | task_1778176965988_277 |
| UPLOAD-01 Hersteller Upload UI | frontend-dev | PENDING | UPLOAD-03 | task_1778176966052_668 |
| UPLOAD-02 Superadmin on-behalf Upload | frontend-dev | PENDING | UPLOAD-01 | task_1778176981055_151 |
| ADMIN-SHADOW-02 Email-Routing Fallback | backend-architect | ✅ INCLUDED IN B2B-02 (#536) | B2B-02 + SHADOW-01 | task_1778177142180_579 |
| INVOICE-01 B2B-Invoice Auto-Gen | backend-architect | PR #539 OPEN | B2B-04 | task_1778176966116_115 |

## PHASE 3 — Admin Power + Polish (Week 3, ETA 7-10 days)
| Task | Owner | Status | Depends On | Task ID |
|------|-------|--------|------------|---------|
| ADMIN-SHADOW-04 Hersteller-Inbox | frontend-dev | ✅ MERGED #542 (20:02 UTC) | SHADOW-01 | task_1778177142307_078 |
| ADMIN-SHADOW-05 Bulk CSV-Import | frontend-dev | PENDING | SHADOW-01 | task_1778177142369_287 |
| ADMIN-SHADOW-06 Statement Admin-View | frontend-dev | PENDING | INVOICE-01 | task_1778177142434_565 |
| ADMIN-SHADOW-07 Audit-Log | frontend-dev | PENDING | SHADOW-01 | task_1778177142505_672 |
| B2B-05 Apotheke Status-Sicht | frontend-dev | PENDING | B2B-04 | task_1778176980792_314 |
| POLISH-01 Empty-States | frontend-dev | ✅ MERGED #532 (19:37 UTC) | — | task_1778176980860_095 |
| POLISH-02 Notification-Bell | frontend-dev | PENDING | — | task_1778176980923_618 |
| POLISH-03 Insights Detail-Pages | backend-architect | PENDING | — | task_1778176980985_742 |
| UPLOAD-04 Approval-Workflow | backend-architect | PENDING | UPLOAD-01 | task_1778176981123_924 |
| INVOICE-02 Mahnwesen 3-Stufen | backend-architect | PENDING | INVOICE-01 | task_1778176981187_882 |
| POLISH-05 Animation-Pass | frontend-dev | PENDING | stable base | task_1778176981251_641 |
| INVOICE-03 Monthly-Statement | backend-architect | PENDING | data accumulation | task_1778176981312_242 |

## Summary
- **Merged**: 5/24 (B2B-01, B2B-02, SHADOW-02 incl, SHADOW-04, POLISH-01)
- **Open PRs**: 6 (#533, #534, #535, #537, #539, #543) — awaiting Greptile review
- **Pending**: 13 tasks not yet started
- **Blocker**: #533 (SHADOW-01 foundation) still open — multiple Phase 2/3 tasks depend on it

## Escalation Rules
- Phase 1 task stuck >2 days → escalate to user with specific blocker question
- Demo URL + screenshot per feature when Phase 1 complete
- Daily 18:00 Telegram digest: phase progress (X/N), foundation status, blockers

## Progress Log
- 2026-05-07 18:05 UTC: Batch 5 — 17 tasks created. Phase 1 dispatched.
- 2026-05-07 18:15 UTC: Batch 6 — 7 ADMIN-SHADOW tasks added. SHADOW-01 dispatched URGENT to backend-architect (foundation). Phase tracker merged. Total: 24 tasks.
- 2026-05-07 20:05 UTC: Evening merge wave — 4 PRs merged (#532 POLISH-01, #536 B2B-02, #538 B2B-01, #542 SHADOW-04). Also #540/#541 bug fixes merged. 6 PRs still open. Greptile may have recovered for some PRs. frontend-dev pushed P1 fixes on #535/#537/#543.
