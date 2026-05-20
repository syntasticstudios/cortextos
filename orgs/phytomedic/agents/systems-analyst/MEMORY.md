# Long-Term Memory

## Phase 1 Batch 5+6 complete (2026-05-08)
PRs #541-#550 all merged 2026-05-07. ADMIN-SHADOW-03/04, B2B-01-05, UPLOAD-03, COST-01, MOBILE-02, BUG-P0-05 (compliance snapshot), GoBD invoice sequence fix, quality graduation P0-05/P1-13. Phase tracker update needed by platform-director.

## Known heartbeat registry artifact (2026-05-08)
"objective-mclaren" appears as a STALE entry in the heartbeat registry — it is a leftover watchdog from an old session, not a real agent. Do NOT alert on it. Confirmed by platform-director.

## Onboarding Context — 2026-04-12

### What "healthy" means for PhytoMedic
A healthy system is one where work moves toward three outcomes:
1. Data foundation is being built correctly from day one, especially for Cannametrics
2. Pharmacy-side utility is emerging early, not just doctor-side workflow completion
3. Patient-doctor-pharmacy care and supply loop becomes operationally real and scalable

### Monitoring focus areas
A. Agent system health (heartbeat, completion, latency, blocks, stalls)
B. Goal alignment with North Star (pharmacy-centered value, Cannametrics readiness, e2e execution)
C. Quality of outputs (decision-useful, commercially aware, structurally sound, reusable)
D. Cannametrics data-foundation integrity (catalog, availability, price history, routing, snapshots, analytics readiness)
E. Coordination layer performance (briefing quality, approval routing speed, goal cascade alignment)

### Baseline metrics already approved for tracking
- Briefing quality
- Approval routing speed
- Goal cascade alignment

### Alert escalation model
- Operational issues → platform-director first
- Strategic / critical → both platform-director and user
- User = decision/exception channel, not operational channel
- Do not alert user for normal noise or single-agent delays

### Obsidian vault
- Strategic knowledge layer, not runtime truth
- Monitor for freshness, drift, divergence
- Auto-ingest shared-core content only
- Never ingest restricted-exec or blocked-never-ingest content

### KB ingestion labels
- shared-core: architecture, scope maps, roadmap, runbooks, baselines, incident history, integration notes, agent rules, strategy summaries
- restricted-exec: orchestrator-mediated summaries only
- blocked-never-ingest: secrets, patient data, financial records, raw dumps, certificates, build artifacts

### Upstream update safety filter (set 2026-04-12)
Apply automatically: reliability fixes, monitoring/logging improvements, dashboard QoL, operational stability
Queue for explicit approval: anything touching governance, approval logic, strategic prioritization, autonomy rules, architecture direction, data-model direction

### Agent scaling policy (set 2026-04-12)
- Start lean. No agent sprawl before real task throughput is visible.
- Current team: platform-director, systems-analyst, backend-architect, integrations-routing (pending), cannametrics-data (pending)
- Next likely additions: compliance-security, frontend-product
- Everything else waits for stronger activity data and clearer workload patterns

### Fleet restart cadence baseline (set 2026-04-17)
- 71-hour --continue auto-restart cycle is the expected cadence. Multiple fleet-wide restarts in a short window (e.g. 6 in ~110 min) is normal when agents converge on the session cap.
- Do NOT flag this as an anomaly unless frequency materially increases above this baseline or restarts correlate with crash signatures.
- Confirmed by platform-director on 2026-04-17 in response to a heartbeat observation.

## orders.prescriptionId — FIXED via caseId join (2026-04-29)
PR #279 by backend-architect. listAllOrders/listOrdersByPatient/listOrdersByPharmacy now resolve prescriptionId via orders.caseId → cases join. The field was never written directly to orders (structural gap); fix applies the correct two-hop join at query layer. Analytics prescription-product linkage now functional. Task task_1777374982881_039 closed.

## Health check endpoint — known false negatives (2026-04-29)
/api/health/integrations has two false negatives: (1) Clerk check hits api.clerk.com/v1/jwks (auth required) → always 401. (2) Cannaleo check looks in Next.js env — key lives in Convex env only. Both cause "degraded" status despite services being operational. Fix task: task_1777456591118_868 → backend-architect (LOW). Cannaleo sync health confirmed by cannametrics-data via Convex dashboard.

