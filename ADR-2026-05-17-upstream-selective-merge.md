# ADR 2026-05-17 — Upstream selective merge (reliability-only cherry-pick)

**Status:** Accepted
**Date:** 2026-05-17
**Authors:** A. Arndt + objective-mclaren agent

## Context

Our fork of `cortextos` (branch `claude/objective-mclaren`) had diverged from `upstream/main` by **105 commits**. A full merge produced 6+ conflicts across daemon/cli core files and would have introduced four substantial feature streams in a single sweep:

- Phase 5 external persistent crons (~30 commits, daemon-owned scheduler rewrite)
- ctx-watchdog handoff system (Tier 1/2/3, hard-restart watchdog, .force-fresh pre-arm)
- Hermes runtime + CodexPTY adapter + import-agent CLI
- Whisper-CLI voice transcription + agentic CRM template + security agent template

Per our policy *"auto-apply reliability fixes, queue structural changes for approval"* (MEMORY.md), a full merge was rejected.

## Decision

Cherry-pick **reliability-only commits** onto a separate branch (`upstream/reliability-cherry-picks-2026-05-17`). Feature commits explicitly deferred for a later, scoped feature-branch merge with its own test plan.

### Resolution rule

1. Each commit picked individually (no blind file-take).
2. Clean apply → accept.
3. Conflict → abort that pick; document why (almost always: depends on a skipped feature).
4. Local patches win on ambiguity. Upstream wins only if unambiguous bugfix.

### Cherry-picked (12)

| New SHA | Upstream SHA | Title |
|---|---|---|
| 3f26aa7 | ac7fb9e | fix(pty): rotate stdout.log at 50 MB (#175) |
| 0cfc906 | 5f1943e | fix(telegram): HTML parse mode — eliminates silent drops (#181) |
| d7e3523 | 33bcec3 | fix(cli): invert 1M-context default — opt-in 200K (#201) |
| 162134f | 3420b5b | fix(test): relative timestamps in channels route test (#226) |
| 3a24bb9 | 3d7481a | fix(kb): bump ingest timeout + retry Gemini 503s (#309) — **fixes our KB ETIMEDOUT issue** |
| 9498640 | fae9d85 | fix(metrics): exclude info/warning severity from errors_today (#266) |
| 25a600a | 8150ee0 | fix(bus): reduce observability noise (heartbeats/events) (#242) |
| 47e8861 | 534a386 | fix(dashboard): atomic CSRF refetch defeats StrictMode mount-race (#255) |
| 9a542b7 | 7fa7414 | fix(daemon): emit telegram_received bus event (#267) |
| 7a868fd | c67e8de | fix(pty): preserve Windows path-expansion env vars (#268) |
| 5aa92ba | 12210ba | fix(dashboard): suppress hydration warning on `<body>` (#333) |
| b9ec27e | f8eec59 | fix(task): bump random suffix 3→8 digits — ID-collision flake (#385) |

### Deliberately skipped — conflicts (4)

| Upstream SHA | Title | Reason |
|---|---|---|
| 8bfe90f | fix(daemon): clamp session timer to int32 (#282) | Conflicts in `src/types/index.ts` + dashboard cron test — depends on Phase 5 cron types we skipped |
| d3af405 | fix(dashboard): hoist key onto Fragment in workflows row map (#324) | Conflicts in `dashboard/.../workflows/page.tsx` — file is part of Phase 5 cron dashboard rewrite |
| a9d471f | docs(agent-management): hook reload lifecycle (#323) | References `community/agents/security/` — template we don't have |
| cc9abb1 | docs(templates): update-heartbeat clarification (#307) | Conflicts in `templates/hermes/HEARTBEAT.md` — Hermes runtime not adopted |

### Deliberately skipped — feature scope (~90 commits)

- **Phase 5 external persistent crons** (~30 commits): daemon-owned scheduler, crons.json migration, dashboard cron CRUD, history viewer, fleet-health, test-fire button, full E2E backtesting
- **ctx-watchdog handoff system**: Tier 1 Telegram warning, Tier 2 .force-fresh pre-arm, Tier 3 force-restart, context-aware handoff doc, circuit-breaker persistence
- **Hermes agent runtime** + agent template
- **CodexPTY adapter** + codex-app-server runtime parity (#322, #369)
- **Whisper-CLI voice transcription** wiring (#384)
- **import-agent CLI** — cortextos-single upgrade path (#344)
- **Community templates**: agentic CRM assistant (#401), security agent
- **Hooks framework** (#272) and related crash-alert hook (#298)
- **Self-healing watchdog scripts** (#327) — opt-in only, deferred
- **telegram_polling config flag** (#297) — would add new config per agent, deferred

## Consequences

### Positive
- Zero new features, zero new configs introduced. Behavior identical except for fixed bugs.
- KB-ingest ETIMEDOUT issue (4× consecutive failures) addressed by `3d7481a`.
- Future merges become easier: 12 commits closer to upstream.
- Each fix isolated and revertible.

### Negative / debt
- We are still ~93 commits behind upstream. The four feature streams must be evaluated separately.
- Phase 5 cron rewrite is the largest debt — touches daemon core and dashboard. Deferred decision needed.
- ctx-watchdog handoff would obsolete our local `.force-fresh` marker workaround. Worth a focused look.

## Verification

- `npm run build`: ✅ clean (tsup, 41 ms)
- `npx tsc --noEmit`: ✅ clean (0 errors)
- `npm test`: ✅ 44/44 test files, 652/652 tests passed (15.3 s)
- Lint: implicit via tsc; project has no separate lint command at root

## Follow-up

1. Open feature-branch ADRs for:
   - Phase 5 crons (high value, high scope)
   - ctx-watchdog handoff (replaces our `.force-fresh` workaround)
2. Re-run this exercise quarterly to prevent drift compounding.
