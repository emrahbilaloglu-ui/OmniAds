# WP-26 — Cross-product hardening: implementation status

**Result: WP-26 is NOT complete. WP-27A was not started.**

This report does not claim `READY FOR AUTHORIZED G12`, because that label
requires WP-26 and WP-27A complete with G0–G11 green, and neither condition
holds. What follows separates, for every requirement, what was implemented and
verified from what was not — and, where something failed, whether it was a
product defect, an evidence defect, an environment limitation, or an accepted
pre-existing baseline.

## 0. Authority

Plan: `/Users/harmelek/Adsecute-native-integration/docs/claude-design-handoff/reviews/ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md`

SHA-256 re-verified before work:

```
79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613
```

Matches the required hash exactly.

Branch: `codex/adsecute-zero-base-implementation` in `/Users/harmelek/Adsecute-zero-base`.
Starting commit: `4014b4ae6` (Phase E accepted). Commits added: `f1b0755cd`, `4d7f68709`.

## 1. What was implemented and verified

### 1.1 Route matrix — WP-26 step 1 (structural half), G5

`scripts/zero-base/route-matrix-smoke.ts`, run by `npm run test:zero-base:routes`.

Walks all 74 leaves from the generated contract registry and asserts:

- every canonical URL resolves to a real page module, including route groups
  (`(marketing)`) and dynamic segments (`[businessId]`);
- every `Client`/`Agency`/`Ops`/`Auth` leaf actually reads the session before
  rendering, checked against the page and its layout chain;
- no changed legacy mapping points at itself or forms a redirect cycle.

Result: **74/74 resolve, 0 findings.** It independently reproduces the plan's
WP-27A figures from the registry rather than from the prose — 47 changed
mappings across 46 unique paths, plus 20 aliases.

Coverage was verified rather than assumed: a negative control
(`/definitely-not-a-route`) returns null, and the resolver was printed for a
sample of leaves to confirm it finds real files.

**This is the structural half only.** The behavioural half — real HTTP status,
redirect chain, and rendered Ledger root per leaf against a running server — is
not implemented. G5 is therefore partially evidenced.

### 1.2 Legibility — WP-26 step 5

`scripts/zero-base/verify-legibility.ts`, run by `npm run zero-base:legibility`.

- **Type floor.** Every `fontSize:` literal in shipped zero-base components must
  be ≥ 12 px. Found **25 violations, all product copy, all introduced by earlier
  phases of this programme.** All raised to 12.
- **Contrast.** The `--ledger-*` colours are parsed out of `app/globals.css`
  itself for both themes and every ink/surface pair is measured with the WCAG
  2.1 relative-luminance formula. Hard-coding the hexes would let the stylesheet
  drift away from its own gate.

Coverage verified: 22 tokens parse per theme, the dark values are the real dark
values, and a planted bad pair (`#cccccc` on `#ffffff`) is caught.

### 1.3 Automated accessibility — WP-26 step 8, automated half of G9

`playwright/tests/zero-base-a11y.spec.ts`, project `zero-base-a11y-chromium`,
run by `npm run test:zero-base:a11y`. **85/85 pass.**

Covers axe (WCAG 2.0/2.1 A+AA, serious+critical), 200% and 400% zoom reflow,
reduced motion, keyboard reachability, print media, and the step-6 rule below.

It found three defects on first run — 18 failures — of which **two were real
product defects**:

| Finding | Class | Resolution |
|---|---|---|
| `public-share` hardcoded `#666`, giving 3.04:1 on dark | product defect | now `var(--ledger-ink-tertiary)` |
| `<main>` owns both scroll axes with `tabIndex={-1}`, so on any page whose content has no focusable element a keyboard user cannot scroll it at all | product defect | `tabIndex={0}`, the documented remedy, via a shared exported constant |
| the harness hand-wrote `tabindex="-1"` in a string template, duplicating the shell | evidence defect | both now read one exported constant, so they cannot drift again |
| reduced-motion assertion failed the deliberate 80 ms opacity fade | **evidence defect, not product** | the stylesheet already strips all animation and every non-opacity transition; a cross-fade carries no movement. The assertion now tests for movement, and says so in the file. |

The last row is recorded explicitly because blessing it as a product failure
would have been as wrong as blessing it as a baseline.

### 1.4 Collection completeness — WP-26 step 6

