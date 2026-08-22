# WP5 — Reporting window, as-of and freshness authority

Work package: WP5 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP4
Date: 2026-08-22

Goal: make the date and freshness text on screen describe the data that was
actually served.

## 1. Item 8 — the picker stops looking active over state it cannot re-scope

This was the plan's §5.1 finding 7, and the one with the worst consequence: on
Automation, Integrations and the Shares ledger, the operator picks "Last 28
days", the picker shows it, **nothing below changes**, and they read the
current control state as the state during those days.

`reportingWindowApplicability(pathname)` answers from the WP2 surface registry —
so the topbar cannot grow a second opinion about which surfaces take a window —
and `DateRangePicker` gained an `inactiveReason` prop.

`inactiveReason` is deliberately **not** implemented with `disabled`. A
`disabled` button leaves the tab order, so a keyboard or screen-reader user
finds nothing where the control is — and on a control-state screen the entire
point is to *tell* them the range is not applied. The trigger stays focusable,
carries `aria-disabled`, is tied to the reason by `aria-describedby`, refuses to
open, and the reason renders as **visible text** rather than only a `title`,
because a tooltip reaches a mouse hover and nothing else.

`applyDateRange` also returns early when the window does not apply, so a caller
reaching it another way cannot write a window the surface ignores.

A pathname the registry does not know keeps the picker fully active. That is the
conservative answer: nothing outside the Meta family changes, and an
unregistered surface is not silently stripped of a control it may need.

Verified across all three route families and for dynamic segments:
`/c/biz_1/creative/abc123` resolves to Creative Detail while
`/c/biz_1/creative/copies` resolves to the Copies tab, because longer and
concrete patterns are tried before dynamic ones of the same length.

## 2. Item 3 — a window label that named the wrong window

Launchpad's creative table headed its metrics column **"28d metrics"** over a
fetch of `isoDateDaysAgo(29)` → today, which is **thirty inclusive days**. Every
spend, ROAS and CTR in that column covered two more days than the header
claimed, and nothing could catch it because the two numbers lived in different
files — the fetch in `legacy-page.tsx`, the label in
`LaunchpadCreativeSelection.tsx`.

`lib/launchpad/candidate-window.ts` now holds the day count, derives the label
from it, and both files read the constant. Changing the window changes the
header with it.

The **window was not changed** to match the label. The label was changed to
match the window, because these rows feed Launchpad candidate selection and
silently moving two days of evidence to make a caption true would be the
opposite of the fix.

## 3. Items already satisfied — verified, not assumed

| Item | State | Where |
|---|---|---|
| 1. one window parser | **satisfied** | `windowFromSearchParams` / `scopeFromSearchParams` in `lib/zero-base/creative/route-scope.ts`; every `/c/**` Meta and Creative route uses it |
| 2. previous period from the selected day count | **satisfied** | `lib/meta/snapshot.ts` derives `previousStart` from `selectedSpanDays`, not from a constant |
| 4. custom range shows `startDate → endDate` | **satisfied** | `buildEffectiveDashboardEnvelope` builds `"2026-07-20 → 2026-08-16"` from the stated pair, and captions nothing when no window was stated |
| 5. Decisions separates metric window from decision as-of | **satisfied** | the queue footnote reads "queue reflects snapshot ⟨date⟩ — the date range scopes metrics, not decisions", which is D7 stated on screen |
| 10. currency/timezone proof states | **satisfied** | `resolveCurrencyProof` / `resolveTimezoneProof` already separate `proven` / `configured-only` / `mixed` / `unknown` and `aligned` / `missing` / `disagreement` / `unknown` |

Recording these as verified is part of the work product: the plan asks for the
behaviour, and confirming it exists is cheaper and more honest than rewriting it.

## 4. Not done in WP5, and why

| Item | Status |
|---|---|
| 6. Intelligence per-section evidence window | **deferred to WP9**, which rebuilds the nine sections; adding a window field to sections that are themselves being reworked would be work done twice |
| 7. Launchpad candidate vs current-state windows | **partial** — the candidate window is now named honestly (§2 above) and the registry marks Launchpad `mixed`; rendering the two side by side is WP14 |
| 9. freshness derived only from the relevant provider | **not verified.** `useWorkspaceSyncState` feeds the topbar freshness pill and was not audited here. Claiming it would be claiming an audit that has not happened |

One found-and-not-fixed item, recorded rather than quietly skipped:
`components/creatives/briefing/CreativesBriefingPage.tsx` renders a literal
"Spend today". That body is **not mounted by any route** — the only reference to
it is its own definition — so changing it would alter a surface no operator can
reach. It is listed for WP16's dead-module sweep instead.

## 5. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 525 passed, 0 failed (WP4: 12 514; +11) |

New coverage: `reporting-window-applicability.test.ts` (8),
`candidate-window.test.ts` (3).

## 6. Runtime evidence

**UNKNOWN.** All **VERIFIED-STATIC**. The plan's acceptance for WP5 wants a
URL → server payload → label equality check on a real account and a screen
recording of a window change, both of which need an authenticated session.

## 7. Rollback

Route-local, as the plan asks:

- removing `inactiveReason` from the topbar's `DateRangePicker` restores the
  always-active picker; the prop is additive and defaults to `null`, so every
  other caller is unaffected;
- reverting `candidate-window.ts` and its two call sites restores the previous
  literals.

No schema, migration, provider state or deployed configuration is touched.
