# Sweep Batch 3 — Checkout + Onboarding — 2026-05-07

**Tested by:** systems-analyst
**Commissioned by:** platform-director (overnight task)
**Scope:** Checkout steps 1-5 + /onboarding + /onboarding/arzt + /onboarding/apotheke
**Auth:** No test credentials available — Steps 1-2 tested live; Steps 3-5 code-audited; auth-required steps confirmed gated correctly
**Mobile:** Tested at 390×844 (iPhone 14 Pro)

---

## Step Label Audit

| Step | Expected (SKILL.md) | Actual | Match |
|------|---------------------|--------|-------|
| 1 | Warenkorb | Warenkorb | ✅ |
| 2 | Registrierung | **Adresse** | ⚠️ LABEL CHANGED |
| 3 | Fragebogen | Fragebogen | ✅ |
| 4 | Zahlung | Zahlung | ✅ |
| 5 | Bestätigung | Bestätigung | ✅ |

> Note: Step 2 was renamed from "Registrierung" to "Adresse". The step now shows an auth gate ("Anmeldung erforderlich") when unauthenticated, but the label reflects what the step collects (address) rather than the gate mechanism. SKILL.md needs updating.

---

## Step 1: Warenkorb ✅

**Test URL:** `/checkout?productId=ph74dj09f8a1hwd04sg59424px82099d&pharmacyId=nd74qv0sy640gge67hkj5mcqcd821mb2`

| Check | Result | Notes |
|-------|--------|-------|
| Product name | ✅ | "420 Evolution 22/1 CA MAC" |
| THC/CBD/type shown | ✅ | THC 22%, CBD 0.9%, flowers |
| Pharmacy shown | ✅ | "LeoVerde (Löwen Apotheke Neumarkt)" |
| Unit price | ✅ | 7,85 € |
| Qty modifier (+/-) | ✅ | Increments work, aria-label present |
| Line total updates on qty change | ✅ | 2 × 7,85 € = 15,70 € correct |
| Sidebar summary updates on qty change | ❌ BUG-SWEEP-3-01 | Still shows 7,85 € / 17,84 € after qty+; only updates on step advance |
| Rezeptgebühr shown | ✅ | 9,99 € |
| Gesamtbetrag | ✅ | 17,84 € (step 1), 25,69 € (step 2 after advance) |
| "zzgl. Versand" label | ✅ |  |
| Weiter CTA | ✅ | Present, navigates to Step 2 |
| Back CTA | ✅ | "Zurück" present |
| 0 console errors | ✅ |  |

**Mobile (390px):**
| Check | Result | Notes |
|-------|--------|-------|
| No horizontal overflow | ❌ BUG-SWEEP-3-02 | 51px overflow; "Weiter zur Lieferadresse" w-full in flex row causes overflow |
| Step bar fits | ✅ | No overflow in step nav |
| Collapsible mobile summary | ✅ | Present above step bar |
| Product/price visible | ✅ |  |

---

## Step 2: Adresse (Auth Gate) ✅

| Check | Result | Notes |
|-------|--------|-------|
| Auth gate shows correctly | ✅ | "Anmeldung erforderlich" with login/register CTAs |
| "Anmelden" link | ✅ | `/login?redirect_url=/checkout` |
| "Jetzt registrieren" link | ✅ | `/registrieren?redirect_url=/checkout` |
| Cart saved to sessionStorage on step advance | ✅ | Via `phytomedic_checkout_basket` key (confirmed in code) |
| Cart recovery after auth | ✅ (code) | useEffect restores on isAuthenticated change |
| Redirect URL preserves productId/pharmacyId | ⚠️ | redirect_url=/checkout (no params) — cart restored via sessionStorage. OK if sessionStorage works; Safari ITP edge case |
| Summary shows correct qty × 2 | ✅ | On step 2: "420 Evolution 22/1 CA MAC × 2, 15,70 €, Gesamtbetrag 25,69 €" |
| 0 console errors | ✅ |  |

---

## Steps 3-5: Code Audit (no auth)

