# Phase D Implementation Report — WP-16 … WP-20

**Worktree:** `/Users/harmelek/Adsecute-zero-base` · **Branch:** `codex/adsecute-zero-base-implementation`
**Phase C accepted head:** `a09e6addb` · **Phase D head:** `173280181` · **Status: all four blockers corrected — see §0**
**Authoritative plan:** `ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md`
(SHA-256 verified `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`)

`/Users/harmelek/Adsecute` was not modified. Nothing was pushed, deployed, or
migrated in production; no provider was contacted; no mutation flag was
enabled; no live data changed; no prior commit was rewritten. WP-21 was not
started.

## 0 · Acceptance review rejected Phase D — three of four blockers corrected

**The `PHASE_D_COMPLETE` claim at `23128cb62` was wrong.** A code-level review
found production reachability and route-schema defects that my own tests could
not catch, because they instantiated invented view types instead of comparing a
request body or a response shape to a real route. That is the same testing
mistake that failed WP-14 in Phase C, repeated across a whole phase.

| Blocker | What was actually shipped | Status |
|---|---|---|
| 1 — public share not mounted | `share-media.tsx` was imported only by tests; `app/share/creative/[token]/page.tsx` still mounted `PublicCreativeSharePage`, whose `CreativeRenderSurface mode="asset"` takes the image-only branch. The video, captions, error and retry behaviour was **unreachable in production**. | Corrected — `173280181` |
| 2 — creation flows unreachable | `CreativeBriefsClient` always passed `creativeId: null` and no `onCreate`, so brief creation was permanently blocked; `CreativeSharesClient` had no create flow or acknowledgement UI at all. | Corrected — `8f19290b0` |
| 3 — Launchpad claimed absent workflows and sent invalid bodies | The client only listed/deleted templates while the UI claimed drafts, template creation and validation. `{businessId, duplicateOf}` and `{businessId, adIds}` are not the route contracts. | Corrected — `81a8526bf` |
| 4 — Google client types did not match real payloads | `/overview` serves `{kpis, kpiDeltas, topCampaigns, insights, summary, meta}`, read as `{accounts, rows}`; the advisor cast produced `step.accountId.replace()` on `undefined` — a real runtime crash. | Corrected — `81a8526bf` |

All four are now corrected. Section 10 states the evidence for each.

## Commits

| WP | Commit | Surface |
|---|---|---|
| 16 | `10b1d35d3` | Creative performance + detail/history |
| 17 | `9f630c857` | Briefs, inbox, copies, landing pages, shares, public share |
| 18 | `50c27518b` | Meta Launchpad preparation |
| 19 | `87be1e605` | Five Google read leaves |
| 20 | `23128cb62` | Google manual plan + reference write posture |
| B3+B4 correction | `81a8526bf` | Real route contracts for Launchpad and Google |
| B2 correction | `8f19290b0` | Reachable brief and share creation |
| B1 correction | `173280181` | Public creative share mounted on the real route |

## 1 · WP-16 — Creative performance and detail/history · `10b1d35d3`

**Files.** `lib/zero-base/creative/{engine-posture,performance-adapter,detail-adapter,route-scope}.ts`,
`components/zero-base/creative/{performance-view,detail-view,creative-media,performance-client,detail-client}.tsx`,
`app/c/[businessId]/creative/performance/page.tsx`, `app/c/[businessId]/creative/[creativeId]/page.tsx`,
2 test files. **49 tests.**

Data logic was extracted from `StudioOsView`; the component is never mounted —
it is 3,800 lines of view and data tangled together, and mounting it would
carry its whole legacy surface into a canonical route.

**The five Engine V3 postures** are derived from the served flags, not invented:
`unavailable` (the posture read failed — distinct from knowing the engine is
off), `disabled`, `shadow_only`, `hidden`, `serving`. Shadow is checked before
visibility, because a shadow decision that happens to be visible is still one
nobody stands behind — the most dangerous of the five confusions. Only
`serving` offers an action; a held decision offers none regardless.

The decision band comes from the served posture and the served label. No code
here derives a band from a metric: that is `buyerAction` computation wearing a
different name. No row-level `brief_variation` was introduced.

Also proven: a missing metric renders "Not served" with a reason and never `0`
(a real zero stays visible as a measurement); money uses the account's own
currency and says so when none was served rather than defaulting to `$`; caps
are disclosed with their own numbers and say "the backend did not supply a
total" rather than claiming "all"; the legacy null-identity filter is preserved
**and counted**; a deep-linked detail must belong to the URL's account, with
"belongs to another account" and "does not exist" as separate refusals; the
Decisions link retains account, creative and the ad-keyed row.

