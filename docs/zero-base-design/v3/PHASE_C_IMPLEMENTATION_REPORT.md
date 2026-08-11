# Phase C Implementation Report — WP-11 … WP-15

**Worktree:** `/Users/harmelek/Adsecute-zero-base` · **Branch:** `codex/adsecute-zero-base-implementation`
**Phase B accepted head:** `da7eb3298` (its last code commit: `aaadbdd58`) · **Phase C head:** `7889d4812`
**Authoritative plan:** `ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md`
(SHA-256 `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`)

`/Users/harmelek/Adsecute` was not modified. Nothing was pushed, deployed, or
migrated in production; no provider was contacted; no live or remote data was
read; no rollout was activated; WP-16 and WP-27B were not started.

---

## 0.0 · Acceptance review rejected the completion claim twice

**Both earlier `PHASE_C_COMPLETE` claims were wrong.** They are recorded here
rather than smoothed over, because each says something about how the work
failed.

### Second review — a WP-14 production-contract defect at `8c9e13eb8`

The ceremony named `/api/meta/adsets/[adsetId]/bid`. **That route does not
exist**; the real one is `apply-bid`. And `DecisionsClient` posted
`{businessId, mutationId}` to every endpoint — a body all four handlers refuse
on contract grounds. Every offered action would have failed.

Both defects survived a green suite for one reason: **the component tests
mocked a generic dispatch function**, so no body was ever compared to a real
handler and no path was ever resolved against a real route. A mock of the thing
under test proves the mock.

Corrected by `7889d4812` (§4.2), which replaces that mock with 38 integration
tests that import and drive the actual route modules. Those tests immediately
earned their keep: they caught a *third* contract error I had just written —
the ad-level body without `actionOrigin`, which the real handler rejected with
`action_origin_required`.

### First review — WP-13, WP-14 and WP-15 materially incomplete at `55b442178` Acceptance review found WP-13, WP-14 and WP-15 materially
incomplete behind green unit tests, and every defect it named was real:

| WP | What the first attempt actually shipped | Correction |
|---|---|---|
| 13 | Schema, store, route and tests. **No workflow UI existed at all** — no chip, transition menu, dialog, event history, conflict surface or re-apply anywhere in Decisions. A backend nobody could reach. | `ada7a6bf4` |
| 14 | A pure model and a preflight branch. **No ceremony was mounted**, and the canonical preflight was **not decision-bound**: it accepted business, account and entity from the client, merely nulled the expected fields, and rejected every grain except `ad`. | `5bbfc2ca7` |
| 15 | History rendered `rows={[]}` behind a comment promising data "in a later slice". Intelligence read one boolean and drew one row. `AutomationView` received no `onEngage`, so confirming the stop closed a dialog and changed nothing. `buildProviderPostures` hard-coded Google to `serving`, so the UI printed "Serving" for a provider nobody had queried. | `8c9e13eb8` |

Every original commit is retained unmodified; nothing was rewritten or
relabelled. Sections 3, 4 and 5 below describe each work package as it stands
after correction, and say plainly which part came from which commit.

---

## 0 · Pre-phase correction

`6fef159b5` — the WP-10 ledger row recorded the full suite as `7984/0` while
`PHASE_B_IMPLEMENTATION_REPORT.md` recorded `8008/0`. 8008/0 is the measured
value; the ledger figure was stale. Only that number changed. The commit chain
through `aaadbdd58` is untouched, no history was rewritten, and both Phase B
acceptance-review corrections (the server-pagination correction and the cursor
provenance / fail-closed correction) remain stated in full in the ledger.

## 0.1 · Authority read before any Decision Center work

`docs/creative-decision-center/START_HERE.md` and every document in its mandated
order were read before WP-12 began, including `DECISION_LOG.md`,
`DATA_READINESS.md`, `GOLDEN_CASES.md` and `INVARIANTS.md`. The rules that
shaped the work below, and how each was kept:

