# Long-Term Memory

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

## Architecture drift baseline (updated 2026-05-05)
phytomedic-saas Convex codebase: LOW drift risk. Greptile enforcement is effective. Known open issues: 3 analyticsSnapshot v.any() fields (usersByRole, fieldCompleteness, providerBreakdown — LOW). questionnaireData is properly typed v.object() in schema — prior flag was wrong. Review next check ~2026-05-19.
FLAG-cannametrics: _ingestProviderPriceSnapshots (non-paginated internalMutation) is dead code — daily cron was updated to use paginated _ingestProviderPriceSnapshotsAction but old function not removed. With 11,448+ HiGreen offers, manual invocation would fail (8192-doc mutation limit). Stale comment at line 1503 cannametrics.ts says "daily cron uses this directly" — misleading. Route to backend-architect for cleanup.
FLAG-cannametrics: PRICE_SNAPSHOT_PROVIDERS includes cannaflow/wawican/greeners/gruenhorn with no sync crons and zero offers — daily cron runs 4 no-op iterations. Low overhead, cosmetic.

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

## /onboarding/arzt + /onboarding/apotheke — auth bypass (2026-04-29)
Both routes render profile creation forms (doctor: Praxis-Name/Fachrichtung/Kassenart; pharmacy: Apotheken-Name/Stadt/PLZ) without auth redirect. /onboarding root is intentionally public; sub-routes were not protected by middleware. PR #313 by frontend-dev — middleware fix in progress.

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