## 2 · WP-17 — Briefs, inbox, copies, landing pages, shares, public share · `9f630c857`

**Files.** `lib/zero-base/creative/{studio-adapters,share-acknowledgement}.ts`,
`components/zero-base/creative/{studio-views,studio-clients,share-media}.tsx`,
five `app/c/[businessId]/creative/*/page.tsx` routes,
`app/api/creatives/share/route.ts` (acknowledgement gate), 3 test files.
**43 tests.**

**The acknowledgement contract is the one server change.** A buyer share puts
provider-reported money in front of someone outside the workspace on a link
that outlives the conversation. The POST now requires an explicit
acknowledgement and answers **400** without it, checked on the exact value —
`true`, `"yes"` and `1` all mean somebody wired a control without reading what
it attests to. Six tests drive the **real route** to prove it.

That closed a real hole: an existing test documented that a caller omitting
`audience` defaults to buyer, so a legacy caller could ship money outward with
no warning. That test now sends the acknowledgement and still asserts the
compatibility default, keeping what it actually protected.

Also: no brief delete control anywhere, with the reason stated (a brief is
lineage); creation refused unless creative and account are both known;
landing-page caps print 250/100 only when the backend serves them, otherwise
`Backend cap not supplied`, with no obsolete top-20 language; unsourced inbox
and copy rows say so; the share ledger separates revoked from expired for the
owner while the public surface deliberately cannot; public video uses native
(keyboard-operable) controls, attaches captions only when served, and its retry
re-attempts the load rather than only clearing the message. No workspace
identity appears on the public share.

## 3 · WP-18 — Meta Launchpad preparation · `50c27518b`

**Files.** `lib/zero-base/launchpad/launchpad-contract.ts`,
`components/zero-base/launchpad/{launchpad-view,launchpad-client}.tsx`,
`app/c/[businessId]/meta/launchpad/page.tsx`, 2 test files. **34 tests.**

Execution is held closed in three places rather than one:

1. **Zero call sites.** The canonical bundle contains no reference to the
   launch or add-to-existing endpoints. A test walks the shipped files and
   asserts the strings are absent, then **guards the guard**: it proves the
   matcher fires on the forbidden shape, does not fire on `/meta/templates`,
   and that it scanned a non-empty set. Comments are stripped first, because
   the point is call sites rather than vocabulary — a doc comment explaining
   the absence is evidence *for* the rule.
2. **Disabled with exact prerequisites**: no durable rollback, no canonical
   launch decision origin, no confirmation bound to the request.
3. **Stated non-existence**: there is no rollback for a launch, and there is no
   Google Launchpad — this surface is Meta only.

Templates offer duplicate and delete and **no edit**, matching an API with GET,
POST and DELETE and no update. Bulk ad status exists only behind the
server-owned mutation flag, caps at 20, rejects 21 in the form before any
request, and reports **per-item** outcomes — an item the server did not mention
is `unknown`, never assumed applied.

## 4 · WP-19 — Five Google read leaves · `87be1e605`

**Files.** `lib/zero-base/google/google-contract.ts`,
`components/zero-base/google/{google-views,google-clients}.tsx`, five
`app/c/[businessId]/google/*/page.tsx` routes, 2 test files. **29 tests.**

Scope is stated on every surface. Where a sum would be dishonest the surface
refuses one: two accounts in different currencies cannot become one number, and
two in different time zones do not share a "yesterday". Overview and Pulse are
merged **per account** rather than collapsed into a total that hides its origin.

`unavailable` and `0` stay separate; `partial` and `rate_limited` are their own
states, with the retry window shown when Google supplied one. Advisor groups
served recommendations into Do now / Next / Later by the urgency the server
assigned — an item with no urgency goes to Later rather than being promoted,
because guessing upward manufactures urgency the engine never expressed.
Default-off reference cards carry all five required fields and are not rendered
at all when one is missing.

Google vocabulary stays Google: a test walks the shipped Google files
(comments stripped) and asserts no Meta lane word, owner, due date, `pause_ad`,
repair-gap or Launchpad appears, and the rendered advisor text is checked too.

## 5 · WP-20 — Google manual plan and reference write posture · `23128cb62`