| Rule | How Phase C keeps it |
|---|---|
| No resolver change without an ADR | No resolver file is in the diff at all (§6) |
| No standalone or parallel decision core | Every surface reads an existing endpoint; WP-13 adopted the existing tables/route/store rather than adding new ones |
| No row-level `brief_variation` | Not introduced; no schema carries it |
| UI never computes `buyerAction` | `decisions-presentation.ts` renders the served resolution and computes no action; client action-math count is asserted to be zero |
| No high-confidence decision when required data is missing | Missing sources are named and their comparisons render unavailable, never as zero (§1) |
| V1 / operator / V2 snapshot compatibility preserved | Creative V2 safety and the native-ad frozen acceptance both pass unchanged (§5) |
| No legacy route renamed in this migration | Canonical routes are additive under `/c/[businessId]/**`; no legacy path was renamed |
| Reuse canonical authority | All five surfaces compose existing domain code; the composition is new, the truth is not |
| Small reviewable commits, explicit rollback | Five commits, one per WP, each with a stated revert (§7) |

---

## 1 · WP-11 — Client Home (H03/H04/H08) · `33d16dd5f`

**Files.** `lib/zero-base/home/{metric-contract,home-server}.ts`,
`components/zero-base/home/{metric-card,sparkline,source-health,home-view}.tsx`,
`app/c/[businessId]/home/page.tsx`, `lib/zero-base/home/metric-contract.test.ts`,
`components/zero-base/home/home.test.tsx`, plus harness and Playwright additions.

**Tests.** 38 (19 contract · 19 view). Full suite 8046/0.

The defect this work exists to prevent is in the legacy path and is one
character wide: `lib/overview-summary-support.ts:136` calls
`deltaSentiment(getMetricDirection(...), changePct ?? 0)`. A comparison that
could not be computed becomes a 0% flat trend — a confident claim of "no
change" built from an absence. The canonical contract routes every comparison
through `resolveComparison`, which returns `{available: false, reason}`, and the
card prints the reason.

Proven by test:

- a null comparison never displays as `0`, and never as a flat trend;
- desirability is separate from direction: spend, CPA and refunds increases are
  never drawn as good. `NEUTRAL_BY_POLICY` contains spend alone, so a spend rise
  is neither praised nor alarmed;
- money is proof-aware — a figure whose source is `unavailable` is not served,
  and canonical account currency is used, never a silent USD;
- every chart carries an accessible table alternative;
- a partial-source banner and a hard banner are both visible at once; neither
  suppresses the other;
- a stale refresh retains the previously served content rather than blanking it.

`readHomeContract` calls `getOverviewData` in process. There is no HTTP
self-fetch. **No decision resolver code was modified.**

**Visual/AT evidence.** H03/H04/H08 at 1440/390/320 in light and dark: no
page-level horizontal scroll at any width, chart alternatives present, both
banner classes visible together.

## 2 · WP-12 — Meta Decisions (H09/H10; H11/H12 read-only) · `ce8e8c389`

**Files.** `lib/zero-base/meta/{decisions-url-state,decisions-presentation}.ts`,
`components/zero-base/meta/decisions/{decisions-view,decisions-client}.tsx`,
`app/c/[businessId]/meta/decisions/page.tsx` + 2 test files, harness and
Playwright.

**Tests.** 39 (24 module · 15 view). Full suite 8085/0.

Reads `/api/meta/decisions-workspace` unchanged. The load-bearing assertion is
text equality: verdict and metric strings are compared against the exact served
bytes, so the surface cannot quietly reformat — and therefore cannot disagree
with — the resolver.

Proven by test:

- client action math count is **zero** for held decisions, for reviewer
  sessions and for demo businesses;
- every URL filter and the row selection are restorable from the URL alone, and
  a context change resets rather than carrying stale selection across;
- hard and partial banners render simultaneously;
- the evidence window and the snapshot time are separate labelled fields, so
  "data through" is never mistaken for "as of";
- no generic Ads Manager link is described as an executed action.

**Visual/AT evidence.** 1440/1280/768/390/320 × light+dark.

## 3 · WP-13 — Versioned workflow overlay (Flow C) · `d3a3e10e9` → `ada7a6bf4`

**Files.** `lib/zero-base/meta/workflow-schema.ts` (additive migration),
`lib/decision-workflow-store.ts`, `app/api/meta/decision-workflow/route.ts`,
`lib/migrations.ts`, `scripts/ephemeral-postgres-workflow-overlay-seam-child.ts`,
`scripts/ephemeral-postgres-migrations-check.ts` + 2 test files.