Implemented inside the a11y suite: for each harness surface, the set of
`data-metric` / `data-metric-unavailable` names must not shrink as the viewport
narrows from 1440 to 320. A narrow layout may reflow; it may never silently drop
a value the wide layout showed. Passes across all harness families.

### 1.5 Canonical screenshot manifest — WP-26 step 4, G10 instrument

`lib/zero-base/visual-manifest.ts` (helpers), `scripts/zero-base/visual-regression.ts`
(CLI), `playwright/tests/zero-base-visual.spec.ts` (capture).

The plan's three rules are enforced in code, not by convention:

1. every run writes under a unique `zero-base/<commit>/<artifact-set>/`, with the
   commit read from git rather than supplied;
2. **nothing is ever deleted** — a non-empty target directory aborts the run.
   This matters because the existing full-UI smoke recursively deletes its
   artifact directory before capture, so a reused set name destroys evidence
   Appendix C cites. The refusal was verified by re-running: exit 1, no writes.
3. entries are keyed by `LeafId + state + width + theme`, and a manifest whose
   leaf set is exactly the legacy five-name smoke set is rejected outright.

Captured at commit `f1b0755cde`, artifact set `wp-26-f1b0755cde`: **78 frames,
9 leaves, widths 320/390/768/1280/1440, both themes**, each with a SHA-256 and
byte count. Frames and `manifest.json` are tracked, not ignored, because they
are the cited evidence.

The mapping assertion earned its place on the first run by failing on an
unmapped `automation-mirror` surface rather than skipping it.

**This is an instrument and a first capture, not G10 closure.** G10 requires the
frames to be reconciled against the H/B/P/M references (§1.6 below), which was
not done.

### 1.6 Package scripts

Added: `test:zero-base:routes`, `test:zero-base:a11y`, `test:zero-base:visual`,
`zero-base:legibility`, `zero-base:visual`, `test:zero-base:release`.

`test:zero-base:release` aggregates **only what genuinely runs today**: contract,
typecheck, lint, route matrix, legibility, design, a11y, responsive. Flow and
matrix reconciliation are deliberately excluded. A green aggregate that quietly
omitted unimplemented work would be exactly the false proof this plan warns
against, and `test:zero-base:flows` was **not** created as a stub for the same
reason.

## 2. What was NOT done

Each item is implementable; none is blocked by anything except scope.

| Plan requirement | Status |
|---|---|
| Step 1, behavioural half — real HTTP auth/permission/route/basic-state smoke per leaf against a running server | not implemented |
| Step 2 — all 13 flows at 1440; A/B/I/L at 1280/768/390/320 | **not implemented as a flow matrix.** Component-level tests reference Flows A–F and H–L (11 of 13; G and M absent), but that is not the end-to-end five-width matrix the step requires |
| Step 3 — H01–H66, B01–B09, P01–P08, M01–M09 reconciliation against deterministic fixtures | not implemented; no reconciliation exists |
| Step 7 — EN/TR glossary, real-length strings, locale parity | **not implemented. Measured: 1 of 68 zero-base components route copy through the language system.** `NON_TRANSLATABLE_TERMS` exists in `lib/i18n.ts` and is preserved, but the canonical surfaces carry hardcoded English. This also fails the §15.2 per-leaf DoD line "EN/TR copy through the existing language system" |
| Step 10 — performance measurement on representative heavy leaves | not implemented; no LCP/CLS/TBT tooling exists, so **G11 is entirely unevidenced** |
| `playwright/fixtures/zero-base/**` | not created |
| IG-1 … IG-7 | not individually closed or evidenced |

## 3. Blocker — manual assistive technology (§13.5, WP-26 step 9, G9)

This one is **not** a scope shortfall. It is an environment limitation, and it
independently prevents G9 from going green.

§13.5 requires named tester/date/browser/AT and result for NVDA + Chrome,
VoiceOver + Safari macOS, VoiceOver + Safari iOS, and TalkBack + Chrome Android.
Safe local options were checked before concluding this, not assumed:

| Requirement | Environment fact |
|---|---|
| NVDA + Chrome (Windows) | host is macOS 26.5.2; no Windows machine and no VM software installed (`UTM`/`Parallels`/`VirtualBox`/`VMware` all absent) |
| TalkBack + Chrome Android | no `adb` and no Android `emulator` on PATH; no device attached |
| VoiceOver + Safari macOS/iOS | VoiceOver is present but off. Enabling it is a system/accessibility settings change, which I am not permitted to make; and certifying what a screen reader *announced* requires perceiving speech output, which I cannot do |

