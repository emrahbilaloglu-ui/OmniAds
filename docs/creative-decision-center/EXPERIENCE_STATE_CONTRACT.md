# Experience State Contract

Status: Phase A. Vocabulary and presentation rules only. No resolver, engine,
authority, or provider-write semantics are defined or changed here.

## What this document is, and what it is subordinate to

This binds **user-facing presentation** to states that already exist elsewhere.
It is not a new state machine and not a second source of truth.

Authority order for anything in this file:

1. `AGENTS.md` and current user/repository instruction.
2. `INVARIANTS.md`.
3. `DECISION_LOG.md` ADRs — in particular D032, D035, D059, D064, D070.
4. `docs/meta-market-ready-master-plan-2026-08-22.md` §9 (ortak read-state
   sözleşmesi), §9.1 (failure-code sözlüğü), §10 (mutation safety), §11
   (surface matrix).
5. This document.

§9 already defines the seven read states every surface serves — `loading`,
`refreshing-with-stale`, `success`, `empty-proven`, `partial`, `degraded`,
`refused` — plus the mutation states and the failure-code dictionary. **Those
remain canonical.** This document adds only the missing layer: for each
operator-visible condition, what a surface is permitted to *say*, what it must
never imply, and what recovery must remain visible.

Where §9 and this document could be read as disagreeing, §9 wins.

## The one rule

> Absence of evidence must never be presented as evidence of a benign state.

This is not a new principle. It is already ruled on:

- **D064** — absent currency evidence must say "account currency" rather than
  guess a unit; that is "presentation determinism only", with decision math
  unchanged.
- **D070** — a failed read collapsing into "no data" is behaviour INVARIANTS
  forbids.
- **INVARIANTS** — "Optional Meta event metrics remain null when no source
  payload key was observed. Source absence must not be converted to a measured
  zero." And: "Unknown delivery status must not be treated as active delivery."

## State vocabulary

The `provider state` column cites the real union in
`lib/meta/status-types.ts::MetaStatusResponse.state`:
`not_connected | connected_no_assignment | syncing | partial | stale | paused |
action_required | ready`.

`Write consequence` restates existing authority; it grants nothing.

| State | Authoritative source | Permitted label | Forbidden implication | Required visible recovery | Confidence / write consequence | Demo fixture |
|---|---|---|---|---|---|---|
| `connected` | provider status `state !== "not_connected"` | "Connected" | That an account is assigned, that data synced, or that decisions are available | none if nothing else is blocked | none by itself | may show connected |
| `not-connected` | provider status `not_connected` | "Not connected" | That absence of data is a product-side outage | Connect route for that provider | no decision may be served | may show |
| `assigned` | explicit provider-account assignment | "Account: «name»" | That the assignment was verified against the provider this request | none | none by itself | fixture account only |
| `not-assigned` | provider status `connected_no_assignment` | "No assigned account"; §9.1 `provider_account_not_assigned` | That the provider is disconnected or broken | link to Integrations assignment | decisions withheld; zero write authority | withheld |
| `syncing` | provider status `syncing`, or surface state `loading`/`refreshing` | "Syncing now" | That current figures are final | none; must not block reading stale-but-labelled data | confidence unchanged; no new write authority | may show |
| `synced-fresh` | a real completed sync/observation timestamp | "Synced «age» ago" | That every source is fresh — freshness is per source | none | normal | fixture timestamp |
| `stale` | provider status `stale`/`partial`, or age past the configured boundary | "Synced «age» ago" plus a stale marker | That the figure is current | refresh route where one already exists | D032: caps confidence, blocks scale, must **not** hide a mature severe stop-loss `cut` | may show |
| `never-synced` | connected, zero completed syncs | `SYNC_AGE_UNKNOWN_LABEL` | **That a sync completed** | provider status/recovery route | no decision confidence derived from age | may show |
| `unavailable-unknown` | surface registered with `asOf: null`; unparseable timestamp; failed sync status; absent status payload | `SYNC_AGE_UNKNOWN_LABEL` | **That a sync completed**; that the value is zero | the surface's existing recovery route, when one exists | GC-060/065/067/068: unknown freshness blocks hard scale and caps confidence, and does not hide a severe cut | must not fabricate an age |
| `decision-ready` | server-produced `decisionState: act` / `monitor` | server-owned verdict and action | That the action is executable — execution is a separate authority | n/a | per persisted decision only | `demo_synthetic_review_only` |
| `withheld` | non-null `blocked_action_type`; `decisionState: blocked` | server-owned held label + resolution | D059/D064: never an affirmative soft action; a held Cut is never `Fresh Test`; `buyerAction` is null | the server-owned `resolution.nextStep` | never executable; `authorized_action` null | withheld |
| `unauthorized` | role, reviewer, demo posture, kill switch | §9.1 `reviewer_read_only`, `demo_business_read_only`, `kill_switch_engaged` | That the control would work if retried | must be visible **before** the click, per §9 | zero write authority | demo is always read-only |
| `error` | schema, permission, migration, or source read failure | §9.1 `schema_not_ready`, `capability_read_denied`, `source_read_failed` | **That there is simply no data** (D070) | retry/support route where one exists | no decision may be derived | must fail the whole fixture, all-or-nothing |