**Tests.** 13 overlay · 12 route · a real-PostgreSQL seam. Full suite 8098/0.
`migrations-from-zero` PASS.

The existing `decision_workflow_state`, `decision_workflow_events`,
`lib/decision-workflow.ts`, `lib/decision-workflow-store.ts` and
`/api/meta/decision-workflow` were **adopted and hardened**. No parallel table,
route or store was created, no triage deferred row was repurposed, and the
legacy comment write contract is intact. Workflow state annotates the truth
lane; it never moves or rewrites it.

Hardening: state and journal now commit inside one `runDbTransaction`;
transitions are validated; the assignee must hold an active membership (422
`invalid_assignee`); `expectedVersion` mismatches are refused by a guarded
UPDATE that matches no row; a duplicate `mutationId` is a replay.

**What the seam caught.** `persistWorkflowTransition` bound `$1` as both a TEXT
`business_id` and a `$1::uuid` `business_ref_id`. PostgreSQL rejects that with
*inconsistent types deduced for parameter $1*. No test had ever run this
statement against a real server, so the bug was invisible to the mocked suite.
Fixed with a separate `$14` parameter.

The seam proves against real storage what a mock cannot assert:

- a failing event insert rolls the state upsert back with it — proven by adding
  a CHECK constraint that fails the insert, asserting the state did not move,
  dropping the constraint and re-running to show nothing was left wedged;
- a replayed `mutationId` appends no second event **and does not bump the
  version**, so the next actor's `expectedVersion` is still correct;
- the same id in a different business is allowed — the unique index is
  business-scoped, so one tenant's retry cannot suppress another's event;
- a stale `expectedVersion` is refused by the database and writes no event.

### 3.1 · The correction — `ada7a6bf4`

The backend above was real; nothing reached it. `ada7a6bf4` builds the surface.

**Batched read, not N+1.** A new `contract=zero-base.v1` mode on the **same**
GET takes `decisionKeys` for the whole served page and returns one workflow per
key, plus the journal for the one decision that is open. A per-row GET would
be an N+1 that grows with the collection. Over-large batches are **refused**
(400 `too_many_keys`, cap 200), not truncated — a silently dropped key renders
"nobody owns this" for a decision somebody does own. The legacy single-key mode
is asserted byte-identical, down to its exact response keys.

**Components.** `workflow-overlay.tsx` provides the row chip and the inspector
panel: state chip, transition menu, accessible dialog with the fields each
transition requires (assignee, snooze wake-up, reject reason, optional due),
actor/event history, loading/error/empty states and explicit role posture
(guest reads, collaborator writes, reviewer denied with a reason rather than a
silent absence).

**The menu cannot offer what the server would refuse.** Available transitions
are probed through the real state machine with required fields supplied, so a
form the operator has not filled in yet is not mistaken for a refusal.

**409 is shown, never resolved.** The operator sees the server's current state
beside what they attempted; re-applying is an explicit act against the
**refreshed** version, and is withheld entirely when the refreshed state makes
the action impossible. Nothing is re-sent automatically — a silent retry would
overwrite whatever the other operator just did with nobody having read it.

**One mutation id per attempt**, not per request, so a double click or a
retried POST is a replay rather than a second transition that bumps the version
and shows the operator their own action twice.

**Workflow annotates; it never moves the truth.** A test asserts the served
verdict bytes and the row order are identical before and after a transition.

**No comments.** No comment action, no comment field, no comment read — and the
seam proves the projection cannot carry comment text out of the database even
when the column holds some.

**A defect the UI made visible.** A failed overlay read now renders "Workflow
unknown". The default "Open" would have claimed nobody owns a decision somebody
may well own.

**Rollback.** The column and both indexes are additive and nullable; existing
rows and callers are unaffected. `git revert ada7a6bf4 d3a3e10e9`.

## 4 · WP-14 — Preflight and the manual write ceremony (H13–H16, Flow B) · `4486eaaa4` → `5bbfc2ca7` → `7889d4812`

