# Phase E Implementation Report — WP-21 … WP-25

**Worktree:** `/Users/harmelek/Adsecute-zero-base` · **Branch:** `codex/adsecute-zero-base-implementation`
**Phase D accepted head:** `1d769b534` · **Phase E head:** `91bf1fbd8`
**Authoritative plan:** SHA-256 verified `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`

**Status: PHASE_E_BLOCKED.** WP-21, WP-22 and WP-23 are complete and proven.
**WP-24 and WP-25 are not started.** Section 6 states exactly why I stopped
rather than continuing.

`/Users/harmelek/Adsecute` was not modified. Nothing was pushed, deployed, or
migrated; no provider was contacted; no flag was enabled; no live data changed;
no prior commit was rewritten. WP-26 was not started.

## Commits

| WP | Commit | Surface | Tests |
|---|---|---|---|
| 21 | `e948bfdd7` | Analytics, landing pages, SEO, GEO (4 routes) | 31 |
| 22 | `a15dfc63c` | Reports library/builder/viewer/print/disabled share (5 routes) | 35 |
| 23 | `91bf1fbd8` | Integrations, Team, Business, Plan + callback (5 routes) | 24 |
| 24 | — | Ops shell and 16 Ops leaves | **not started** |
| 25 | — | Public and marketing surfaces | **not started** |

## 1 · WP-21 — Analytics, landing pages, SEO, GEO · `e948bfdd7`

**Files.** `lib/zero-base/analytics/analytics-contract.ts`,
`components/zero-base/analytics/{analytics-views,analytics-clients}.tsx`, four
`app/c/[businessId]/analytics/*/page.tsx` routes, 2 test files.

Adapters were written **after** inventorying the real handlers. Two disclosures
the GEO endpoint forces:

- `aiPageCount` is `Math.min(rowCount, 50)` in `app/api/geo/overview/route.ts`.
  It is a proxy capped at 50, so the disclosure shows whenever the number does —
  printing "50" bare reports a ceiling as a measurement — and a value sitting on
  the cap is additionally flagged.
- `top3Priorities` is already `.slice(0, 3)` server-side. The surface renders
  exactly what it received, never padding or re-slicing, and says others may
  exist.

Dual sources degrade rather than blank: when one of GA4 / Search Console fails,
the half that answered is still shown and the half that did not is named with
the provider's verbatim error. A measured zero carries
`data-measured-zero="true"` and stays a measurement; an absent value renders
"Not served" with its reason. Caps print only when the backend served one.

The AI insight is read only, and a comment-stripped scan over the shipped
analytics files asserts **zero call sites** to `/api/ai/insights/generate`.

## 2 · WP-22 — Reports · `a15dfc63c`

**Files.** `lib/zero-base/reports/{report-catalog,builder-model}.ts`,
`components/zero-base/reports/{report-views,report-clients}.tsx`, five
`app/c/[businessId]/reports/**` routes, 2 test files.

The catalog is read from the vendored `report-catalog.json`: **exactly 5
renderable + 4 coming-soon = 9**, with identity and order asserted. Search
Console and Klaviyo stay separate rows. A coming-soon source is **disabled,
never hidden** — hidden reads as "this data does not exist" rather than "not
wired yet".

CSV is table-only, with the reason shown where the control would be. Unsafe
breakdowns refuse aggregation because one entity appears in more than one row.

The builder is **one model for keyboard and pointer**, not a reduced fallback.
Undo replays the exact prior state rather than a computed inverse: a widget
clamped at the grid edge does not move back the way it moved in. Moves clamp
instead of pushing a widget off-canvas where the keyboard could not reach it.
Each widget owns its state, so a failed source shows an error and retry inside
its own frame while neighbours keep rendering.

**WP-03A exercised against the ACTUAL share route in both states:** flag-on
fails closed with **zero report lookups and zero access checks**, so a refusal
cannot probe which report ids exist; flag-off still looks the report up,
preserving legacy compatibility. No stored snapshot was touched, and no token
revoke/rotate was invented. The canonical UI has zero mint/share controls —
asserted in the DOM and by a call-site scan — and shows the real prerequisites,
including the Appendix C authorization G12 requires.

## 3 · WP-23 — Manage · `91bf1fbd8`

**Files.** `lib/zero-base/manage/manage-contract.ts`,
`components/zero-base/manage/{manage-views,manage-clients}.tsx`, five
`app/c/[businessId]/manage/**` routes including the provider callback, 2 test
files.

Provider health is per provider; an unmentioned provider is **unknown**, not
disconnected. There is no aggregate health badge and the surface says why.