WP-26 step 9 states: *"Do not approve manual AT behavior from axe alone."* The
axe suite in §1.3 is a scanner. It cannot report what NVDA announced, whether
VoiceOver's rotor exposed a landmark, or whether TalkBack's swipe order matched
the visual order. Presenting it — or a screenshot, or a DOM inspection — as
manual AT evidence would be fabricating the one thing the plan explicitly
forbids fabricating. No such evidence is offered here.

**Missing evidence, exactly:** the eleven §13.5 line items, each with tester
name, date, browser, assistive technology and result.

## 4. Gate status

| Gate | Status |
|---|---|
| G1 contract | green — 74 leaves / 142 keys reconcile (`test:zero-base:contract`, 17/17) |
| G2 compile | green — typecheck 0, lint 0, production build compiles |
| G3 data | green — Vitest 8954 passed / 0 failed; migrations-from-zero and selection seam pass |
| G4 decision safety | green — creative safety and frozen acceptance pass; no resolver diff |
| G5 routes | **partial** — structural matrix green; behavioural HTTP smoke absent |
| G6 state truth | not re-evidenced in this package |
| G7 interaction | not re-evidenced in this package |
| G8 responsive | **partial** — 84/84 responsive and no-overflow at five widths; the 13-flow × five-width matrix is absent |
| G9 accessibility | **RED** — automated half green (85/85); manual AT evidence unavailable (§3) |
| G10 visual | **partial** — manifest instrument and 78-frame capture exist; H/B/P/M reconciliation absent |
| G11 performance | **RED** — no measurement exists |
| G12 deployment | out of scope; not claimed |

## 5. Commands run

```
shasum -a 256 <master plan>                        → hash matches
npm run typecheck                                  → 0 errors
npm run lint                                       → 0 problems
npx vitest run                                     → 8954 passed / 0 failed
npm run test:zero-base:contract                    → 17/17
npm run test:zero-base:design                      → 26/26
npm run test:zero-base:routes                      → PASS (74 leaves, 0 findings)
npm run zero-base:legibility                       → PASS (both themes)
npm run test:zero-base:a11y                        → 85/85
npm run test:zero-base:responsive                  → 84/84
npm run test:zero-base:visual                      → 78 frames captured
npm run test:zero-base:release                     → all constituent gates pass
npm run test:migrations-from-zero                  → PASS with all DB seams
npm run test:selection-race-seam                   → PASS (S1–S7)
npm run build                                      → compiled successfully
```

One intermittent was observed and is recorded rather than ignored: a single
assignment test in `manage-flows.test.tsx` failed once under a parallel batch
run and passed in isolation and in two subsequent full batch runs. It is not
reproducible and is **not** blessed as a baseline; it is logged as an
unexplained one-off to watch.

`pnpm-lock.yaml` and `package-lock.json` are unchanged. No dependency was added.

## 6. Safety

No provider call, campaign mutation, production database or migration, deploy,
push, PR merge, flag enablement, or G12 claim. No resolver or decision-output
file is touched: `git diff 1d769b534..HEAD` contains nothing under
`lib/creative-decision-engine/`, `lib/creative-decision-center/`, `lib/archive/`,
or `lib/meta/recommendations*`. `/Users/harmelek/Adsecute` is untouched.
Worktree clean.

## 7. Smallest authorized next action

WP-27A must not start: its stated precondition is that WP-26 and G1–G11 are
green, and G9 and G11 are red with G5/G8/G10 partial.

In dependency order:

1. **Implement WP-26 step 7 (EN/TR).** The largest product gap and the one that
   blocks the per-leaf DoD for all 74 leaves.
2. **Implement steps 2 and 3** — the flow × width matrix and the H/B/P/M
   reconciliation — closing G8 and G10.
3. **Implement step 10** — performance measurement, closing G11.
4. **Obtain manual AT coverage for §13.5.** This needs a decision that is not
   mine: either a human tester on Windows/Android/macOS performs the eleven
   passes and their results are recorded, or the programme owner explicitly
   re-scopes G9's manual requirement in writing. No amount of further local
   automation can substitute for it.

Only after 1–4 does WP-27A's precondition hold.
