# Sweep Batch 2B — 2026-05-07

**Tested by:** systems-analyst
**Batch focus:** Batch 2 remaining pages (produkte, sorten, arzt-finden, apotheke-finden) + Batch 4 public content (wissen, krankheiten)
**Pages tested:** 8
**Pass:** 7
**Fail (new bugs):** 1
**Known issues confirmed:** 1 (COHERENCE-10-02), 1 (React #418 on apotheke-finden — PR #494 in flight)

---

## Auth Surface Check (Phase 0)

New route found: `src/app/passwort-vergessen/[[...passwort-vergessen]]/page.tsx`
→ **Confirmed intentionally public** — Clerk password reset flow. NOT in isProtectedRoute matcher. Correct.

---

## Pages Tested

| Page | URL | Result | Notes |
|------|-----|--------|-------|
| Produktkatalog | /medizin/produkte | ✅ CLEAN | h1 correct, 24+ products, infinite scroll works (24→48), filters present (Kategorie/Genetik/Hersteller/THC/CBD/Terpene), 0 console errors, no NaN/€0.00 |
| Produkt Detail | /medizin/produkte/23-1-nice-c-cherry-pie | ✅ CLEAN | h1 correct, Preisvergleich present, strain link, THC/CBD, 5 pharmacy links, 0 errors. NICHT VERFÜGBAR offers = correct after HiGreen fix. |
| Sorten Hub | /medizin/sorten → /medizin/strains | ✅ CLEAN | Redirect works, h1 "Strains", 12 strain links, search+filter (Indica/Sativa/Hybrid), 0 errors |
| Strain Detail | /medizin/strains/gorilla-glue-4 | ✅ CLEAN | h1 correct, lineage present, effects/terpenes, 9 product links, arzt-finden CTA, 0 errors |
| Arzt finden | /medizin/arzt-finden | ✅ CLEAN | h1 "Arztsuche", 5 doctor links, Fachrichtung filter, 0 errors |
| Apotheke finden | /medizin/apotheke-finden | ⚠️ KNOWN BUG | 200 pharmacies, map, search all functional. React #418 console error — PR #494 in flight (suppressHydrationWarning on input wrapper). |
| Wissen | /wissen | ✅ CLEAN | h1 correct, 8 articles found, categories (Ratgeber/FAQ/News/Recht), search present. BUG-QA-07 (0 Artikel) RESOLVED. |
| Krankheiten | /krankheiten | ✅ FUNCTIONAL / ⚠️ NEW BUG | 14 Krankheitsbilder, h1 correct. React #418 on search input — NEW, not covered by PR #494. BUG-SWEEP-2B-01 filed → frontend-dev. BUG-QA-16 (0 Einträge) RESOLVED. |

---

## Bugs Filed

| ID | Severity | Page | Issue |
|----|----------|------|-------|
| BUG-SWEEP-2B-01 | HIGH | /krankheiten | React #418 hydration error on search input — same pattern as apotheke-finden, needs suppressHydrationWarning on input wrapper. → frontend-dev |

---

## Known Issues Confirmed

- **React #418 on /medizin/apotheke-finden** — covered by PR #494 (in review)
- **COHERENCE-10-02** — Checkout has no back-link to originating product (only generic /medizin/produkte). "Zurück" is JS-only button.

---

## Coherence Cluster 12 — Cart↔Checkout (Product→Checkout Direction)

**Method:** Playwright — product detail CTA → checkout step 1

| Check | Result | Notes |
|-------|--------|-------|
| Product CTA absent when no offers | ✅ CORRECT | 23/1 NICE C Cherry Pie — all NICHT VERFÜGBAR after HiGreen fix. No CTA rendered. |
| Product CTA present when offers available | ✅ PASS | 420 Evolution 22/1 CA MAC — "REZEPT BEANTRAGEN" CTA with ?productId=...&pharmacyId=... params |
| Checkout step 1 shows product+pharmacy+price | ✅ PASS | "420 Evolution 22/1 CA MAC", "LeoVerde", 7,85 €, 9,99 € Rezeptgebühr, 17,84 € total |
| Checkout back to originating product | ❌ OPEN (COHERENCE-10-02) | "Zurück" is JS button only; "Produktkatalog" → /medizin/produkte (generic). No direct product link. |
| 0 console errors in checkout | ✅ PASS | 0 errors |
| Checkout price integrity | ✅ PASS | No NaN, no €0.00 |

next_cluster=13 (Wissen↔Krankheiten↔Product content cross-links or authenticated Order→Prescription loop)

---

## Resolved Bugs Confirmed
- BUG-QA-07: /wissen 0 Artikel → RESOLVED (8 articles now)
- BUG-QA-16: /krankheiten 0 Einträge → RESOLVED (14 Krankheitsbilder now)

---

## Next Batch

Batch 3 (Checkout flow steps 2-5 + Onboarding) — requires authenticated session for steps 2+.
Batch 5 (Patient Dashboard) — requires authenticated session.
Both pending test credentials from platform-director.

Unblocked next: Batch 8 (Manufacturer), Batch 9/10 (Admin) — code-level audit possible without auth.
