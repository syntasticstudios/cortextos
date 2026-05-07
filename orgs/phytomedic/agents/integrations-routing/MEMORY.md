# Long-Term Memory

## Duplicate Transformer Risk (discovered 2026-04-24)

`convex/lib/providerRegistry.ts` contains INLINE COPIES of all provider transformers and types. This is a separate file from `src/lib/providers/`. Fixes applied to one are NOT automatically reflected in the other. PR #101 fixed the HiGreen transformer in `src/lib/providers/higreen/transformer.ts` but missed the Convex internal copy — causing all HiGreen products to have imageUrl=null for weeks. Always update BOTH when fixing provider transformer bugs.

## Integration Layer Architecture (discovered 2026-04-12)

### Two Codebases
- **cannabis-aerzte-de** (`/Users/arndt/cannabis-aerzte-de/`) — Legacy SPA. Express backend + background workers. Cannaleo and HiGreen are the active providers. Multi-provider routing via `server/services/provider-router.ts` with 5-tier channel resolution. Sync system uses pharmacy-scoped batching with rate limiting. Stripe webhook handling with claim-before-process pattern. Background Worker jobs preferred over Express for sync.
- **phytomedic-saas** (`/Users/arndt/phytomedic-saas/`) — Next.js SSR + Convex backend. Full provider adapter layer in `src/lib/providers/` with 6 providers: cannaleo, higreen, greeners, wawican, cannaflow, gruenhorn. Store-first webhook pattern (return 200 immediately, async process). Idempotency via externalEventId + source dedup. Normalization: prices in cents, THC/CBD as %, PZN-primary product identity. Convex schema covers products, offers, providerRecords, pharmacies, webhookEvents, syncLog, orders, prescriptions, cases.

### Providers — Current State
| Provider | SPA (legacy) | SSR (new) | Auth | Notes |
|----------|-------------|-----------|------|-------|
| Cannaleo | Active, full integration | Adapter exists | JWT/API-KEY | Primary provider. Has state machine for orders. Pharmacy lookup, catalog, prescriptions. |
| HiGreen | Active, full integration | Adapter exists | Basic Auth (catalog) + API-Key (orders) | Requires hardcoded pharmacy data mapping. Minimal API pharmacy data. |
| WaWiCan | Not present | Adapter exists | Unknown | New in SSR |
| Greeners | Not present | Adapter exists | Unknown | New in SSR |
| Cannaflow | Not present | Adapter exists | Unknown | New in SSR |
| Gruenhorn | Not present | Adapter exists | Unknown | New in SSR |