### Label constants

`lib/provider-sync-vocabulary.ts` owns `SYNC_AGE_UNKNOWN_LABEL`. Every surface
that reports provider freshness imports it rather than restating a literal, so
the five current consumers cannot drift apart:

- `components/layout/v2/use-shell-signals.ts` (topbar chip)
- `components/google-ads/GoogleAdsIntelligenceDashboard.tsx` (Google Overview
  and Advisor)
- `components/google-ads/google-advisor-exact-adapter.ts`
- `components/overview/v2/platform-card.tsx` (Overview provider cards)
- `components/overview/AgencyToday.tsx` (agency freshness column)

`lib/provider-sync-vocabulary.test.ts` enforces this repo-wide: it fails if any
file under `app/`, `components/` or `lib/` restates the literal.

### Tone must match the label

Copy alone is not the claim. A pill that says "Sync age unknown" in success
green still asserts success, so tone is derived from the label the surface
actually renders, through `isUnknownSyncAgeLabel`:

- `unknown` / failed / null / unparseable → **neutral**;
- a completed sync with a valid timestamp → **positive**.

The helper still treats the previous em-dash form as neutral, so server-supplied
or persisted labels this release does not own cannot silently become positive.

Surfaces expose the resolved tone as `data-sync-tone="neutral" | "positive"`
(`components/overview/v2/platform-card.tsx`,
`components/google-ads/GoogleAdvisorExact.tsx`) so the contract is assertable
without depending on a colour value.

Out of scope here: a genuinely completed but **stale** sync still renders
positive. Giving `stale` its own tone is contract work, not a Phase A copy fix.

## Economics consumer mapping — traced (Phase B)

Phase A recorded this as unknown and attributed the disputed declaration to
`targetRoas`. **That attribution was wrong and is corrected here:** the
contested `consumers` array is on the **cost-model** fields, not on
`targetRoas`. The trace below is code-derived; each row cites the reader.

### The two records

| Record | Canonical source | Read through |
|---|---|---|
| Target pack (`targetRoas`, `breakEvenRoas`, `targetCpa`, `breakEvenCpa`, `defaultRiskPosture`) | `getBusinessCommercialTruthSnapshot(businessId).targetPack` (`lib/business-commercial.ts`) | `readMetaCommercialTargets` (`lib/meta/commercial-targets.ts:84`) |
| Cost model (`cogsPercent`, `shippingPercent`, `feePercent`, `fixedCost`) | `getBusinessCostModel(businessId)` (`lib/business-cost-model.ts:14`) | surfaced as the snapshot's separate `costModelContext` section (`lib/business-commercial.ts:1620`) |

They are **separate sections of one snapshot**, not one record. Nothing folds
the cost model into `targetPack`.

### Declared vs verified