**A write is not a read-back.** Reconnect and delete each issue an independent
read afterwards, and only an observation that matches the intent may be
reported as confirmed. Business deletion treats a subsequent 404 as the only
confirmation and can never print "deleted" from a response — a business that
still exists while the UI says it is gone is unrecoverable confusion.

Economics divergence names the exact sources, values and consumers, because
"these differ" is not actionable. An unset value counts as divergence.
`recommendedMode` is rendered with no control of any kind in its section.

Plan is static, gates nothing, says so, and a scan asserts **zero call sites**
to `/api/billing`.

## 4 · Checked API boundary matrix

| Boundary | Verdict |
|---|---|
| `/api/analytics/overview` | adapted; malformed refuses visibly |
| `/api/analytics/landing-pages` | adapted; caps only when served |
| `/api/seo/overview` | adapted; role gate stated, not hidden |
| `/api/geo/overview` | real `sources`/`kpis`/`top3Priorities`; 50-proxy and top-three disclosed |
| `/api/ai/insights/latest` | read only; absent state stated |
| `/api/ai/insights/generate` | **zero call sites**, scan-proven |
| `/api/reports` GET/POST | list + duplicate; a 200 without `reports` is degraded |
| `/api/reports/[reportId]` GET/PATCH | viewer/print read and builder save |
| `/api/reports/[reportId]/share` POST | both flag states driven against the real route |
| `/api/integrations/status` | per-provider adaptation; unknown ≠ not connected |
| `/api/integrations` POST | reconnect + independent read-back |
| `/api/team/members` | list; permissions stated |
| `/api/business-cost-model` | economics + read-only recommendedMode |
| `/api/businesses/[businessId]` DELETE | delete + separate 404 read-back |
| `/api/billing` | **zero call sites**, scan-proven |

## 5 · Gates at `91bf1fbd8`

typecheck 0 · lint 0 · **Vitest 8704 passed / 0 failed** (801 files; 61 skipped,
63 todo pre-existing) · migrations-from-zero PASS with all DB seams ·
selection-race seam PASS · creative:v2:safety 0 · frozen acceptance 22/22 ·
contract verify / freshness / fonts 0 · zero-base contract 17/17 · design 26/26 ·
responsive Playwright 72/72 · production build clean · credential-free smoke
**83 passed / 3 failed**.

The three smoke failures are **identical to the accepted Phase D baseline**
(83/3 there and here). They are pre-existing, need Meta and commercial data a
credential-free cluster cannot hold, and are unchanged by Phase E.

`git diff 1d769b534..HEAD` touches no resolver or decision-output file. No ADR
was required and none was added.

## 6 · Why I stopped — WP-24 and WP-25 are not started

WP-24 is 16 Ops leaves, each mirroring an `/admin` route through adapters, plus
role gating, a buyer-link-count-zero proof, repair failure/progress/read-back
semantics and 1280/768/390 coverage. WP-25 is ten public pages with legal and
pricing snapshots that must remain byte/semantically unchanged.

I did not have the remaining capacity to build either to the standard the
instruction sets — mounted routes, real payload fixtures, and interaction
evidence rather than isolated props. Phase D was rejected twice for exactly
that gap, and producing two more work packages of unproven surface would repeat
it at larger scale.

What remains for each is listed rather than estimated:

**WP-24** — `/ops` shell plus 16 leaves; adapters over existing `/admin` auth,
read models, actions and health boards; non-admin blocked; buyer navigation and
link count to Ops = 0; every admin legacy-to-Ops tuple resolving; repair
failure/progress/read-back with no false receipt; `/admin` left intact.

**WP-25** — Ledger presentation across root/about/product/pricing/contact/
privacy/terms/security/ai-transparency/demo; legal and pricing snapshots
unchanged; public pages usable without a session; no product-only token leak;
1440/390/320 coverage.

## 7 · Rollback

```
git revert 91bf1fbd8   # WP-23
git revert a15dfc63c   # WP-22
git revert e948bfdd7   # WP-21
```

Each is an additive set of canonical routes; reverting one leaves the others and
all legacy surfaces working. No server behaviour was changed in Phase E — the
report share route was exercised, not modified.

## 8 · Limitations

1. **WP-24 and WP-25 are not started** (§6).
2. The three legacy smoke failures in §5 remain, unchanged from Phase D.
3. These routes compose client-side over existing endpoints, matching the
   pattern accepted in Phases C and D.
4. Responsive evidence for the new Phase E surfaces is component-level: the DOM
   is asserted to carry every metric at any viewport. No new static harness page
   is claimed as proof of network behaviour.
5. Report viewer/print read `/api/reports/[reportId]`; where that endpoint does
   not serve per-widget rows, widgets render their empty grammar rather than
   fabricated data.

## 9 · Worktree state

Clean and fully committed at `91bf1fbd8`. Nothing was pushed.