**Files.** `lib/zero-base/meta/mutation-ceremony.ts`,
`app/api/meta/decision-action/preflight/route.ts` (`contract=zero-base.v1`
branch) + 1 test file.

**Tests.** 30. Existing preflight tests unchanged and green. Full suite 8128/0.

The Decision Center authority documents were re-read before this work.

- **`ZERO_BASE_MUTATION_UI_ENABLED` appears in zero environment files and
  defaults OFF in every environment.** It is the outermost gate: the ceremony
  refuses on the flag before a preflight is even considered, so the flag answer
  never depends on preflight state. Provider requests are mocked in tests and
  unreachable in normal E2E.
- **Dispatch is an explicit allowlist** keyed by grain and action (campaign:
  pause/resume; adset: pause/resume/bid; ad: pause/resume/duplicate). There is
  no generic execute route. An action with no entry — `campaign.duplicate` —
  cannot be dispatched at all, which is precisely what a single action-taking
  endpoint gives up.
- **The server derives expected state.** The canonical mode rejects
  client-supplied `expectedStatus`, `expectedCreativeId` and `expectedParentId`
  with 400 `client_expectations_rejected` rather than ignoring them silently,
  because a caller that can name what it expects can name something that makes
  a stale write look fresh.
- **Ceremony order** (each step only narrows): server availability → persisted
  -state preflight → age (15 min) and change checks → highest required
  confirmation → typed endpoint dispatch → terminal/reconciliation. Pause and
  duplicate take an acknowledgement; resume and bid take a typed phrase,
  because they start money moving.
- **Terminal honesty (D067).** A receipt is offered only when the attempt is
  durable, and never under ambiguity — there is nothing settled to copy, and a
  receipt would invite reading "we do not know" as "it worked". Retry is
  permitted only after a clean refusal; under ambiguity the provider may
  already have applied the change.

`resolveCeremony` is a pure function of its inputs. It cannot perform a network
call, so it can never be mistaken for having verified live state itself, and it
never claims the persisted-state preflight contacted Meta. No second preflight
or generic execute route was added; each action endpoint's own fresh preflight
is untouched; native and manual authority are not forked.

### 4.1 · The correction — `5bbfc2ca7`

**The contract is now decision-bound, for all three grains.** A third mode,
`zero-base.decision.v1`, on the same route. Input is a served decision key plus
an allowlisted action — nothing else.

- Any attempt to supply `providerAccountId`, `entityId`, `entityType`,
  `expectedStatus`, `expectedCreativeId` or `expectedParentId` is refused with
  400 **before any read**, so an override can never even be probed. An explicit
  `null` is refused too, rather than treated as absent.
- The server parses the key, resolves the entity **in the authorized business**
  from that grain's own dimension table, proves the provider account is
  assigned, and derives the expected state from the row it just read.
- It refuses rather than guesses: a key naming no single entity (`group:*`,
  `inactive:*`, `structure-*`, `campaign:unknown:*`), an action with no endpoint
  at that grain, an entity absent from this business, an unassigned account, an
  unreadable warehouse, and **two rows for one identity** — picking the newest
  there would be a guess, and the guess would be a provider write.
- Legacy mode is untouched: its response keys and its pass-through of a
  caller's own `expectedStatus` are both asserted unchanged.

D065 framing: this resolves a **`manual_operator_v1`** target — the exact
server-presented account and entity behind a decision the operator is looking
at. The decision supplies the *identity*, never the permission; no native
decision-lineage field passes through, so nothing here manufactures native
decision authority.

**The ceremony is mounted, and only when the server says so.** With the flag
off the panel is not rendered, not disabled and not hidden — it is never
constructed, and with it neither is any preflight or dispatch call. The flag is
read server-side, appears in no environment file, matches only the exact string
`true`, and can only narrow: a reviewer or demo viewer never gets the ceremony
whatever it says.

**The ordered machine is real**: availability → decision-bound persisted-state
preflight → age (15 min) and change checks → highest required confirmation →
typed endpoint dispatch → progress → terminal/reconciliation. The dispatch path
is built from the endpoint the server named and the id the server proved —
`resolveEndpointPath` fills exactly one placeholder and escapes the id. The
browser supplies neither path nor entity id.

