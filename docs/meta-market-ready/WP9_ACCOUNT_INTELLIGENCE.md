# WP9 — Account Intelligence

Work package: WP9 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP8
Date: 2026-08-22

## 1. The defect: raw `Error.message` on the operator's screen

`lib/zero-base/meta/intelligence-server.ts` rendered a rejected source's own
error text as the section's reason, and
`app/c/[businessId]/meta/intelligence/page.tsx` did the same one level up for
the whole surface. That is WP9's "Ham Error.message basılmaz", and it is a rule
for **two independent reasons**:

1. **It leaks.** A driver error carries the failing SQL, the table and column
   names, and sometimes bound parameters. A fetch error carries the request URL
   — and for a Meta Graph call, that URL can carry an `access_token`. §17's
   security items forbid a token or PII reaching a client payload, and this was
   a direct path.
2. **It does not help.** `relation "meta_page_status" does not exist` tells a
   media buyer nothing they can act on. "A pending database migration has not
   been applied, so this data cannot be read yet. It is unavailable, not empty."
   tells them it is not their data and not their fault.

### The fix

`lib/meta/source-failure-classifier.ts` turns a thrown read into a §9.1 code and
its contracted sentence. Classification is **by structure first, text second**:
a driver code (`42P01`) or an HTTP status is a fact, a substring match on a
message is a guess, and the guess only runs when the facts are exhausted.
Anything unrecognised is `source_read_failed` — the read did not succeed, and we
do not invent a cause.

The raw text is **not discarded**. It is logged server-side, where only an
operator of the system reads it, and stops being the sentence on the screen.
Each section now also carries a `failureCode`, so a reader can branch on the
cause without parsing prose: a schema migration and an expired token need
different remedies.

### Closed at the boundary, not per render site

`never puts the raw error text into the served payload` serialises the **entire**
composed payload — every section, every fact, every reason — and asserts the
thrown text appears nowhere in it, using an error carrying a fake
`access_token=EAAsecret123`. A future field that forwards the detail fails there
rather than on an operator's screen.

## 2. The run-snapshot control: absent-with-reason, not absent

`IntelligenceView` has always accepted a `snapshot` prop and the route never
passed one, so the control never rendered at all. A control that simply is not
there reads as "this product cannot do that" — which is false;
`/api/meta/snapshot` exists and the capability is real.

It now renders **disabled with a reason**, and a reviewer is told the more
specific fact ("Reviewer access is read-only") because that is the one they can
act on. The design draws no run-snapshot control on this screen, so §18 keeps it
out of this pass; saying so is the difference between a gap and a silence.

## 3. Items already correct — verified, not rewritten

| Rule | State |
|---|---|
| every section shows data or an explicit unavailable reason | **satisfied** — `section()` distinguishes `degraded` (read failed), `unavailable` (nothing to give), `partial`, `serving` and `unknown`, each with the authority's own words |
| a rejected source is not counted as served | **satisfied** — `servedCount` filters `state === "serving"`, so a degraded row cannot inflate the account's apparent health |
| each section carries its own evidence window / freshness | **satisfied** — each row carries its own authority's `observedAt`, and the file records why: "one clock shared across eight sources is what made a never-synced source read as observed just now" |
| no account-scoped data without an account | **satisfied** — every account-scoped section returns `noAccountReason(...)` when `providerAccountId` is null, and WP4 gave the operator a picker to resolve it |
| no zero for a missing fact | **satisfied** — `asServedText` renders "Not reported" rather than `0` |

## 4. Three of the nine sections are not composed — stated, not implied

The plan names nine sections. Eight are composed today: Connection & account,
Account pulse, Summary, Trends, Breakdowns, Anomalies, Campaign labels,
Structure & recommendations.

**Missing: Top creatives, Page status, Lane classify.**

They are **not** added in this pass, and the reason is specific rather than a
shrug:

- The read models do not exist as callable modules. The logic lives inside the
  route handlers — `page-status` is 649 lines, `lane-classify` is 1 969 —
  composed from a dozen readiness helpers each.
- `top-creatives` performs **live Meta Graph API fetches inside the route**.
  Composing it into a server-rendered page load would add live provider calls to
  every render of this screen, against WP17's 12-request first-load budget and
  into Meta's rate limits.
- Reimplementing any of them in the intelligence composer would create a second
  source of truth for readiness and partial semantics — precisely the drift this
  plan exists to end.

Doing it properly means extracting read models from three route handlers, which
is its own change with its own review, and it needs runtime verification this
session cannot perform. Recorded as **open** rather than approximated.

## 5. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 575 passed, 0 failed (WP8: 12 565; +10) |

New coverage: `source-failure-classifier.test.ts` (7), plus 3 new cases in
`intelligence-server.test.ts` including the whole-payload leak check.

## 6. Acceptance

| Plan acceptance item | Result |
|---|---|
| 9 sections × 7 read states | **PARTIAL** — 8 of 9 sections; each carries the full state vocabulary |
| real-account render evidence | **UNKNOWN** — needs an authenticated session |
| failure-code and source-count accuracy | **PASS** for the codes (classifier + dictionary, 7 cases) and for the count (`servedCount` excludes degraded); the *live* counts are UNKNOWN |

## 7. Rollback

Section-by-section, as the plan asks. The classifier is additive: reverting
`section()`'s two-line change restores the previous behaviour, and the
`failureCode` field is optional so no reader breaks. The snapshot prop is one
hunk on the route.