| Declaration site | Record | Declared consumers | Verified |
|---|---|---|---|
| `lib/zero-base/home/home-server.ts:141` | target pack | `["Meta decisions"]` | **correct** (incomplete: Commercial Truth UI and Home also render it) |
| `lib/zero-base/home/home-server.ts:146` | cost model | `["Overview", "Google Ads"]` | **correct on both** |
| `components/zero-base/manage/manage-clients.tsx:766` | cost model | `["Decision engine", "Reports"]` | **contradicted on both** |
| `components/zero-base/manage/manage-clients.tsx:775` | `targetRoas` | `["Decision engine"]` | **correct** |
| `app/(dashboard)/overview/legacy-page.tsx:555,560` | both | duplicates the home-server pair | same as home-server |

The two surfaces therefore attribute the **same cost-model record** to
**disjoint** consumer sets.

### Verified target-pack consumers

Decision engine and gates: `lib/creative-decision-engine/` —
`jobs/ad-calibration-job.ts`, `data-source.ts`, `jobs/ad-decision-outcomes-job.ts`,
`spend-unit-resolver.ts`, `ad-account-decision-profile.ts`, `gates/ratio-zones.ts`,
`gates/target-resolution.ts`, `execution-safety.ts`, `jobs/lifecycle-job.ts`,
`simulation/structure-replay.ts`.
Meta serving: `app/api/meta/decisions-workspace/route.ts`,
`app/api/meta/recommendations/route.ts`, `app/api/meta/account-pulse/route.ts`,
`lib/meta/snapshot.ts`, `lib/meta/recommendations.ts`, `lib/meta/adset-decisions.ts`,
`lib/meta/commercial-action-authority.ts`,
`lib/meta/scenario-emitters/high-priority.ts`.
Presentation only: `components/commercial-truth/`, `components/meta/redesign/`,
`components/zero-base/home/trend-panel.tsx`.

### Verified cost-model consumers

- **Overview** — `app/api/overview-summary/route.ts:209`, `lib/overview-summary-support.ts`.
- **Google Ads** — `lib/google-ads/serving.ts:3638` feeding
  `lib/google-ads/commerce-signals.ts:49` margin bands.
- `app/api/business-cost-model/route.ts` (its own read/write route).

### Verified non-consumers

- **Reports does not read either record.** A search for
  `targetRoas|targetPack|getBusinessCostModel|commercialTruth` across all 12
  non-test report sources (`app/(dashboard)/reports/**`, `app/api/reports/**`)
  returns zero matches. The `"Reports"` entry at `manage-clients.tsx:766` names
  a consumer that does not exist.
- **The decision engine does not read the cost model.** It reads `targetPack`
  through `readMetaCommercialTargets`; a search for `costStructure` across
  `lib/creative-decision-engine/` and `lib/meta/` returns zero matches. The
  `"Decision engine"` entry at `manage-clients.tsx:766` is unsupported for the
  cost-model fields.

### Still unknown

- Whether `"Decision engine"` at `:766` was intended to mean the engine's
  *indirect* dependence on commercial truth generally, rather than on the
  cost-model fields it is attached to. Intent is not recoverable from code.
- Whether presentation readers should count as "consumers" at all. The label is
  ambiguous between *decision authority* and *anything that renders the value*.

### Why no label was changed in Phase B

The controller gate allows a change only when the mapping is already available
from **one existing canonical read path** and the edit is presentation-only
under an existing ADR. Neither holds: there is no runtime consumer registry —
this mapping was reconstructed by tracing ~30 modules — and correcting
`:766` means deciding what "consumer" denotes. That is an ADR decision, so the
declarations are left exactly as they are and the evidence is recorded instead.

## Gate A — resolved by D071

**Status: resolved.** The contradiction — Integrations reporting a connected,
assigned, freshly-synced Meta account while Decisions reported "No assigned
account" for the same business in the same session — is closed by
[D071](./DECISION_LOG.md), which resolves demo posture atomically across the
three reads that answer the assignment question.

### Root cause (retained)

| Side | Route | Was posture-aware | Authority |
|---|---|---|---|
| Integrations | `app/api/meta/status/route.ts:348` | yes | `getDemoMetaStatus()`, whose `assignedAccountIds` is a committed constant |
| Decisions picker | `app/api/meta/history/accounts/route.ts` | **no** | `business_provider_accounts` |
| Journal | `app/api/meta/history/route.ts` | **no** | `business_provider_accounts` |
| Workspace | `app/api/meta/decisions-workspace/route.ts` | **no** | `business_provider_accounts` |