**Rollback.** `git revert 5bbfc2ca7 4486eaaa4`. The flag is set in no
environment file, so the UI is unreachable either way.

### 4.2 · The second correction — `7889d4812`

`5bbfc2ca7` mounted a ceremony that could not have worked. Two defects, both
hidden by the same testing mistake.

**The endpoint did not exist.** `bid` mapped to `/api/meta/adsets/[adsetId]/bid`.
The real route is **`apply-bid`**. Nothing ever resolved that string against the
filesystem, so it read as correct for as long as nobody clicked it.

**The body was generic.** The client posted `{businessId, mutationId}` to every
endpoint. Each of these handlers refuses that outright — a fact now asserted as
a test: the old body returns `400 action_origin_required` from the real handler.

The cause of both was the same: **the tests mocked a generic dispatch
function**, so the suite proved the mock, not the contract.

**What the handlers actually require**, read from the handlers themselves and
now encoded in one place (`dispatch-contract.ts`):

| Route | Contract |
|---|---|
| `campaigns/[campaignId]/{pause,resume}`, `adsets/[adsetId]/{pause,resume}` | `actionOrigin: "manual_operator_v1"`, `manualConfirmation: "explicit_operator_confirmation"`, `businessId`, server-presented `providerAccountId`. No native lineage or origin-alias field. |
| `adsets/[adsetId]/apply-bid` | The above **plus** `bidAmountMinor` as a positive integer. `bidValue`/`bidValueMinor` are refused. |
| `ads/[adId]/{pause,resume}` | The same origin and confirmation **plus** the exact identity: `providerAccountId`, an `adId` equal to the route path, and a `creativeId` that still matches the resolved target. |
| `ads/[adId]/duplicate` | The above **plus** `targetAdsetId`. `activateAfterCreate: true` is refused. |

The ad-level origin requirement is worth naming: I first wrote that body
without it, and the new integration test failed with the handler's own
`action_origin_required`. That is the failure the previous mock could not
produce.

**The server issues the dispatch contract.** The preflight response now carries
a descriptor — a concrete path with the proven id already substituted, and the
exact body. The browser invents no business, account, entity, creative, expected
state, route, origin or confirmation; it adds only the operator choices the
descriptor declares.

**On the token option.** The review preferred an opaque server-bound token.
Resolving one requires a new authoritative mutation endpoint, and a parallel
mutation API is precisely what this work package forbids — so the descriptor is
server-issued instead, and **the existing handler is the revalidation**: it
re-resolves the true target from the warehouse and refuses on any mismatch
(`provider_account_mismatch`, `creative_identity_mismatch`, `ad_identity_mismatch`),
so a tampered descriptor fails closed there rather than landing anywhere.

**Withheld rather than broken.** An action whose required inputs cannot be
proven is withheld with a stated reason instead of rendered as a control that
can only fail: an ad with no recorded creative identity, a bid on an account
whose currency could not be verified, a duplicate whose source has no known
parent ad set.

**Operator fields, validated before the confirmation.** Bid amount in the
account's own currency — stated as minor units of that currency, with no
conversion anywhere in the path — and destination ad set plus optional name for
duplicate. There is **no activate-after-create toggle**: the route refuses
activation outright, so the constraint is stated rather than offered.

**A fresh preflight at dispatch time.** After the operator confirms, the target
is re-checked and the body sent is the *newly issued* descriptor's, not the one
behind the confirmation. A re-check that no longer says ready sends nothing.

**Evidence.** 38 integration tests import and drive the real route modules —
correct paths and bodies for all three grains, every missing-field refusal, bid
validation, duplicate destination, activation refusal, and the absence of every
field a handler would reject. 38 component tests cover collect/validate,
withholding, the dispatch-time re-check, one-attempt idempotency across a retry,
and zero call sites when the server flag is absent. No provider is contacted:
the integration tests stop at a sentinel that fires before any write path.

**Rollback.** `git revert 7889d4812 5bbfc2ca7 4486eaaa4`.

## 5 · WP-15 — Intelligence, History, Automation, Meta stop (H17–H20, Flow I) · `55b442178` → `8c9e13eb8`