### Key Patterns
- **Multi-provider routing**: pharmacy_channels table links 1 pharmacy to N providers. Provider selection by channel priority with fallback.
- **Cannaleo state machine**: Order lifecycle (pending → submitted → accepted → completed etc.) tracked via state machine in both codebases.
- **Store-first webhook**: SSR pattern — store event, return 200, process async. Legacy uses claim-before-process.
- **Product identity**: PZN as primary key, fallback hash of normalized fields for dedup.
- **Normalization rules**: prices → cents, THC/CBD → %, category → [flowers|extracts|equipment|other], genetics → [indica|sativa|hybrid|unknown].
- **No inbound webhooks from Cannaleo/HiGreen detected in legacy** — push providers only (we call them, they don't call us) except for Cannaleo callbacks in SSR (`src/app/api/webhooks/cannaleo/route.ts`).
- **Sync lock mechanism** in legacy prevents concurrent syncs.
- **Batch sync**: pharmacy-scoped, rate-limited (100ms delay), failure threshold monitoring (10%).

### Documentation Locations
- SSR integration docs: `/Users/arndt/phytomedic-saas/docs/integrations/` — provider-registry.md, cannaleo.md, higreen.md, wawican.md, gruenhorn.md, cannaflow.md
- Legacy API docs: `/Users/arndt/cannabis-aerzte-de/docs/HIGREEN_API.md`, `CANNALEO_API.md`
- Legacy data flow: `/Users/arndt/cannabis-aerzte-de/docs/CATALOG_DATAFLOW.md`, `SYNC_SYSTEM_STATUS.md`
- SSR provider adapters: `/Users/arndt/phytomedic-saas/src/lib/providers/`
- Legacy provider code: `/Users/arndt/cannabis-aerzte-de/shared/cannaleo/`, `shared/higreen/`
- Legacy router: `/Users/arndt/cannabis-aerzte-de/server/services/provider-router.ts`

### Key Config
- Cannaleo: TEST=api.curobo.de, LIVE=api.cannaleo.com. API-KEY header auth.
- HiGreen: test.higreen.de / higreen.de. Basic Auth for catalog, API-Key for orders.
- SSR env: CANNALEO_API_KEY, CANNALEO_ENV, CANNALEO_CALLBACK_SECRET, APP_PUBLIC_BASE_URL

## 2026-04-24 — Context compaction recovery pattern
- Linter reverts working tree files after commits; PR branch commits remain correct (confirmed on PRs #210, #211, #220)
- Cron gap warnings are expected on session restart — they clear once the cron fires; verify with CronList before restoring
- `cortextos bus create-approval` category must be "other" not "experiments"
- Autoresearch approval `approval_1777078202_ebwne` still pending user action in dashboard

## Cannaleo Dual Price Convention (discovered 2026-05-05)

**Critical:** Cannaleo API has TWO separate price unit conventions in different endpoints:
- **Product catalog prices** (`price_gross`, `price` on catalog items): already in **CENTS** (integer). `normalizePrice()` correctly does `Math.round()` with no multiplication.
- **Pharmacy shipping costs** (`shipping_cost_standard`, `express_cost_standard`, `local_coure_cost_standard` on pharmacy endpoint): in **EUR** (float, e.g. 7.99). Must multiply by 100 to convert to cents.

BUG: The transformer comment said "Costs already in cents" — WRONG for shipping fields. Math.round(7.99) = 8 cents stored instead of 799 cents. Fixed in PR #395 (transformer.ts + providerRegistry.ts).

Rule: When touching Cannaleo price fields, always check which endpoint they come from:
- Catalog endpoint prices → no conversion needed
- Pharmacy endpoint shipping/express/courier costs → multiply by 100

## imageUrl Gap — Neither API Returns Product Images (confirmed 2026-05-07)

`diagImageUrls.sampleImageUrls` against live Convex action confirmed: Cannaleo 2981 products = 0 with imageUrl, HiGreen 1390 products = 0 with imageUrl. Both `image_url` fields exist as optional fields in provider types but the APIs do not populate them. The `backfillImageUrls` action would be a no-op. This is a data gap requiring a product decision (alternative image API endpoint, manual upload, PZN-based image DB, or accept no images). Do NOT attempt sync fixes for REOPEN-QA-01 — it is a provider data gap, not a code bug.

## HiGreen active=true Is Not Availability (fixed 2026-05-07 PR #492)

`status.active === true` in HiGreen API responses flags the pharmacy relationship as configured — NOT that the product is in stock. Live data: all 5752 status entries have active=true regardless of stock state. Only `status.value === "3"` = available (220/5752 = 4%). Before fix, 5532 offers were stored as availability=true incorrectly. Fixed in both `src/lib/providers/higreen/transformer.ts` and `convex/lib/providerRegistry.ts`. After merge, full HiGreen sync corrects Convex DB without backfill — batchUpsertOffers overwrites on upsert.

## HiGreen Data Gaps (confirmed 2026-05-07 live test)

Against higreen.de production (1438 products, 4 pharmacies): PZN=0%, category=0%, genetics=0%, imageUrl=0%. No cross-provider PZN matching with Cannaleo is possible. Category normalization always returns "other". These are provider limitations — not fixable at integration layer without product decision on alternative data sources.

## normalizePercent Parameter Order — Critical Reference (confirmed 2026-05-07)

Function signature: `normalizePercent(value, alwaysRatio=false, alwaysPercent=false)` — second param is `alwaysRatio`, third is `alwaysPercent`. HiGreen transformer correctly calls `normalizePercent(raw.thc, true)` = alwaysRatio=true = multiplies by 100. The cbdPercent=0.5 records in DB were from a prior broken transformer version, cleaned by PR #472 Run 1 (cbdPercent DESC keeper selection). If any agent reports this as a bug, verify the parameter order before applying any suggested fix — cannametrics-data made this error in 2026-05-07 by confusing alwaysRatio vs alwaysPercent.

## HiGreen Zero-Offers P0 Root Cause (resolved 2026-05-07)

**Symptom**: HiGreen sync completing with `offersUpserted: 0, pharmaciesUpserted: 0` despite 1395 products fetched from API.

**Root cause**: `batchUpsertOffers` in `catalog.ts:1922-1927` skips offers when `pharmacyCache.get(externalPharmacyId)` returns undefined. Pre-PR#503, `batchUpsertPharmacies` silently returned 0, so pharmacyCache was empty. Every offer hit `if (!pharmacyId) continue`.

**Fix**: Deploying PR#503 (added `by_provider_lastSeen` index to schema) pushed a schema migration that also fixed the pharmacy upsert path. After deploy, manual `syncProviderCatalog` returned `pharmaciesUpserted: 4, offersUpserted: 5772`.

**Diagnostic approach**: Use `providerOfferQualityAudit` with `provider: "higreen"` to confirm offers + pharmacies. If `uniquePharmacies: 0`, the pharmacy upsert is broken. Check `batchUpsertPharmacies` return value.

**Key principle**: There is NO `HIGREEN_PHARMACY_ID` env var. All pharmacy IDs come from the API's `prices[].pharmacy.id` and `status[].pharmacy.id` fields. See `orgs/phytomedic/docs/higreen-api-integration.md`.

## Cannaleo Stale Offer Deactivation Pattern (established 2026-05-07)

After any provider downtime, run `markStaleOffersUnavailable` once the API recovers and Phase 2 (offer upsert) completes. MUST NOT run while API is down.

Steps:
1. Wait for full sync success: `syncProviderCatalog '{"provider":"cannaleo","syncType":"full"}'`
2. Verify Phase 2 complete: `providerOfferQualityAudit '{"provider":"cannaleo"}'` shows fresh `avgHours`
3. Check stale count: `staleOfferStats` — look at `staleButAvailable`
4. Run deactivation: `markStaleOffersUnavailable '{}'` (repeating if `hasMore: true`)
5. Re-run Phase 3: `_updateProductAvailability` to refresh `hasAvailableOffer` flags

**BATCH_SIZE cap**: `markStaleOffersUnavailable` has BATCH_SIZE=500 (was 5000, exceeded Convex 4096 read limit). If `hasMore: true`, call again until `hasMore: false`.

**Daily cron**: stale-offer-cleanup cron runs at 3:23 AM daily (in config.json) to prevent phantom offers from accumulating. Session-only cron also set (id: b0574a3d).

## providerOfferQualityAudit Sampling Caveat (learned 2026-05-07, corrected 2026-05-07)

`providerOfferQualityAudit` uses `by_provider` index with `.take(16000)` — reads the OLDEST 16,000 Cannaleo offers by `_creationTime`. This gives completely misleading results when old stale offers coexist with fresh new offers:
- `totalOffers: 16000` = sample cap, NOT total. `isSampled: true` means >16,000 exist.
- `availablePct: 0%` = all old offers are deactivated, NOT that current data has 0% available.
- `freshnessHours.avgHours: 1612h` = age of OLD offers, NOT current sync freshness.

**Correct diagnostic for current offer state**: `cannametricsMorningKpis` which uses `by_availability` index to read active offers — shows `byProvider.cannaleo.count` and p50/p95 freshness for ACTIVE offers only.

**Correct diagnostic for stale-but-available count**: `staleOfferStats` (now uses `by_availability` index for `staleButAvailable` — exact, not sampled).

**Phase 2 resolution (2026-05-07)**: Phase 2 was completing all along (syncLog shows offersUpserted=48,773 in ~4.7min with OFFER_BATCH_SIZE=500 from PR #512). `recentCompletedSyncLog '{"provider":"cannaleo"}'` is the correct function to verify Phase 2 completion.

**Phase 3 stable state**: hasAvailableOffer=true on 511/4000 (12.8%) products. 4000+ active Cannaleo offers across 511 products, freshness p50=0.1h.