Nine other Meta routes already branched on posture; these three did not.

### The three-read boundary

All three now resolve `readMetaBusinessDataPosture` **before any live read**.
What each then serves differs — the atomic boundary is when posture is
resolved, not what is served:

| Posture | Accounts | Journal | Workspace decision read model |
|---|---|---|---|
| `demo` | the intersection of `getDemoProviderAccounts("meta")` with `getDemoMetaStatus().assignedAccountIds` — exactly UrbanTrail DTC | zero entries, `page.total: null`, **plus** the `demo_journal_not_recorded` limitation; unassigned catalog account → 404 | **503 `demo_workspace_envelope_unavailable`**, before every live read — see the blocker below |
| `live` | unchanged persisted intersection; failed read still 500 | unchanged; failed read still 500 | unchanged, including full generation-bundle validation |
| `unverified` | `metaPostureUnavailable` 503 | `metaPostureUnavailable` 503 | `metaPostureUnavailable` 503, before every live read |

Fewer than three would not have worked: posture-blindness in any one of them
reproduces the defect, because the picker would offer an account the next read
refuses. Note the demo column is not one answer: the accounts picker and
History are served from the committed manifest, while Decisions refuses. The
fixture is not a Decisions read authority.

### Evidence and limitations

- The demo journal is **not** a proven-zero journal. The fixture records no
  provider actions, and inventing them is forbidden, so emptiness is stated
  through the existing `limitations` contract, which the History view already
  renders.
- The demo journal is rendered truthfully, not merely returned truthfully. The
  mounted view surfaces `demo_journal_not_recorded` in a visible status band
  outside the collapsed "Identity and join limits" disclosure, replaces the
  "No journal entries match" / "no keyed persisted rows" copy with
  "Demo journal is not recorded" plus the server sentence, and says
  "total unavailable" rather than "end of results" whenever `page.total` is
  null. Three of the four render tests fail against the previous view.
- **Zero live reads is proven at runtime**, not asserted. Demo and unverified
  requests to `decisions-workspace` reach none of `getDb`,
  `getProviderAccountAssignments`, `readMetaDecisionsWorkspaceReadModel`,
  `readMetaDecisionCampaignContextRows`, `resolveMetaCredentials`,
  `fetchMetaActiveAdConfigsReceipt`, `readMetaCommercialTargets`, or the
  account-pulse and lane-classify upstreams. Five of those six tests fail if the
  posture check is moved back inside `canonicalDecisionReadModel`.
- **There is no production composition seam.** Decisions fails closed with 503
  `demo_workspace_envelope_unavailable` because
  `MetaDecisionsWorkspacePayload.pulse` requires measured numbers
  (`pacing.mtdSpend`, `pacing.dayPace`, `roas.selected/d7/d14/d28`) with no
  unavailable representation, and its sources are not posture-aware. An earlier
  revision added a demo-only read-model composer; it was removed because that
  refusal left it with no caller. Serving a truthful demo Decisions workspace
  requires the shared posture layer.
- The committed fixture contract (`readDemoNativeCanonicalDecisionInventory`,
  all-or-nothing manifest/hash/epoch/count/identity validation) is unchanged and
  still serves the Creative briefing route. No Meta Decisions surface consumes
  it.
- Not done: the nine-route shared posture layer. It remains the durable fix and
  is deferred, not rejected.

### Rollback

Remove the posture branch from the three routes. The live paths beneath are
unchanged and resume being the only paths; the seam is additive and becomes
unreferenced, and `demo_journal_not_recorded` is an additive union member no
live response emits. No migration, no persisted state.

## ADR coverage

**The sync-label vocabulary needed no new ADR.** D064 already governs that
class: it permits hardening how an existing output is *served*, requires absent
evidence to be stated truthfully rather than guessed, and classifies that as
presentation determinism with decision math unchanged. That slice added no
decision core, no new calculation, no new authority, no route rename, no schema
change and no persisted-state change — it replaced one copy string on paths
whose `tone` and `freshnessState` were already `unknown`/`unavailable`.