**Files.** `lib/zero-base/meta/automation-posture.ts`,
`components/zero-base/meta/{intelligence,history,automation}/*-view.tsx`,
`app/c/[businessId]/meta/{intelligence,history,automation}/page.tsx` + 2 test
files, harness and Playwright.

**Tests.** 45 (22 posture · 23 Flow I). Full suite 8173/0.

Read-only composition over the existing control-plane and history endpoints.

- **Meta and Google readiness stay separate systems, and no Google stop was
  invented.** The stop is Meta-only and business-scoped; its copy is checked
  against a forbidden-phrase list (`global`, `stop all`, `all providers`,
  `everything`, `kill all`, `all platforms`) and the guard is proven to bite.
- **Google's row is always drawn, always separate, always marked unaffected** —
  including when Google is perfectly healthy and Meta is the degraded provider.
  Omitting it when nothing is wrong is exactly what would teach an operator that
  one switch covers both.
- **No success or status banner before the server read-back.** A 200 response is
  not an observation of state; an operator told "stopped" from a response alone
  believes spend has halted when it may not have. When the read-back disagrees,
  the surface says the outcome is unknown rather than claiming either result.
- **Engage and release are both wrapped** in role (admin), reviewer and demo
  checks, an explicit typed confirmation, and the mandatory read-back. Release
  is admin-only too, not just the direction that looks dangerous — it re-enables
  spend. A state that could not be read is refused rather than changed blind.
- **AUTO-05…10 render with an edit-affordance count of zero.** The engine
  enforces those caps server-side, so a control here would imply a change it
  will not honour. A missing value reads "Not configured", never a plausible
  default.
- **Replay and actor gaps are permanent.** A replayed window is marked with no
  dismiss control, because a dismissible caveat is one a later reader never
  sees. An entry with no recorded actor says so; "System" would be a claim about
  who acted.
- Provider-specific source states are named individually with their own reasons
  rather than folded into one "some data missing" line, because the remedies
  differ: a reconnect, a wait, a reassignment.

**Visual/AT evidence.** Flow I at 1440/390/320 × light+dark over a
Meta-degraded / Google-healthy / no-read-back fixture — the case where each
absence above would be a defect: Google row present, exactly one stoppable
provider, six guardrail values with zero edit affordances, zero status banners,
no forbidden phrase in the body text, no page-level horizontal scroll.

### 5.1 · The correction — `8c9e13eb8`

The rules above were encoded in a module whose pages were placeholders or
disconnected. `8c9e13eb8` connects them to real authorities.

**History** reads the existing journal. The account is resolved from this
business's own assignments and **no account id is accepted from the request**,
so a cross-business read cannot be asked for. Actor provenance survives in
three distinct forms — a recorded name, "No human actor (engine)", and "Actor
not recorded" — and "System" appears nowhere. Replay flags come from the read
model's own `replay` object, and any replayed row raises a banner with no
dismiss control. The page cap is disclosed, and never as a total: the cursor
path does not compute one, so claiming one would be an invention. The read
model's own limitation messages are carried through verbatim.

**Intelligence** composes all nine named authorities server-side —
status, pulse, summary, trends, breakdowns, anomalies, labels, and structure +
recommendations from their shared workspace read model — through
`Promise.allSettled`, so one failing source degrades one row rather than the
page. A failed read is `degraded` with the source's **verbatim** error, never
`unavailable`: those are different facts, and conflating them hides which one
happened. Partial states keep the read model's own words. A missing collection
prints "Not reported", never `0`. Every windowed source is scoped to one stated
window, so two sections cannot silently describe different periods. Several
assigned accounts resolve to *none* rather than an arbitrary pick.

**Automation** now acts. A client boundary POSTs the existing business-scoped
engage/release action and then issues a **separate** GET to read the state
back. The POST returns a control plane of its own, and using its own response
to confirm itself is not an observation of state. Disagreement and an
unreadable re-read both resolve to unknown; a refused write is reported as a
failure that changed nothing. No request is made at all until the typed
confirmation completes.