**Files.** `lib/zero-base/google/manual-plan.ts`,
`components/zero-base/google/{plan-view,plan-client}.tsx`,
`app/c/[businessId]/google/plan/page.tsx`, 2 test files. **63 tests.**

The manual path is primary and first on the page. Order comes from the served
rank; unranked items follow rather than being re-sorted by a metric. CSV
escaping is RFC 4180 with CRLF, and a test asserts the field count holds when a
rationale contains a comma — each of comma, quote and newline silently shifts
every later column in a naive export. Deep links always carry the account id.

**"Reconciliation" is a Meta word** naming a durable process that settles an
ambiguous Meta write; Google has none here, so the pending copy says what to
check in Google Ads instead. There is **no `pause_ad` control** — absent, not
disabled, because a greyed control implies it is coming; a test asserts both
the string and any POST are absent from the shipped Google files.

Reference write states are shown for single and batch, both disabled, both
stating that no Google mutation layer exists in this programme. Batch
validation enforces one entity type in one account up to 250 items and executes
nothing. The partially-applied specimen renders **only because**
`partially_applied` is a real `GoogleExecutionStatus` in the served contract.

---

## 6 · Gates at `23128cb62`

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | 0 problems |
| Full Vitest | `npm test` | **8558 passed · 0 failed** (793 files; 61 skipped, 63 todo pre-existing) |
| Migrations from zero | `npm run test:migrations-from-zero` | PASS (incl. both Phase C seams) |
| Provider account selection seam | `npm run test:selection-race-seam` | PASS, exit 0 |
| Creative V2 safety | `npm run creative:v2:safety` | exit 0 |
| Native-ad frozen acceptance | `npm run creative:decision:native-ad-frozen-acceptance` | 22/22 |
| Design contract verify | `npm run zero-base:contract:verify` | exit 0 |
| Contract freshness | `npm run zero-base:contracts:check` | exit 0 |
| Font provenance | `npm run zero-base:fonts:verify` | exit 0 |
| Zero-base contract tests | `npm run test:zero-base:contract` | 17/17 |
| Zero-base design/theme | `npm run test:zero-base:design` | 26/26 |
| Responsive Playwright | `npm run test:zero-base:responsive` | 60/60 (54 harness pages) |
| Production build | `npm run build` | Compiled successfully; 19 canonical `/c/[businessId]` routes |
| Local production smoke | credential-free (§6.1) | 71 passed · 3 failed · 1 skipped |

Test growth across Phase D: **8418 → 8461 → 8495 → 8524 → 8558**, from the
Phase C accepted baseline of 8369.

**Resolver check.** `git diff a09e6addb..HEAD` touches no file under
`lib/creative-decision-engine/`, `lib/creative-decision-center/`,
`lib/archive/`, and no `lib/meta/recommendations*`. No resolver semantic change
was needed, so no ADR was required and none was added. No row-level
`brief_variation` was introduced and no UI computes `buyerAction`.

### 6.1 · Local smoke — the same three pre-existing failures

```
reviewer-smoke.spec.ts:71           Meta recommendations and creative dashboard
commercial-truth-smoke.spec.ts:322  Commercial Truth under Main, out of Settings
commercial-truth-smoke.spec.ts:367  dedicated page, Meta operating mode, Creative dashboard
```

These are **identical to the accepted Phase C baseline** — 71 passed / 3 failed
there and here. They were previously measured as pre-existing by running the
same smoke at the Phase B head, and they need Meta and commercial data a
credential-free local cluster cannot hold. Phase D did not change them.

## 7 · Rollback

Per work package, newest first. Each is an additive set of canonical routes;
reverting one leaves the others and all legacy surfaces working.

```
git revert 23128cb62   # WP-20
git revert 87be1e605   # WP-19
git revert 50c27518b   # WP-18
git revert 9f630c857   # WP-17
git revert 10b1d35d3   # WP-16
```

WP-17 is the only one with a server-behaviour change. Reverting it restores the
previous share POST; the acknowledgement can also be relaxed without deleting
any existing share, since it gates creation only.

## 8 · Limitations, stated rather than hidden

1. **The three legacy smoke failures in §6.1 remain failing.** They predate
   Phase C, are unchanged by Phase D, and need data a credential-free cluster
   cannot hold.
2. **No provider is contacted anywhere in Phase D**, and no mutation flag was
   enabled. Launchpad execution and Google writes are unreachable by
   construction, not merely disabled — proven by call-site scans rather than by
   flag state.