**The three-read posture alignment did need one, and has it: D071.** It changes
which authority answers a question for a confirmed demo workspace, so it is an
architectural decision rather than a presentation correction.

An ADR is still required before: deriving the economics consumer mapping from
the real read path, changing any `decisionState` projection, making any state in
the table above grant or withdraw write authority, or introducing the
nine-route shared posture layer.

## Scope boundary

Implemented:

- the shared sync-label constant and its reuse across the five freshness consumers;
- D071's three-read demo posture alignment and the truthful demo History rendering;
- neutral-tone preservation where tone is derived from label text;
- focused tests pinning the vocabulary.

Explicitly **not** implemented, and not to be inferred as done:

- the shared posture layer for server-rendered canonical pages. Gate A is
  resolved **on the three API routes and on the legacy History body**, and is
  **not** resolved on the canonical `/c/[businessId]/meta/*` server pages. See
  "Surface coverage" below — this is the single most important limitation in
  this document;
- the economics consumer mapping — **traced in Phase B**; declarations
  deliberately left unchanged;
- recovery routes that do not already exist;
- any change to demo fixture seeding or account authority.

### Surface coverage — which History body carries the fix

`/platforms/meta/history` is a compatibility shim
(`lib/zero-base/compatibility-page.tsx`). Which body it serves depends on
`ZERO_BASE_UI_MODE`, which is set by the separate
`.github/workflows/zero-base-production-rollout.yml`, not by a deploy:

| mode | body served | demo posture correct? |
| --- | --- | --- |
| `off` (also the value an unset variable parses to) | legacy `app/(dashboard)/platforms/meta/history/history-view.tsx` | **yes** — D071 |
| `on` / `allowlist` / `internal` (when the route is canonical for the actor) | canonical `app/c/[businessId]/meta/history/page.tsx` | **no** |

The repository's own authority agrees on which body is which.
`lib/meta/surface-registry.ts` declares for `meta-history`:

```
canonicalRoute: "/c/[businessId]/meta/history"
legacyRedirect: ["/platforms/meta/history"]
mountedBody:    "components/zero-base/meta/history/history-view.tsx"
```

So the body this package corrected is the one the registry classifies as the
legacy redirect target, and the registry's declared `mountedBody` for this
surface is the canonical body, which does **not** carry the correction.

The canonical page also does not read through `GET /api/meta/history`. It calls
`readMetaHistoryAccounts`, `readMetaHistoryAssignedAccountIds` and
`readMetaHistoryJournal` directly in the server component, and none of the five
canonical `/c/**/meta/*` pages calls `readMetaBusinessDataPosture` — verified by
source scan on this tree.

`npm run meta:verify-mounted-bodies` does not catch this: it proves a declared
`mountedBody` is *reachable* from some route entry point, and both bodies are.
Reachability is not the same question as which body a given rollout mode
serves.

Measured, not inferred: the demo business row has `is_demo_business = true` and
**zero** rows in `business_provider_accounts`. So on the canonical page
`assignedAccounts.length === 0` is reached and the surface early-returns

> No Meta account is assigned to this business, so there is no journal to read.

while Integrations, reading the same business through the posture-aware
`/api/meta/status`, reports the account as connected and assigned. That is the
original Gate A contradiction, unchanged, on that surface. The early return also
means `HistoryClient` never mounts, so the corrected `/api/meta/history`
response is never requested there.

This is a pre-existing property of the canonical body. No change in this package
introduced it and no change in this package alters that body. It is recorded
here because a reader would otherwise reasonably conclude from "Gate A resolved"
that the contradiction is gone wherever History is served. It is not.

### Responsive assessment

390, 1280 and 1366 were measured in a real browser and corrected.
**320 has now also been measured** on the legacy body and needed no correction:
document, filter band, results header, journal section and notice band all
report `scrollWidth === clientWidth`, zero elements extend past the right edge,
Reset and Apply are full-width and inside the viewport, and the account identity
and result count each wrap to two readable lines rather than clipping. 1440 was
measured at the same time and is clean.

Not covered by that sweep: the canonical body's responsive behaviour, which was
not measured because it is a different component tree.