**Google's row is read, not assumed.** `buildProviderPostures` now requires a
`GoogleConnectionRead` and cannot be called without one. Connected, not
connected, or `unknown` with the reason when the read fails — never `serving`
for a provider nobody queried. The row carries `basis: "connection_only"`,
naming it a connection claim rather than a control-plane one, and remains
always present, always marked unaffected, and never stoppable. There is still
no Google stop, and the two readiness systems remain separate.

**How Flow I is proven, precisely.** The interactions — engage, release,
read-back agreement, disagreement, unavailability, refused write, and the
no-request-before-confirmation rule — are driven with **real user events over
stubbed fetch** in `components/zero-base/meta/flow-i.test.tsx`. The Playwright
pages remain **static**, and nothing there is claimed as proof that a request
was made; they cover the mirror provider case (Meta healthy, Google
unreadable), real actor and replay rows, and partial plus degraded sources at
1440/390/320 in both themes. That split is stated here rather than blurred.

**Rollback.** `git revert 8c9e13eb8 55b442178`.

---

## 6 · Phase C completion gates

Run at `55b442178` unless noted.

| Gate | Command | Result |
|---|---|---|
| Design contract verify | `npm run zero-base:contract:verify` | exit 0 |
| Contract freshness | `npm run zero-base:contracts:check` | exit 0 |
| Font provenance | `npm run zero-base:fonts:verify` | exit 0 |
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | 0 problems |
| Full Vitest | `npm test` | **8369 passed · 0 failed** (782 files; 61 skipped, 63 todo pre-existing) |
| Migrations from zero | `npm run test:migrations-from-zero` | PASS (incl. the extended workflow-overlay seam and the new decision-bound-target seam) |
| Provider account selection seam | `npm run test:selection-race-seam` | PASS (S1–S7), exit 0 |
| Creative V2 safety | `npm run creative:v2:safety` | exit 0 |
| Native-ad frozen acceptance | `npm run creative:decision:native-ad-frozen-acceptance` | 22/22 |
| Zero-base contract tests | `npm run test:zero-base:contract` | 17/17 |
| Zero-base design/theme tests | `npm run test:zero-base:design` | 26/26 |
| Zero-base responsive + flow + route | `npm run test:zero-base:responsive` | 60/60 (54 harness pages) |
| Production build | `npm run build` | Compiled successfully; all five canonical routes present |
| Local production smoke | `npm run test:smoke:local` equivalent (§6.2) | 71 passed · 3 failed · 1 skipped — the 3 are pre-existing (§6.2) |

**Resolver / decision-output check.** Taken from `aaadbdd58`, the last Phase B
code commit — a superset of the change since the accepted head `da7eb3298`,
which adds only documentation on top of it. `git diff aaadbdd58..55b442178`
touches no
file under `lib/creative-decision-engine/`, `lib/creative-decision-center/` or
`lib/archive/`, and no `lib/meta/recommendations*`. The complete set of
pre-existing files Phase C modified is:

```
app/api/meta/decision-action/preflight/route.ts
app/api/meta/decision-action/preflight/route.test.ts
app/api/meta/{campaigns,adsets,ads}/**  (imported by tests only; unmodified)
app/api/meta/decision-workflow/route.ts
app/api/meta/decision-workflow/route.test.ts
lib/decision-workflow-store.ts
lib/migrations.ts
scripts/ephemeral-postgres-migrations-check.ts
scripts/ephemeral-postgres-workflow-overlay-seam-child.ts
scripts/ephemeral-postgres-decision-bound-target-seam-child.ts
```

None of these produce a decision verdict or a `buyerAction`. **No resolver need
arose, so no ADR was required and none was smuggled into UI work.**

### 6.1 · The one modified existing test fixture

`app/api/meta/decision-workflow/route.test.ts` gained a `vi.hoisted`
`findMembership` mock. The route now validates that an assignee holds an active
membership, and the existing test *"records the acting user, not the assignee"*
did not stub that lookup. The **fixture** was corrected — the new check was not
weakened, and no assertion was removed or relaxed.

### 6.2 · Local production smoke — what ran and what failed

The smoke serves the **production standalone build** against a PostgreSQL
cluster created for the run and destroyed after it, with the demo business
seeded and **no provider credential set at all** — not an empty one, none — so
no provider request can be formed. Every sync lane and both live-read flags are
off. `/Users/harmelek/Adsecute/.env.local` was deliberately not used: it points
at production over an SSH tunnel.