## HiGreen recovery (2026-04-29)
HiGreen was down ~5 days (last sync ~2026-04-24). Recovered 2026-04-29 — 5,704 offers synced. Circuit breaker auto-reset after probe succeeded. HUMAN verify task (task_1777104868827_831) closed. Monitor next 07:00/19:00 UTC cron cycles to confirm sustained recovery.

## Architecture drift baseline (updated 2026-05-06)
phytomedic-saas Convex codebase: LOW drift risk. Greptile enforcement is effective. Known open issues: 3 analyticsSnapshot v.any() fields (usersByRole, fieldCompleteness, providerBreakdown — LOW). questionnaireData is properly typed v.object() in schema — prior flag was wrong. Review next check ~2026-05-20.
RESOLVED: _ingestProviderPriceSnapshots dead code — function no longer exists in cannametrics.ts (confirmed 2026-05-06). Prior flag closed.
FLAG-cannametrics (cosmetic): PRICE_SNAPSHOT_PROVIDERS still includes cannaflow/wawican/greeners/gruenhorn with no sync crons and zero offers — 4 no-op cron iterations daily. Low overhead, no action needed unless cron cost becomes a concern.
Recent PR safety check (PRs #436, #437, #438, #439): No new v.any() fields, no new unbounded .collect() in hot-path code. clearZeroPriceOffers (PR #439) uses paginate correctly. All .collect() in migrations.ts are pre-existing small-table migrations (doctorProfiles, articles).

## BUG-PROD-09/10 — RESOLVED (2026-05-05, PR #398)
BUG-PROD-09: Pharmacy URL numeric-suffix removal — cleanPharmacySlugs migration ran 2026-05-05 ~17:07 UTC: 323 updated, 1 skipped (already normalized), 324 total. All URLs now {name}-{city} format. Old numeric-suffix URLs auto-redirect via permanentRedirect in getPublicPharmacyBySlug. FULLY RESOLVED.
BUG-PROD-10: Apotheken-Detail Top-Sorten section — getTopProductsByPharmacy query deployed. Sorts available offers by THC% desc, returns top 6. Empty state renders correctly when pharmacy has no mapped offers. Follow-up fix fa029fd: considers all available products before sorting (not just first 18). Verified via code review.

## PR #400 COHERENCE-2-01/02 — MERGED (2026-05-05, 16:59 UTC)
Cultivar plain text fallback (product-hero.tsx: span when no strainSlug) + strain→catalog CTA (strains/[slug]/page.tsx: genetics-filtered CTA section with h2 heading). Greptile 4/5 — a11y finding (p→h2) fixed in commit 3f0347fc before merge.

## insertRoutingEvent — VERIFIED COMPLETE (2026-04-28)
Wired in 8 call sites: checkout.ts, submitPrescriptionToCannaleo.ts (×4), processWebhook.ts, cases.ts, orders.ts. Goal #2 from goals.json confirmed done.

## Pharmacy map geodata — COMPLETE (2026-04-29)
GOOGLE_GEOCODING_API_KEY set in Convex env. geocodePharmacyBatch ran — 316/316 pharmacies geocoded. Pharmacy map pin coverage is now full. PR #277 (Karte tab re-enable) pending merge. PR #281 contains geocoding action code.

## PR #311 — 13 unbounded .collect() take limits fixed (2026-04-29)
backend-architect added .take() limits to 13 user-facing Convex queries. Previously these were unbounded — could return arbitrarily large result sets. Now capped. Merged to main. Important security/performance fix.

## Open PRs as of 2026-04-29 ~20:35 CEST
- fix/product-imageurl-null: REOPEN-QA-01 — HiGreen imageUrl fix + prevent sync clearing existing images + checkout staleness guard fix. Active.
- fix/price-snapshot-pagination: backfillPriceSnapshots redesign — paginates _ingestProviderPriceSnapshots to fix 32k read limit. Active (cannametrics-data).
- feat/design-polish-p1-p2: P1+P2 monochromatic design polish pass. Active.

## /onboarding/arzt + /onboarding/apotheke — auth bypass RESOLVED (2026-04-29, verified fixed 2026-05-06)
Both routes now redirect to accounts.phytomedic.de/sign-in (Clerk auth). PR #313 middleware fix confirmed live 2026-05-06.

## backfillPriceSnapshots — redesign in progress (updated 2026-04-29)
Original run times out. cannametrics-data redesigning for smaller batches. Apr 15-28 price snapshot gap persists until redesign complete + run. Task: task_1777450660264_986 (pending, blocked on redesign).

## Doctor finder — doubled Dr. med. prefix (discovered 2026-04-29)
All 5 doctor cards on /medizin/arzt-finden show "Dr. med. Dr. med. [Name]" — stored name already includes title prefix, component template adds it again. Affects h1, h2, h3, breadcrumb, page <title>. Task: task_1777447971774_670 → frontend-dev (HIGH).

## PR #272 fix/legal-pages — Greptile P1, blocked (2026-04-29)
Legal texts still reference cannabis-aerzte.de (not PhytoMedic). Missing GDPR sections §9, §14-22, §24, §26, §28-30. Score 2/5. ESLint error auto-fixed (commit 1e444ce). Cannot merge until legal content is reviewed and rebranded. User alerted.

## HiGreen pricing — FULLY RESOLVED (2026-05-05, PR #377, commit 8fff1ae)
Root cause: HiGreenPrice.pharmacy typed as `string` but API sends `{id: string, name: string}` object → transformer produced `hg_[object Object]` pharmacy IDs → prices[] silently skipped since launch. Fix: types.ts HiGreenPharmacyRef union type, transformer resolvePharmacyRef()/resolvePharmacyName() helpers at all 5 sites, cleanupHiGreenObjectOffers migration (7 iterations, 1384 ghost offers deleted). Final state: 5724 offers / 4 real pharmacies / priceCentsGross populated. Snapshot coverage: Cannaleo 7/7, HiGreen 1/7 (May 5 baseline — Apr 29-May 4 unrecoverable, offers didn't exist). Daily cron captures HiGreen from May 6 onwards. Also: PR #374 fixed daily snapshot cron (Convex 32k read limit).

## HiGreen offer pipeline — FIXED (2026-05-05)
PR #373: price.pharmacy_id field mismatch (API sends price.pharmacy). Zero offers had been ingested since launch. After fix + cleanup: 1,384 products / 11,448 availability offers / 0 errors. Offer pipeline healthy. Separate issue: prices[] also present but skipped due to nested pharmacy object bug (see above).

## Price snapshot backfill — Cannaleo recovered (2026-05-05)
PR #374 fixed daily snapshot cron (Convex 32k read limit). Backfill run: Cannaleo 7/7 dates (Apr 29-May 5) recovered. HiGreen 0/7 pending code fix in transformer.ts (see HiGreen pricing bug above).

## terpeneData Array guard fix — RESOLVED (2026-05-05)
getPublicProductsForFilter (introduced in PR #397 squash, commit 013153d) lacked Array.isArray guard on terpeneData. Products with legacy non-array terpeneData crashed the entire query. Fix: f6a48e9 by backend-architect — Array.isArray(p.terpeneData) ? p.terpeneData : []. Lesson: any Convex query mapping over nested arrays needs Array.isArray guard for legacy data safety. Verified 16:23 UTC.

## BUG-CATALOG-01 — FULLY RESOLVED (2026-05-05, post-correction)
Root cause: fp:/fp: identity collision (two DB docs per productIdentity hash — one with manufacturerKey set, one null). Fix: PR #388 diagnosis + PR #391 OCC-resilient migration. Migration ran 2026-05-05 ~12:00 UTC: 1358 groups processed, 2323 deactivated, 223 offers redirected, 7887 offers dropped, skipped=0.
SECONDARY ISSUE: migration over-deactivated 2 products (Bediol, Bedrocan 25/1) — both fp: twins had manufacturerKey=null, no keeper selected, both deactivated. backend-architect ran reactivateBedrocanProducts: 3 reactivated (Elida=Bediol, Afina=Bedrocan 25/1, Rensina), 9 true orphans skipped (no offers). Bedrocan filter now shows 6 products: Bedica 14/1, Bediol, Bedrocan 22/1, Bedrocan 25/1, Bedrobinol 14/1, Bedrocan Forte 25/1. Verified by platform-director 2026-05-05 ~12:30 UTC. BUG-CATALOG-01 fully closed.

## HUNT-20260428-01 strain-product linkage — FULLY RESOLVED (2026-04-29)
PR #281 by backend-architect. upsertProduct now slug-matches cultivar against strains on every sync. backfillStrainLinkage ran 2026-04-29 — 292 products linked. "Produkte mit dieser Sorte" on strain detail pages now shows correct results.

## Doctor finder doubled Dr. med. prefix — RESOLVED (2026-05-05)
task_1777447971774_670 closed. PR #392 commit 6f9b6fa in main — MEDICAL_TITLE_RE guard in formatDoctorName prevents prefix duplication. Verified clean on prod 2026-05-06: 5 doctors, 0 doubled prefixes.

## Wissen markdown rendering — RESOLVED (2026-05-06, PR #414 merged)
Raw markdown chars (#, ##, **, -) in /wissen/ article body were rendering as literal text. Fix: renderContent loop with renderInline helper for ATX headings, bold/italic, lists. Safety: safeExternalUrl/safeInternalPath utilities reused for href validation (data: and javascript: blocked). HUNT-20260506-01 closed.

## Checkout step labels — RESOLVED (2026-05-06, PR #415 merged)
Long German step labels (e.g. "Ausweisprüfung") clipped by `truncate` class — replaced with `break-words` within 56px column. 5/5 Greptile.

## Lineage grandparents — RESOLVED (2026-05-06, PR #410 merged)
SVG lineage graph extended with grandparent row (dashed edges, 75% opacity). Data fetched via skippable useQuery on deduplicated parentStrainIds. Backwards-compatible. 4/5 Greptile.

## Schlafstörungen seed dedup — RESOLVED (2026-05-06, PR #412 merged)
Seed slug normalized from "schlafstörungen" to "schlafstorungen" matching post-migration DB record. Prevents idempotency check miss and re-insertion on cold deploys. 4/5 Greptile.

## BUG-COHERENCE-01 — filed (2026-05-06)
Some products on /medizin/strains/amnesia-haze link using raw Convex document IDs (ph78d...) instead of clean slugs. Same products appear with fp: slugs in catalog. Root cause (cannametrics-data 2026-05-06): Convex _id stored as slug (32-char alphanumeric like ph78d...). catalog.ts:1795 upsert guard (`existing.slug ? {} : { slug }`) skips any truthy slug — corrupt slugs never overwritten by backfill. Fix: migration to find slug matching /^[a-z0-9]{32}$/ and regenerate via productSlug(). task_1778049814096_104 → backend-architect.

## PR merge wave complete — 2026-05-06 08:43 UTC
All PRs merged this session (#409-#427, 16 total). Key outcomes:
- P0-04 security fix (protocol-relative URL bypass): LIVE in production via PR #421
- BUG-COHERENCE-01 corrupt slug migration: MERGED (PR #417). Run backfillCorruptProductSlugs via Convex dashboard.
- Schlafstörungen DB dedup: MERGED (PR #427, includes product slug patching + Set dedup). Run deduplicateSchlafstorungen via Convex dashboard.
- Pharmacy detail info hierarchy (BUG-PROD-14): MERGED PR #411 + PR #426
- stripeReconciler auth fix (P0-03): MERGED PR #422
- W21 quality cycle complete: P0-04 graduated, lint-rules cleaned up (PR #424)

## PR #436 — MERGED (2026-05-06 ~12:36 UTC)
fix(checkout): honor offerId URL param + fix offer-selection logic. Three-tier priority: exact offerId → pharmacyId → cheapest. Stale-closure dep fix for useMemo. Greptile 4/5. NOTE: Convex embedded offer objects may not carry `_id` — the offerId exact-match branch may silently no-op; fallback chain still correct. Route to backend-architect for follow-up verification.

## PR #439 — MERGED (2026-05-06 ~12:34 UTC)
fix(sync): treat Cannaleo price_gross=0 as no-price; clear existing zeros (COHERENCE-10-01). normalizePrice now returns undefined for num<=0. clearZeroPriceOffers paginated migration added. Greptile 5/5. PENDING: run clearZeroPriceOffers via Convex dashboard.

## PENDING CONVEX DASHBOARD ACTIONS (2026-05-06)
1. ~~internal.functions.migrations.deduplicateSchlafstorungen~~ — DONE 2026-05-06 ~09:50 UTC (deleted=1, verified prod clean)
2. internal.functions.catalog.backfillCorruptProductSlugs — fixes Convex ID and fp: slugs in products table (from PR #417)
3. internal.functions.migrations.clearZeroPriceOffers — backfills existing price_gross=0 offers to undefined (from PR #439)

## React #418 pattern on apotheke-finden — RESOLVED (2026-05-07, PRs #474–#478)
5 fix PRs merged across 6 iterations. VERIFIED FIXED 2026-05-07T06:01 UTC (dpl_6HenuX7tHt7x6Z1FvLZ2ofW4WbLs).
Fixes: (1) Radix Tabs useId() #474, (2) Radix Select useId() #475, (3) usePreloadedQuery dual subscription #476, (4) suppressHydrationWarning header #477, (5) useQuery "skip" guard when !hasMounted #478
Root cause: Convex worker delivers cached subscription data via MessagePort before React hydration completes → useState initializer sees different value SSR vs client → #418.
LESSON: The shared Convex chunk (4fa395d360c87cc3.js) never changed hash — bug appeared to be in shared code but was actually a timing race. Previous test failures were from persistent Playwright session Convex worker cache delivering fast. Fresh session = no race. Guard ALL useQuery calls with "skip" when !hasMounted on pages using Clerk+Convex providers.

## Coherence audit Cluster 2 (Pharmacy ↔ Products) — VERIFIED CLEAN (2026-05-06)
Pharmacy → Products: "Alle ansehen →" + "Produkte ansehen" both filter by ?apotheke= slug. Products → Pharmacy: all 5 pharmacy links on product detail pages work. No NaN/undefined. Trust badge absent (correct — no isVerified field in schema, gated by PR #411).

## Sweep testing methodology (added 2026-05-12)
1. Fill React inputs via Playwright fill() only — never JS element.value + dispatchEvent (bypasses React state)
2. Check for checkboxes via `input[type="checkbox"], [role="checkbox"]` — Clerk/Radix use ARIA pattern not native inputs
3. Result: 2 Batch 1 false positives caught and closed by frontend-dev

## Date-boundary memory rolls — lesson 2026-05-19

When the local clock crosses midnight but UTC has not yet, do NOT roll the memory file. Always use UTC for the filename (`date -u +%Y-%m-%d`) AND always append (`>>`) unless explicitly creating a NEW file for a NEW UTC day. The truncate-vs-append distinction matters most at date boundaries when context bias suggests "new day, new file".

Specific failure mode (2026-05-19 22:04 UTC): system reminder said "today is now 2026-05-20" because local was 00:02 CEST. I treated the new day as already started and used `cat > $TODAY.md` (truncate). `date -u +%Y-%m-%d` was still 2026-05-19, so $TODAY resolved to 2026-05-19. Existing file with full day's session log was clobbered. Reconstructed from hunt-log + coherence-log + obsidian vault + bus event log — but ~hours of chronological detail (heartbeat timestamps, monitor pulses) was lost.

Safe pattern at date boundaries:
1. `TODAY=$(date -u +%Y-%m-%d)` (NOT local time)
2. `[ -f "memory/$TODAY.md" ] && echo "exists, appending" || echo "creating new"`
3. ALWAYS use `>>` unless this is the very first write to a fresh file
4. The system reminder about "new day" reflects local time; trust `date -u` for filenames
- [deployment-guard: use gh pr checks not statusCheckRollup](feedback_deployguard_current_state.md) — `gh pr list --json statusCheckRollup` returns ALL historical check_runs including re-cleared fails; only `gh pr checks <num>` returns current state. Caught 2026-05-20 12:00 UTC — initially flagged 4 PR fails, 2 were already green via re-run.