3. **Client-side composition.** These canonical routes authorize on the server
   and read their existing endpoints from a client boundary, matching the
   pattern accepted in Phase C for Decisions. Server-side composition would
   require request-scoped read models several of these endpoints do not expose.
4. **Responsive evidence is the existing harness.** The 54 harness pages cover
   the Phase A–C surfaces at 1440/390/320. Phase D's completeness at narrow
   widths is proven in the component suite by asserting the DOM carries every
   metric at any viewport — layout is CSS, and a metric dropped on mobile would
   be a missing node. No new static harness page is claimed as proof of network
   behaviour.
5. **The public share serves no captions**, because the `SharePayload` contract
   has no captions field. This is a real accessibility limitation of the
   contract, disclosed rather than papered over; adding captions would need a
   payload change outside this phase.
6. **Advisor horizon mapping** reads the server's `urgency` vocabulary
   (`high`/`medium`/`low` and `do_now`/`next`). A future server vocabulary
   would map to `later` rather than being guessed upward.
7. **WP-21 was not started**, and neither was Phase E.

## 9 · Worktree state

Clean and fully committed at `23128cb62` on
`codex/adsecute-zero-base-implementation`. Nothing was pushed.


---

## 10 · Correction detail and remaining blocker

### 10.1 · Blocker 4 — Google payload adapters (`81a8526bf`)

`lib/zero-base/google/payload-adapters.ts` validates what was actually
received and returns an explicit refusal when the required fields are absent.
**A 200 is not a shape**: a body with the wrong fields now degrades visibly
instead of rendering an empty surface labelled "serving".

Real fields are mapped explicitly — `doBucket` (not a re-derived urgency word),
`rankScore` as the ordering semantic, `summary`/`why`, `executionTargetType`,
`executionTargetId`, `deepLinkUrl`. `googleDeepLink` now returns the URL Google
served, validated as an https `google.com` URL, and **null** otherwise, so the
surface withholds the link. The previous version assembled one from an
`accountId` the recommendation never carries, which crashed.

Account scope moved to a server-owned reader, `/api/zero-base/google/scope`,
composing the existing assignment authority with the persisted
`provider_accounts` profile. It performs **no provider call** —
`fetchGoogleAdsAccounts` would have contacted Google — and currency/timezone
stay nullable so unserved reaches the surface as unserved.

17 adapter tests use the real payload key sets as fixtures, including one that
asserts the old `{accounts, rows}` assumption is now refused.

### 10.2 · Blocker 3 — Launchpad real contracts (`81a8526bf`)

Drafts list and create through `/api/launchpad/meta/drafts` with the
`name`+`payload` the route requires. Duplicate-to-change reads the immutable
served template and POSTs `{businessId, providerAccountId, name, payload}` —
`duplicateOf` alone was never the contract. Validation runs the real
`/validate` endpoint with error focus.

**Bulk ad status is withheld** with an explicit reason even when the mutation
flag is on. The real handler requires per-item exact ad and creative identity
plus a canonical action origin; this page holds none of it, and assembling that
in the browser would invent exactly the authority the write contract exists to
refuse. `BULK_WITHHELD_REASON` states this on the surface, and it is listed
among the things that do not work. Every untrue "What works today" line was
rewritten to match a mounted, tested call.

### 10.3 · Blocker 2 — reachable creation (`8f19290b0`)

Reading the brief route showed the block was also mis-stated: its lineage is a
**decision snapshot**, not a creative id. `parseCreateMetaCreativeBriefRequest`
requires an immutable `sourceDecision` with a UUID `snapshotId` and a `trigger`.
`canCreateBrief` now checks that lineage and blocks **before any POST**, naming
which piece is missing. Lineage comes from the URL; on success the list is
re-read.

Share creation exists with explicit audience selection. A buyer share cannot be
submitted until the operator ticks an acknowledgement that **displays the actual
warning text** they are attesting to, and the POST carries the exact value, so
the server's 400 stays a real gate the UI can satisfy.

### 10.4 · Blocker 1 — public creative share (`173280181`)

`app/share/creative/[token]/page.tsx` now mounts the canonical composition, and
`PublicCreativeSharePage` is referenced by **no route**, so the legacy path
cannot bypass the sanitization or the media behaviour.

**Sanitization drops rather than hides.** `toPublicShare` does not copy
`businessId`, `providerAccountId`, `businessName` or `clientEmail`, so a later
edit to the page cannot accidentally render one. Row keys are opaque (`c1`,
`c2`) rather than internal creative ids; alt text is the creative's own name;
media-missing reasons carry no identity; and page metadata is a **constant** —
deriving a title from the share would publish the workspace's own words to
crawlers and would differ between a live and a dead token, which itself tells a
stranger the link was once real.