Result at `7889d4812`: **71 passed, 3 failed, 1 skipped.** The three failures
are:

```
reviewer-smoke.spec.ts:71        Meta recommendations and creative dashboard
commercial-truth-smoke.spec.ts:322  Commercial Truth under Main, out of Settings
commercial-truth-smoke.spec.ts:367  dedicated page, Meta operating mode, Creative dashboard
```

These are **not Phase C regressions**, and that is measured rather than
asserted: the identical smoke, same throwaway cluster and same seed, was run at
the Phase B accepted head `aaadbdd58` and produced **the same three failures**
(31 passed there; the difference is exactly the new zero-base Playwright
coverage added by WP-11, WP-12 and WP-15 and its corrections). They are legacy surfaces that need
Meta and commercial data this credential-free local cluster cannot hold. They
were failing before Phase C began and are unchanged by it.

---

## 7 · Rollback

Per work package, newest first:

```
git revert 8c9e13eb8 55b442178   # WP-15 + its correction
git revert 7889d4812 5bbfc2ca7 4486eaaa4   # WP-14 + both corrections
git revert ada7a6bf4 d3a3e10e9   # WP-13 + its correction
git revert ce8e8c389             # WP-12
git revert 33d16dd5f             # WP-11
```

Notes: WP-11, WP-12 and WP-15 are additive routes and components — with rollout
off the canonical routes 404 before any read, and legacy surfaces are untouched
either way. WP-13's migration is additive and nullable, so reverting the code
leaves pre-existing rows and callers working. WP-14's flag is set in no
environment file, so its UI is unreachable whether or not the commit is present.

## 8 · Limitations, stated rather than hidden

1. **Phase A residuals stand.** The design package remains **NOT READY**;
   REQ-27, REQ-28 (`M11`) and REQ-41 are accepted residuals and were not
   laundered green by any Phase C work.
2. **The mutation UI has never been exercised end to end against a provider**,
   by design. The ceremony is proven as a pure function, at the preflight route
   boundary, as a mounted component driven by real user events, and — since
   `7889d4812` — with every dispatch body posted to the **actual** route
   handlers, which accept it and stop at an authorization sentinel.
   `ZERO_BASE_MUTATION_UI_ENABLED` is off everywhere, turning it on is outside
   this phase's authority, and no test or E2E run reaches Meta. What remains
   unproven is everything past authorization: the provider write itself, its
   verification, and reconciliation of an ambiguous outcome.
3. **The three legacy smoke failures in §6.2 remain failing.** They predate
   Phase C, they need data a credential-free local cluster cannot hold, and
   nothing here fixes them.
4. **Harness pages are static compositions.** They prove layout, banner
   stacking, affordance counts and copy at each width and theme. They are **not**
   claimed as evidence that a data-populated route renders, nor that any request
   was made. Every interaction claim in §3.1, §4.1 and §5.1 rests on component
   tests driven with real user events, and every server claim on route tests and
   real-PostgreSQL seams.
6. **Intelligence section facts are deliberately thin** — a state, a reason, an
   observation time and a served count or status word per source. Richer
   per-source metrics would mean this surface deciding what a number means,
   which is the source's job, not the composition's.
5. **WP-16 was not started**, and neither was WP-27B.

## 9 · Worktree state

Clean and fully committed at `7889d4812` on
`codex/adsecute-zero-base-implementation`. Nothing was pushed. `.env.local` was
written only inside the smoke run and removed by its cleanup trap; it is
untracked and absent.

Phase C commit chain, in order:

```
6fef159b5  ledger correction (stale WP-10 figure)
33d16dd5f  WP-11
ce8e8c389  WP-12
d3a3e10e9  WP-13   → ada7a6bf4  WP-13 correction
4486eaaa4  WP-14   → 5bbfc2ca7  WP-14 correction 1 → 7889d4812  WP-14 correction 2
55b442178  WP-15   → 8c9e13eb8  WP-15 correction
79b33a187  docs · 57edb254c  docs · 01407b2dc  docs
```
