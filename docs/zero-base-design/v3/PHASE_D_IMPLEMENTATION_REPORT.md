# Phase D Implementation Report — WP-16 … WP-20

**Worktree:** `/Users/harmelek/Adsecute-zero-base` · **Branch:** `codex/adsecute-zero-base-implementation`
**Phase C accepted head:** `a09e6addb` · **Phase D head:** `23128cb62`
**Authoritative plan:** `ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md`
(SHA-256 verified `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`)

`/Users/harmelek/Adsecute` was not modified. Nothing was pushed, deployed, or
migrated in production; no provider was contacted; no mutation flag was
enabled; no live data changed; no prior commit was rewritten. WP-21 was not
started.

## Commits

| WP | Commit | Surface |
|---|---|---|
| 16 | `10b1d35d3` | Creative performance + detail/history |
| 17 | `9f630c857` | Briefs, inbox, copies, landing pages, shares, public share |
| 18 | `50c27518b` | Meta Launchpad preparation |
| 19 | `87be1e605` | Five Google read leaves |
| 20 | `23128cb62` | Google manual plan + reference write posture |

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
5. **Advisor horizon mapping** reads the server's `urgency` vocabulary
   (`high`/`medium`/`low` and `do_now`/`next`). A future server vocabulary
   would map to `later` rather than being guessed upward.
6. **WP-21 was not started**, and neither was Phase E.

## 9 · Worktree state

Clean and fully committed at `23128cb62` on
`codex/adsecute-zero-base-implementation`. Nothing was pushed.