**Media is mapped from the actual fields.** `preview.render_mode` decides, with
`preview.video_url` for video and
`image_url`/`mediaPreviewUrl`/`previewUrl`/`imageUrl`/`thumbnailUrl` for image.
A video with no playable source says so rather than silently showing its
poster: a still frame the viewer cannot play is worse than an honest sentence.

**No captions, and no claim of captions.** The `SharePayload` contract carries
no captions field, so no `<track>` is mounted and no caption support is
asserted. Inventing one would promise an accessibility affordance that silently
does nothing. The no-caption state is proven at the component, route-composition
and browser levels.

**Video is keyboard-operable** through native controls; missing media, load
error and Try again are production-reachable, and the retry re-attempts the load
rather than only clearing the message.

**Every dead token is one state.** `getCreativeShareSnapshot` collapses
revoked, expired, rotated-away, malformed and never-existed into a single null,
and the page keeps them collapsed behind one composition and one sentence.

**Evidence.**

| Claim | How it is proven |
|---|---|
| Rotation kills the old token and the new one works | `scripts/ephemeral-postgres-public-share-seam-child.ts` — real store, real read path, inside `migrations-from-zero` |
| Every dead state is indistinguishable | Same seam: revoked, expired, rotated-away, malformed and never-existed all resolve to `null` |
| No workspace identity leaks | Same seam plants five real secrets and asserts none survives `toPublicShare`; the route tests assert none appears in the rendered DOM, alt text or missing-media copy; the browser tests assert none appears in the page HTML |
| The route mounts this composition | A test reads `app/share/creative/[token]/page.tsx` and asserts it imports the canonical page and `toPublicShare`, and contains neither `PublicCreativeSharePage` nor `MOCK_SHARE_PAYLOAD` |
| Media, error and retry at every width | 18 route-level tests over real `SharePayload` fixtures + 12 Playwright checks at 1440/390/320 × light+dark |

A `ShareMedia` test in isolation is what let the unmounted composition pass
acceptance the first time; none of the evidence above rests on it.

### 10.5 · Boundaries re-audited

| Boundary | Verdict |
|---|---|
| `/api/meta/creatives` (performance, detail) | rows/`totalCreativeCount` read defensively; absent fields render as unavailable |
| `/api/creatives/decision-engine-v3` | `status` + `flags` only; a failed read is `unavailable`, not `disabled` |
| `/api/meta/creative-briefs` GET/POST | POST body corrected to the real `sourceDecision`/`content`/`idempotencyKey` contract |
| `/api/creatives/inbox`, `/api/meta/copies` | list reads; unsourced rows disclosed |
| `/api/analytics/landing-pages` | caps passed through; absent stays `Backend cap not supplied` |
| `/api/creatives/share` GET/POST | create now sends the acknowledgement; 400 gate proven against the real route |
| `/api/creatives/share/[token]` DELETE/POST | revoke and rotate; rotation-invalidates-old proven against the real store |
| `/api/launchpad/meta/{drafts,templates,templates/[id],validate}` | corrected to the exact route bodies |
| `/api/launchpad/meta/bulk-ad-status` | **withheld**; the exact per-item contract cannot be built here |
| `/api/launchpad/meta/{launch,add-to-existing}` | zero call sites, scan-proven |
| `/api/google-ads/{overview,advisor,search-intelligence,products,assets}` | adapted to real payloads; malformed refuses visibly |
| `/api/zero-base/google/scope` | new server-owned reader; DB reads only, no provider call |
| `/share/creative/[token]` | corrected: mounts the canonical sanitized composition; legacy page unmounted |

### 10.6 · Gates after the corrections

typecheck 0 · lint 0 · **Vitest 8614 passed / 0 failed** (795 files) ·
migrations-from-zero PASS **including the new public-share seam** ·
selection-race seam PASS · creative:v2:safety 0 · frozen acceptance 22/22 ·
contract verify / freshness / fonts 0 · zero-base contract 17/17 · design 26/26 ·
responsive **72/72** (66 harness pages) · build clean · credential-free smoke
**83 passed / 3 failed** — the same three pre-existing failures as the accepted
Phase C baseline, unchanged.

`git diff a09e6addb..HEAD` still touches no resolver or decision-output file.