### Step 3: Fragebogen
- Component: `src/components/checkout/checkout-questionnaire.tsx` (376 lines)
- Structure: therapy goals select (5 options), symptom duration (4), cannabis experience (4), consumption method (4), free text fields for Diagnose/Beschwerden/Medikamente/Allergien + Datenschutz consent
- **SKILL.md outdated**: "31 Beschwerden checkboxes" → actually structured dropdowns + free text (cleaner UX, not a bug)
- Validation: `required` on therapy goals, Diagnose, Hauptbeschwerden, Datenschutz consent

### Step 4: Zahlung
- Component: `src/components/checkout/checkout-payment.tsx` (found in code structure)
- Stripe integration + Rezeptgebühr visible per wizard props
- `prescriptionFeeCents` + `prescriptionFeeLabel` passed through correctly
- BUG-QA-06 (Rezeptgebühr=0) — check in /admin/rezeptgebuehren (not swept yet)

### Step 5: Bestätigung
- Redirect on Stripe success via `session_id` URL param (line 68 of checkout-wizard.tsx)
- BUG-QA-03 (env): Stripe env vars needed for redirect to work in production

---

## Onboarding Pages

| Page | Result | Notes |
|------|--------|-------|
| /onboarding | ✅ CLEAN | h1 "Willkommen bei PhytoMedic", 4 roles (Patient/Arzt/Apotheke/Hersteller) with descriptions, 0 errors |
| /onboarding/arzt | ✅ AUTH GATE | Correctly redirects to `accounts.phytomedic.de/sign-in?redirect_url=.../onboarding/arzt`. Return URL preserved ✅ |
| /onboarding/apotheke | ✅ AUTH GATE | Same pattern. Return URL preserved ✅ |

**Branding issue on accounts.phytomedic.de**: Page title shows "My account | phytomedic saas" — needs Clerk dashboard org name updated to "PhytoMedic". Not a regression; existing issue from Batch 1.

---

## Bugs Filed

| ID | Severity | Component | Issue | Routed |
|----|----------|-----------|-------|--------|
| BUG-SWEEP-3-01 | MEDIUM | checkout-basket.tsx + checkout-wizard.tsx | Order summary sidebar shows stale price/total when qty changes in Step 1. Root cause: sidebar uses wizard-level `basketItems` state, not basket-local `localItems`. Fix: add `onChange` prop to CheckoutBasket or lift local state. | frontend-dev ✅ |
| BUG-SWEEP-3-02 | HIGH | checkout-basket.tsx CardFooter | "Weiter zur Lieferadresse" button — `w-full` in `flex gap-3` row with fixed-width "Zurück" sibling causes 51px overflow at 390px. Fix: change `w-full` → `flex-1` on the primary CTA. PR #525 adds related mobile fixes (MOBILE-04/05) but does NOT cover this specific button. | frontend-dev ✅ |

---

## Regression Check (Today's Checkout PRs)

| Commit | PR | Description | Impact |
|--------|----|-------------|--------|
| 792ae73 | #496 | fix(mobile): checkout tap target (+/- buttons icon-sm) | Tap targets correct ✅; Weiter button overflow NOT fixed |
| 4e80ec6 | #469 | test(checkout): 11 tests for CheckoutWizard | Tests only |
| e65cb9b | #456 | fix(ssr): React #418 + nav aria-label + checkout step indicator | Step indicator aria-label correct ✅ |

**No new regressions from today's PRs detected.** BUG-SWEEP-3-02 pre-dates today (PR #496 fixed qty buttons but not the Weiter CTA).

---

## Summary

| Area | Status |
|------|--------|
| Step labels | ✅ (SKILL.md needs update: Step 2 = "Adresse") |
| Pricing display | ✅ desktop; ❌ Step 1 sidebar lag (BUG-SWEEP-3-01) |
| Form validation | ✅ (code audit: required fields in questionnaire) |
| Auth flow | ✅ (correct gates, return URL preserved, cart recovery via sessionStorage) |
| Mobile layout | ❌ BUG-SWEEP-3-02 (Weiter button overflow) |
| Onboarding | ✅ (all 3 pages: hub + auth guards) |

**2 new bugs filed, both routed to frontend-dev (PR in progress).**

