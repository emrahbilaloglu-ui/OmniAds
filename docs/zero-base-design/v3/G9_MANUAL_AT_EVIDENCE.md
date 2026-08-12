# G9 — manual assistive-technology evidence

**Status: EMPTY. G9 is RED until a human fills this in.**

This file exists so the only thing standing between WP-26 and G9 is a person
sitting in front of a screen reader — not a question about what to record or
where to put it. Every row below is blank on purpose.

## Rules

1. **No agent may fill in a result.** Not from an axe scan, not from a DOM
   inspection, not from a screenshot, not by reasoning about what a screen
   reader "would" announce. WP-26 step 9 is explicit: *"Do not approve manual AT
   behavior from axe alone."* An automated scan is evidence, not certification.
2. **A result is what the tester perceived**, in their own words — what was
   announced, in what order, and whether it matched what was on screen.
3. **Partial is fine; invented is not.** An unrun row stays `—`. A row that
   failed is more useful than a row left ambiguous.
4. Anything already covered by automation is *not* covered here. `axe` (0
   serious/critical), keyboard traversal, zoom reflow, reduced motion and print
   are checked by `npm run test:zero-base:a11y`; the rows below are the
   behaviours no scanner can reach.

## Environment blocking this on the current host

Recorded so the next person does not re-derive it:

| Requirement | Host fact (macOS 26.5.2) |
|---|---|
| NVDA + Chrome | Windows-only; no Windows machine and no VM software installed |
| TalkBack + Chrome Android | no `adb`, no Android emulator on PATH, no device attached |
| VoiceOver + Safari | present but off; enabling it is a system-settings change, and certifying what it announced requires hearing it |

## The eleven §13.5 items

| # | Requirement | Tester | Date | Browser | AT + version | Result (what was announced / observed) |
|---|---|---|---|---|---|---|
| 1 | NVDA + Chrome desktop, **all 13 flows** | — | — | — | — | — |
| 2 | VoiceOver + Safari macOS — shell, Decisions, builder, shares | — | — | — | — | — |
| 3 | VoiceOver + Safari iOS — flows A/B/I/L at 390 | — | — | — | — | — |
| 4 | TalkBack + Chrome Android — flows A/B/I/L at 320 and 390 | — | — | — | — | — |
| 5 | Keyboard-only, all 13 flows | — | — | — | — | — |
| 6 | 200% zoom | — | — | — | — | — |
| 7 | 400% zoom | — | — | — | — | — |
| 8 | Print / PDF from the real report renderer | — | — | — | — | — |
| 9 | Live regions: counts, preflight age, progress, outcome, copy, grid position | — | — | — | — | — |
| 10 | Reduced motion | — | — | — | — | — |
| 11 | Dialog/drawer focus trap, Escape, and origin return | — | — | — | — | — |

## The 13 flows, for rows 1 and 5

A — sign in and land · B — switch business/scope · C — connect a provider ·
D — read Home and its sources · E — work a Meta decision to a mutation ·
F — run the Google plan · G — read analytics/SEO/GEO · H — build and share a
report · I — manage team and access · J — manage economics and settings ·
K — creative performance to brief · L — agency desk to client and back ·
M — public share as an outside recipient.

## For rows 9 and 11 specifically

These are the ones most often reported as "fine" without being tested. Say
explicitly:

- **Row 9** — did the count change *speak* without moving focus? Did the
  preflight age announce when it went stale? Did a mutation outcome announce
  once, or twice, or not at all? Did the report grid announce the widget's new
  position after an arrow-key move?
- **Row 11** — with the drawer open, does Tab stay inside it? Does Escape close
  it? Does focus return to the control that opened it, or to the top of the
  page?

## When this is complete

Fill every row, commit this file, and record the commit in
`EXECUTION_LEDGER.md` next to G9. Only then may G9 move from RED. WP-26 is not
complete while G9 is RED, and WP-27A must not start.
