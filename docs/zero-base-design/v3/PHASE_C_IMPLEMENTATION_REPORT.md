# Phase C Implementation Report — WP-11 … WP-15

**Worktree:** `/Users/harmelek/Adsecute-zero-base` · **Branch:** `codex/adsecute-zero-base-implementation`
**Phase B accepted head:** `da7eb3298` (its last code commit: `aaadbdd58`) · **Phase C head:** `55b442178`
**Authoritative plan:** `ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md`
(SHA-256 `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`)

`/Users/harmelek/Adsecute` was not modified. Nothing was pushed, deployed, or
migrated in production; no provider was contacted; no live or remote data was
read; no rollout was activated; WP-16 and WP-27B were not started.

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

## 3 · WP-13 — Versioned workflow overlay (Flow C) · `d3a3e10e9`

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

**Rollback.** The column and both indexes are additive and nullable; existing
rows and callers are unaffected.

## 4 · WP-14 — Preflight and the manual write ceremony (H13–H16, Flow B) · `4486eaaa4`

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

## 5 · WP-15 — Intelligence, History, Automation, Meta stop (H17–H20, Flow I) · `55b442178`

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
| Full Vitest | `npm test` | **8173 passed · 0 failed** (776 files; 61 skipped, 63 todo pre-existing) |
| Migrations from zero | `npm run test:migrations-from-zero` | PASS (16 seam PASS markers, incl. the new workflow-overlay seam) |
| Provider account selection seam | `npm run test:selection-race-seam` | PASS (S1–S7), exit 0 |
| Creative V2 safety | `npm run creative:v2:safety` | exit 0 |
| Native-ad frozen acceptance | `npm run creative:decision:native-ad-frozen-acceptance` | 22/22 |
| Zero-base contract tests | `npm run test:zero-base:contract` | 17/17 |
| Zero-base design/theme tests | `npm run test:zero-base:design` | 26/26 |
| Zero-base responsive + flow + route | `npm run test:zero-base:responsive` | 42/42 (36 harness pages) |
| Production build | `npm run build` | Compiled successfully; all five canonical routes present |
| Local production smoke | `npm run test:smoke:local` equivalent (§6.2) | 53 passed · 3 failed · 1 skipped — the 3 are pre-existing (§6.2) |

**Resolver / decision-output check.** Taken from `aaadbdd58`, the last Phase B
code commit — a superset of the change since the accepted head `da7eb3298`,
which adds only documentation on top of it. `git diff aaadbdd58..55b442178`
touches no
file under `lib/creative-decision-engine/`, `lib/creative-decision-center/` or
`lib/archive/`, and no `lib/meta/recommendations*`. The complete set of
pre-existing files Phase C modified is:

```
app/api/meta/decision-action/preflight/route.ts
app/api/meta/decision-workflow/route.ts
app/api/meta/decision-workflow/route.test.ts
lib/decision-workflow-store.ts
lib/migrations.ts
scripts/ephemeral-postgres-migrations-check.ts
scripts/ephemeral-postgres-workflow-overlay-seam-child.ts
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

Result at `55b442178`: **53 passed, 3 failed, 1 skipped.** The three failures
are:

```
reviewer-smoke.spec.ts:71        Meta recommendations and creative dashboard
commercial-truth-smoke.spec.ts:322  Commercial Truth under Main, out of Settings
commercial-truth-smoke.spec.ts:367  dedicated page, Meta operating mode, Creative dashboard
```

These are **not Phase C regressions**, and that is measured rather than
asserted: the identical smoke, same throwaway cluster and same seed, was run at
the Phase B accepted head `aaadbdd58` and produced **the same three failures**
(31 passed there; the 22-test difference is exactly the new zero-base Playwright
coverage added by WP-11, WP-12 and WP-15). They are legacy surfaces that need
Meta and commercial data this credential-free local cluster cannot hold. They
were failing before Phase C began and are unchanged by it.

---

## 7 · Rollback

Per work package, newest first:

```
git revert 55b442178   # WP-15
git revert 4486eaaa4   # WP-14
git revert d3a3e10e9   # WP-13
git revert ce8e8c389   # WP-12
git revert 33d16dd5f   # WP-11
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
   by design. WP-14's ceremony is proven as a pure function and at the preflight
   route boundary. `ZERO_BASE_MUTATION_UI_ENABLED` is off everywhere and turning
   it on is outside this phase's authority.
3. **The three legacy smoke failures in §6.2 remain failing.** They predate
   Phase C, they need data a credential-free local cluster cannot hold, and
   nothing here fixes them.
4. **Harness pages are static compositions.** They prove layout, banner
   stacking, affordance counts and copy at each width and theme. They are not
   claimed as evidence that a data-populated route renders; the data-path claims
   in §1–§5 rest on the unit and component tests against real server payloads.
5. **WP-16 was not started**, and neither was WP-27B.

## 9 · Worktree state

Clean and fully committed at `55b442178` on
`codex/adsecute-zero-base-implementation`. Nothing was pushed. `.env.local` was
written only inside the smoke run and removed by its cleanup trap; it is
untracked and absent.
