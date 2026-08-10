# Media-Buyer UX Remediation — Delivery Ledger

Authority: `docs/full-ui-redesign/ADSECUTE_MEDIA_BUYER_UX_IMPLEMENTATION_MASTER_PLAN_2026-08-08.md`
(untracked, and present only in the primary working copy at `/Users/harmelek/Adsecute` — it is not
in this worktree and not in git. Every other path cited in this ledger resolves inside this
worktree; this one is called out so a reader who cannot open it knows why.)

Owner: Claude Code (implementation). Every slice has one rollback boundary.

Status values: `not_started` · `in_progress` · `local_pass` · `staging_pass` · `production_pass` · `blocked_external` · `failed`.
`local_pass` and `staging_pass` are never equivalent to `production_pass`.

---

## Gate 0 — Repository and release authority

### Baseline identity

| Item | Value |
| --- | --- |
| Production build (`https://adsecute.com/api/build-info`) | `0bcf1fbf54f8d7eca27708ddeaa3715b88a85d79` |
| Production deploy gate | `pass`, emitted `2026-08-08T17:21:52.878Z` |
| `origin/main` tip | `0bcf1fbf54f8d7eca27708ddeaa3715b88a85d79` (identical to production) |
| Implementation branch | `ux/media-buyer-remediation`, based on `origin/main` |
| Implementation worktree | `/Users/harmelek/Adsecute-ux-remediation` (isolated, clean at creation) |
| Release candidate branch | `release/sync-reliability-candidate` — 0 commits ahead of main (pointer only) |

### Baseline verification on the untouched production commit

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | exit 0 |
| Tests | `npx vitest run` | exit 0 — 644 files passed / 4 skipped; 5995 tests passed / 61 skipped / 61 todo |
| Full-UI visual smoke | `full-ui-redesign-playwright-smoke.ts` (ephemeral Postgres) | **exit 1 — 2 failed (PRE-EXISTING)** |

Any later regression is measured against exactly these numbers.

### Finding G0-F2 — the full-UI visual smoke already fails at the deployed build

Run against the untouched baseline `0bcf1fbf5` on an isolated ephemeral Postgres
(no production contact), the smoke fails two tests identically on desktop and mobile:

```
✘ [full-ui-desktop] covers every in-scope route and captures representative visuals
✘ [full-ui-mobile]  covers every in-scope route and captures representative visuals
  Error: Meta Decisions evidence affordance
  expect(locator).toBeVisible() failed — element(s) not found
```

The run also logs `column "provider_account_id" does not exist` against
`engine_v3_decision_snapshots_daily`; that column is absent from the table's DDL in
`lib/migrations.ts`, so the query is broken independently of any UI change.

Consequences:

1. This smoke **cannot serve as a green release gate** in its current state, and a
   passing run must not be claimed for any slice until the pre-existing failure is fixed.
2. The failure is **not attributable to this program's slices** — it was reproduced on the
   baseline commit before and after the slices landed.
3. Fixing it is its own slice (it is a Meta Decisions evidence-affordance/selector issue,
   Phase 3/8 territory), tracked below as `S-SMOKE`.

Per-slice verification therefore uses focused tests, the full vitest suite, typecheck, and
lint, with this smoke recorded as a known-failing baseline rather than a silent skip.

> **Superseded 2026-08-09.** The smoke is green. Historical baseline only.


### Finding G0-F3 — the Decisions as-of date resolver queries a column that does not exist

> **Resolved 2026-08-08** by slice D070 (`19b9ce5b9`) with ADR-D070 and golden coverage, and by
> slice C3 (`4f37ac663`) which surfaced the swallowed failure. Retained as the historical
> root-cause record; it is not a current blocker.

Root cause of G0-F2, and a defect in its own right on the production commit.

`resolveDecisionAsOfDate` in `app/api/meta/decisions-workspace/route.ts:251-297` runs two
queries to find the latest decision snapshot date. Both filter
`engine_v3_decision_snapshots_daily` on `provider_account_id`:

```sql
FROM engine_v3_decision_snapshots_daily
WHERE business_id::text = $1
  AND provider_account_id = $2
```

That table has no such column. Its DDL (`lib/migrations.ts:9235`) scopes rows with
`scope_type` / `scope_id` and identifies them by `creative_id`; the canonical way to reach a
provider account is the `creative_account_scope` join used in
`lib/meta/history-read-model.ts:208-215`. Confirmed no `ALTER` adds the column anywhere.

Consequences on the deployed build:

1. Both queries always raise `column "provider_account_id" does not exist`.
2. Both are swallowed by bare `catch {}` blocks whose comments attribute the failure to a
   schema/capability gate, so the real cause never surfaces in logs or UI.
3. Because the first query puts the broken branch in a `UNION ALL` with two branches that
   would work (`engine_v3_ad_decision_snapshots_daily`, `engine_v3_job_runs`), the error
   takes those working branches down with it.
4. The resolver therefore always falls through to `previousUtcDate()`. Whenever the newest
   snapshot is not exactly yesterday, the workspace requests a date with no rows and the
   operator sees empty lanes and `0 of 0` — with no error, because it was swallowed. This is
   precisely the "a failed request never collapses into no data" rule being broken.

**Status (historical): `blocked_external` — needs an owner decision, not a unilateral fix.**
**Resolved 2026-08-08** by slice D070 (`19b9ce5b9`) under ADR-D070 with golden coverage, exactly as
the process below required. Not a current blocker.
Correcting the predicate changes which as-of date the Decisions surface resolves, which is a
semantics change in a decision read path. The plan requires resolver semantics changes to
carry executable golden/invariant coverage plus a `DECISION_LOG.md` entry, and D13
(date-range replay leak) governs exactly this area. The fix is also entangled with G0-F1:
the D061–D069 decisions and the native-ad snapshot tables this query reaches for live on the
unmerged branch. Recommended resolution order: land the native-authority work on main
(G0-F1), then fix this predicate under a new ADR with golden coverage.

Until then the smoke cannot pass, and no slice may claim it as a gate.

**Partially addressed by slice C3 (`4f37ac663`).** The behaviour is unchanged and still
ADR-gated, but the failure is no longer silent: the cause is classified from the SQLSTATE and
a missing column is logged as a warning rather than being excused as a capability gate. This
converts the plan's open question on cascade prevalence (section 13) from inference into
something production telemetry can answer before the ADR is written.

### Dirty-tree disposition — PRESERVED, UNTOUCHED

The primary tree `/Users/harmelek/Adsecute` is on `codex/native-ad-bounded-stop-loss-authority`
(`c46d91c2a`, ahead 4 / behind 162 of main) and carries **unique uncommitted user work**:

- 219 modified tracked files (+47,088 / −11,264 vs branch HEAD);
- 127 untracked entries, of which **112 are genuinely new** (not present in `origin/main`);
- content matches **neither** `origin/main`, **nor** `codex/sync-reliability-isolated`, **nor** `release/sync-reliability-candidate` (sampled comparison: 0/6 matches against each);
- concentrated in `lib/sync` (47 modified + 22 new), `lib/meta` (35 + 6), `lib/shopify` (8 + 17), `app/api` (26 + 5).

**Decision: this tree is never reset, cleaned, stashed, checked out over, or rebased.**
No UX remediation work occurs in it. All implementation happens in the isolated worktree.

### Excluded concurrent work

| Excluded | Reason |
| --- | --- |
| Uncommitted work in the primary tree (above) | User-owned, in flight, out of UX program scope |
| `codex/sync-reliability-isolated` (`/Users/harmelek/Adsecute-sync-isolated`) | Separate reliability program |
| `codex/db-runaway-hotfix` (`/Users/harmelek/Adsecute-db-hotfix`) | Separate hotfix |
| The 4 native-authority commits (see finding G0-F1) | Separate feature merge, not UX remediation |

### Audit of the 4 commits ahead of `origin/main`

`31950b1a9`, `1517674c7`, `e41691f33`, `c46d91c2a` (all 2026-07-19) — 243 files, +113,062 / −9,037.

Disposition: **not ported into the UX branch.** Rationale: this is a large native-ad decision/execution
authority feature, three weeks older than main's tip, unrelated to media-buyer UX remediation. Porting it
would exceed the program's scope and collide with the owner's in-flight work. It remains available on its
own branch and is unaffected by this program.

### Finding G0-F1 (blocking for Phase 8, informational for Phases 1–7)

**Binding decision authority D061–D069 is committed on the stale branch but absent from `origin/main`
and therefore absent from production.** Verified decision inventories:

- `origin/main`: D001–**D060**
- branch `c46d91c2a`: D001–**D069**
- primary tree working copy: D001–**D069** (`DECISION_LOG.md` itself is not dirty — the decisions are committed on the branch)

The master plan cites D064, D065, D067 and invariant MR-D064-01 as binding, and Phase 8 states it
"reuses D065/D067 execution contracts". Those contracts and their implementing code are **not in the
branch this program builds on**.

Consequences, recorded rather than silently resolved:

1. Phases 1–7, 9, 10 proceed on `origin/main`, honoring D061–D069 as **documented constraints**
   (they are committed decisions of record; the plan's authority precedence ranks the decision log above
   the plan itself).
2. **Phase 8 (first narrow guarded write) is `blocked_external`** until the native-authority work
   reaches main. *(Superseded 2026-08-09: the work is integrated and seam-proven on this branch; the
   remaining gate is the deploy plus an approved provider call.)* It may not be satisfied by re-implementing a lighter UI-only write path — the plan
   forbids exactly that. Unblocking requires an owner decision to merge/rebase that feature.

**Update (2026-08-09).** Under the owner's authorization to integrate D061–D069 inside the isolated
worktree, `DECISION_LOG.md` was adopted wholesale from `codex/native-ad-bounded-stop-loss-authority`.
This branch had never modified that file, so the adoption is lossless: it carries `origin/main`'s
content plus the nine new decisions plus an amendment tightening currency/timezone resolution (which
reinforces MR-D064-01 rather than conflicting with it). The decisions are therefore no longer absent
*here*, though they remain absent from `origin/main` and from production.

Auditing the guarded-write resolver against them found one real conformance gap, now fixed: D065
requires that Cut authorize only `pause` and Scale only `resume`, failing closed on a null or
disagreeing derived action. The resolver had taken `providerMutation` at face value, so a decision
reading `cut` while carrying a `resume` action would have been offered as runnable. B-7 is still
`blocked_external`, but for the honest reason — the provider write needs a deployed build and an
approved call — not because the contract is missing.
3. MR-D064-01 is honored as the binding money rule for Phase 1: provider currencies must round-trip
   "without a USD or dollar fallback".

### Gate 0 acceptance

| Criterion | Status | Evidence |
| --- | --- | --- |
| Implementation branch based on current main | `local_pass` | `ux/media-buyer-remediation` @ `0bcf1fbf5` == production build |
| No user work lost or overwritten | `local_pass` | Primary tree untouched; disposition recorded above; worktree isolated |
| Baseline route/test results captured | `local_pass` | typecheck 0, lint 0, 5995 tests pass (table above) |
| Live slice ledger with owner and rollback | `local_pass` | This document |

---

## Slice ledger

| Slice | Content | Depends on | Status | Rollback boundary |
| --- | --- | --- | --- | --- |
| G0 | branch/worktree authority and baseline | none | `local_pass` | no product behavior |
| A1 | shared metric/currency/comparison contracts | G0 | `local_pass` (`590ebd3bb`) | additive adapters |
| A2 | Overview platform-total attribution | A1 | `local_pass` (`14d771834`) | surface adapters |
| B1 | report snapshot: currency and period fidelity | A1 | `local_pass` (`4cd8f59cc`) | snapshot version |
| C1 | unified provider health truth | G0 | `local_pass` (`eee0f01f3`) | additive projection |
| B2 | report widget isolation and in-process sources | B1 | `local_pass` (`90838abb9`) | transport override flag |
| C2 | revalidation policy and honest unknown counts | C1 | `local_pass` (`ec5b46ddf`) | one runtime flag |
| I1 | auth bootstrap once per session | C2 | `local_pass` (`099e75d87`) | revert one guard |
| E2 | Google copy-as-negatives and CSV export | A1 | `local_pass` (`ceb1bd885`) | read-only, independent disable |
| D1 | Agency Today cross-client read model | A1,C1 | `local_pass` (`969d36675`) | additive read model |
| D2 | Agency Today route and /overview surface | D1 | `local_pass` (`c68fcbf27`) | Client Overview fallback |
| D3 | global entity search (server-scoped) | D1 | `local_pass` (`4afd73bf1`) | independent route |
| F1 | workflow overlay (assign/defer/reject) | D1 | `local_pass` (`a1dec7ef5`) | additive, append-only |
| F2 | external-change attribution + handoff recovery | F1 | `local_pass` (`3f4fe5066`) | read-only projection |
| C3 | snapshot-date fallback observability (G0-F3) | C2 | `local_pass` (`4f37ac663`) | logging only |
| J1 | Decisions typography and contrast floor | A1 | `local_pass` (`46d992883`) | surface-scoped CSS |
| G1 | notification event/delivery ledger | F1,C1 | `local_pass` (`8c53ed23e`) | additive; no channel wired |
| G2 | digest/critical channel delivery + bell | G1 | `blocked_external` (delivery gate) | per-channel disable |
| J2 | language honesty + global contrast floor | J1 | `local_pass` (`66753e017`) | token/contract scoped |
| J3 | creative column priority at narrow viewports | J1 | `local_pass` (`894858aee`) | wide viewports unchanged |
| J4 | Google ROAS colour semantics | A1 | `local_pass` | surface-scoped |
| I2 | admin/share route error boundaries | C2 | `local_pass` | additive files |
| S-SMOKE | fix pre-existing full-UI smoke failure (G0-F2/G0-F3) | — | **superseded** — closed as X-5 on 2026-08-09 (`1e35ad6f5`, `b3f892ad2`); the gate is green desktop + mobile | test-only |
| F1b | workflow store + API routes | F1 | `local_pass` (`178cf6e89`) | additive routes |
| C4 | Decisions failed-read retry | C2 | `local_pass` (`178cf6e89`) | UI-only |
| D3b | global search mounted in shell | D3 | `local_pass` (`fccd41899`) | component removable |
| D070 | as-of scope fix + ADR + golden coverage | C3 | `local_pass` (`19b9ce5b9`) | one-line predicate revert |
| F2b | external changes projected into History | F2 | `local_pass` (`0a4c6e98e`) | union arm, additive |
| E1 | Google account scope + mixed-currency guard | A1 | `local_pass` (`af89e988e`) | read-only |
| H1 | guarded action capability resolver | C2,F2 | `local_pass` (`421ecefef`) | default-denied; no execute path |
| C2b | per-surface freshness disclosure | C2 | `local_pass` (`eb94e0551`, `b153e585b`) | additive chip; one contract across all ten Tier-0 surfaces |
| D3c | saved views (scoped, persisted, mounted on Decisions) | D3 | `local_pass` | store-scoped |
| H1b | guarded action preflight + receipt | H1 | `local_pass` (`dd140f7ea`) | read-only route |
| H1c | capability + preflight rendered in inspector | H1b | `local_pass` | component removable |
| F1c | workflow controls rendered in inspector | F1b | `local_pass` | component removable |
| H2 | exact single-Ad pause execution | H1 + D065/D067 | `blocked_external` — **reason updated**: D065/D067 are implemented and seam-proven here, so the contract is no longer the blocker; the remaining gate is a deployed build with `META_GUARDED_EXECUTION_ENABLED=1` and an approved provider call | action-class disable |
| L | release soak and final acceptance | all | `blocked_external` (deploy gate) | exact build rollback |

---

## Release-candidate readiness (Phase 12, non-deploy portion)

Everything the plan's release-candidate checklist asks for that does **not** require a
deployment has been run on this branch:

| Check | Command | Result |
| --- | --- | --- |
| Full test suite | `npx vitest run` | 672 files / **6,236 tests pass** (baseline 5,995) — **historical, as of that slice round.** The authoritative current count is in CURRENT STATUS |
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | exit 0 |
| Production build | `npm run build` | exit 0 — compiled successfully, 219 static pages, 291 routes, 0 errors |
| Migrations from zero | `npm run test:migrations-from-zero` | PASS — builds from empty, idempotent on re-run, launch-intent seam clean |

Not run, and not runnable without approval: signed-in production acceptance, the exact
deployed-build read-back, and the sustained production soak.

**Superseded (2026-08-09).** The full-UI visual gate was listed here as red at baseline. It is
green — desktop and mobile — since X-5 was root-caused and fixed; see the current-status section
below. This paragraph is retained as the historical Phase-12 baseline, not as current status.

This is the furthest the release candidate can be taken before a deployment decision.

---

## Confirmed defect register (root-caused at production commit `0bcf1fbf5`)

| ID | Defect | Location | Maps to |
| --- | --- | --- | --- |
| A1-D1 | Compare=None renders `+0.0%`: `changePercent ?? 0` falls through to the zero branch | `components/overview/MetricCard.tsx:163-184` | Codex live P0 |
| A1-D2 | Delta color from arithmetic sign only; a cost increase renders positive/emerald | `components/overview/MetricCard.tsx:165-177` | Claude P1 |
| A1-D3 | Shared formatter fabricates zero for non-finite money (`${symbol}0`) and percent (`0%`) | `lib/metric-format.ts:14,35` | Money rule: never fabricated zero |
| A1-D4 | Formatter accepts a currency **symbol**, not ISO currency; no scope/source/as-of carried | `lib/metric-format.ts:9-32` | ScopedMetric envelope |
| B1-D1 | Report money hard-coded to `en-US`/`USD` | `lib/custom-report-renderer.ts:13-21` | MR-D064-01 (no USD fallback) |
| B1-D2 | Report renders via internal HTTP self-fetch fan-out (12 call sites) | `lib/custom-report-renderer.ts` | Live 7/7 widget failure |
| B1-D3 | Share re-rendered the stored trailing preset, not the on-screen window | `app/api/reports/[reportId]/share/route.ts` called `renderCustomReportRecord` with no overrides while the view page held `viewStart`/`viewEnd` | Claude P0-5 |
| A2-D1 | Two sections can share a provider label; the title renderer discarded the section's own identity | `app/(dashboard)/overview/page.tsx` `renderPlatformSectionTitle` returned `configured.label` and dropped `fallbackTitle` | Codex live P0 (two Meta totals, no account names) |
| C1-D1 | Settings and Integrations answer provider health from different sources | Settings reads `fetchProviderAccountSnapshot` and inspects only `meta.refreshFailed`/`meta.stale` (account-list discovery freshness) at `app/(dashboard)/settings/page.tsx:186-198`; Integrations uses `deriveProviderViewState` (token expiry, scope blocks, assignment) at `store/integrations-support.ts:345-404` | Codex live P0 (Settings healthy vs Integrations action-required) |

---

## Slice evidence

| Slice | Commit | Tests added | Suite after | Typecheck | Lint |
| --- | --- | --- | --- | --- | --- |
| G0 | `931cfa567` | — | 5995 pass (baseline) | 0 | 0 |
| A1 | `590ebd3bb` | 33 (`metric-semantics` 17, `metric-format` 9, `MetricCard` 7) | 6028 pass | 0 | 0 |
| B1 | `4cd8f59cc` | 9 (`renderer.currency` 4, `share-period-fidelity` 5) | 6037 pass | 0 | 0 |
| A2 | `14d771834` | 6 (`overview-section-labels`) | 6043 pass | 0 | 0 |
| C1 | `eee0f01f3` | 6 (`provider-health-truth`) | 6049 pass | 0 | 0 |
| B2 | `90838abb9` | 8 (`renderer.transport` 4, `report-widget-failure` 4) | 6057 pass | 0 | 0 |
| C2 | `ec5b46ddf` | 10 (`query-client` 4, `decision-lane-counts` 6) | 6067 pass | 0 | 0 |
| I1 | `099e75d87` | 3 (`auth-bootstrap`) | 6070 pass | 0 | 0 |
| E2 | `ceb1bd885` | 13 (`search-term-export`) | 6083 pass | 0 | 0 |
| D1 | `969d36675` | 27 (`agency-today-read-model` 18, `agency-today-store` 9) | 6110 pass | 0 | 0 |
| J1 | `46d992883` | 5 (`decisions-typography-floor`) | 6115 pass | 0 | 0 |
| D2 | `c68fcbf27` | 9 (`agency-today/route`) | 6125 pass | 0 | 0 |
| D3 | `4afd73bf1` | 22 (`entity-search` 15, `search/route` 7) | 6148 pass | 0 | 0 |
| F1 | `a1dec7ef5` | 14 (`decision-workflow`) + migrations-from-zero PASS | 6162 pass | 0 | 0 |
| F2 | `3f4fe5066` | 15 (`external-change-attribution`) | 6177 pass | 0 | 0 |
| C3 | `4f37ac663` | 10 (`decision-date-fallback`) | 6187 pass | 0 | 0 |
| J2 | `66753e017` | 12 (`i18n` 9, `globals-contrast-floor` 3) | 6199 pass | 0 | 0 |
| G1 | `8c53ed23e` | 14 (`notification-contract`) + migrations-from-zero PASS | 6213 pass | 0 | 0 |
| J3 | `894858aee` | 12 (`creative-column-priority`) | 6225 pass | 0 | 0 |
| J4 | see below | 4 (`roas-color-semantics`) | 6229 pass | 0 | 0 |
| I2 | see below | 7 (`route-error-boundaries`) | 6236 pass | 0 | 0 |

Suite growth is exactly the tests added at each step; no baseline test changed behavior.
All four rows are `local_pass` only. **No production acceptance is claimed** — that
requires deployment, which is an explicit approval gate this program has not reached.

---


## Native-authority selective integration (2026-08-09)

Branch `ux/native-authority-integration`, cut from the UX candidate `130dc8627`. Nine rollbackable
slices (five porting, then D066, the D069 seam, instrumentation, and the ledger). The stale branch
`codex/native-ad-bounded-stop-loss-authority` was **not** merged or rebased; its 608 changed files
were filtered by following the type and test dependencies of D065/D067 to closure.

**Scope reconciliation (recomputed 2026-08-09, commands shown).**

```
git diff --name-only 130dc8627 ec54dad4 | wc -l   # 99   initial native integration
git diff --name-only ec54dad4 4546fcae | wc -l    # 30   D066 + first D069 attempt + instrumentation v1
git diff --name-only origin/main HEAD | wc -l     # recomputed below
git diff --shortstat origin/main HEAD             # recomputed below
git log --oneline origin/main..HEAD | wc -l       # recomputed below
```

Those three historical figures are facts and are preserved.

**Correction.** An earlier revision reported the candidate at `b01d7b6` as 90 commits and
+55,002 insertions. Git reports **91 commits and +55,004**. The counts had been read before the
final commit landed; the current figures below are recomputed after the last commit and re-verified. The earlier claim
that "~60 files" were selected from the native branch is **withdrawn**: it was an
estimate presented as a count and was never measured. The candidate's files
are the cumulative result of the whole programme (UX remediation, native
selection, D066, three DB seams, instrumentation, evidence artifacts); no
subdivision of them has been measured, so none is asserted.

| Slice | Content | Rollback |
| --- | --- | --- |
| N-1 | D067 attempt-journal schema (append-only; UPDATE/DELETE refused by trigger) | revert; tables additive, unreferenced |
| N-2 | D069 duplicate-ad reconciliation store + schema | revert; unreferenced |
| N-3 | D065 manual-origin authority + 67 invariant tests | revert; unimported |
| N-4 | Decision-origin execution path, guards reconciled against main | revert; N-1..N-3 stand |
| N-5 | D061 stop-loss gates, D063 constraint upgrade, contract bumps, 92 golden cases | revert; N-1..N-4 stand |

### Three regressions refused

The native branch predates work main has since landed. Taking it wholesale would have removed:

1. `assertProviderWriteAuthorityUnchanged` - absent from that branch's `ads-write.ts` entirely, along
   with `connectionGeneration`. Main made that field **required** precisely because optionality let
   Launchpad skip the reconnect guard on every campaign, ad-set, ad, pause and resume.
2. The tri-state selection check in both `resolveWriteContext` implementations. Without it a
   deselected account resolves cleanly and writes to a live ad account the user removed.
3. `lib/meta/entity-action-selection.test.ts`, which the branch deleted. Kept.

Branch fixtures predating those guards were reconciled, not deleted: guard mocks and
`connectionGeneration` expectations come from main, so the suites now prove the D065 contract **and**
the reconnect/selection guards together.

### Deliberately not integrated (one item)

- **`app/api/launchpad/meta/launch/route.ts`**, which pulled in an unrelated Launchpad chain. Its
  one incompatibility (`MetaAdsActionStatus` gaining `pending`) was fixed by narrowing a return
  annotation to what the function actually returns.

Nothing else from the native branch is skipped. D066 and the D069 real-path seam were completed on
2026-08-09 (see below); the earlier note deferring them is superseded.

---

## CURRENT STATUS (authoritative)

Everything above this line is historical record. This section is the current truth, written in the
present tense. Where the two disagree, this section wins — and nothing in this section is corrected
by a later paragraph. Statements that were true once and are false now have been rewritten here
rather than left standing with a superseding note attached somewhere else; the few that are kept
for their root-cause value are labelled **superseded** at the statement itself.

**Candidate:** the tip of `ux/native-authority-integration`, cut from `origin/main` @ `0bcf1fbf5`.
The exact tip SHA is stated in the deploy approval request, since a commit cannot record its own
hash.

**Scope vs `origin/main`:** 609 files changed, +63317 / −4365, across 120 commits
(`git diff --shortstat origin/main HEAD`, `git log --oneline origin/main..HEAD | wc -l`).

Recomputed against the commit that contains this line. The commit holding this paragraph changes
the counts it reports, so the figures were re-read after it existed and the commit amended until the
commands and the text agree.

### D066 — decision-fact ownership (complete)

`meta_ad_daily` has exactly one owner. `upsertMetaAdDailyRows` requires
`writeMode: "authoritative_fact"`; omitted, null, unknown and the retired `creative_enrichment`
lane all fail closed *before* the empty-rows shortcut, so a refusal is never a partial mutation.
Creative enrichment writes no decision facts — it was writing full economic evidence from the
creatives endpoint — and keeps its three dedicated writers (creative daily, creative dimensions,
media presentation). The authoritative payload is sanitized: creative-media, preview and media-debug
keys are removed recursively from `payload_json` while economic evidence is retained.

| Evidence | Result |
| --- | --- |
| `lib/meta/ad-daily-write-ownership.test.ts` | 10 invariants |
| `scripts/ephemeral-postgres-ad-daily-ownership-seam-child.ts` | real-Postgres seam PASS (D066 requires a seam, not a mocked SQL-shape test) |
| `lib/meta/creatives-warehouse.test.ts` | asserts `not.toHaveBeenCalled()` on the retired writer |

No ADR was needed: D066 prescribes this resolution verbatim. The decision was implemented, not
amended.

### D069 / D065 / D067 — route-level write seam (complete)

`scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts` builds a real authenticated
session (a `sessions` row and its cookie) plus a genuinely connected, selected integration, then
calls the **shipped route handler** `app/api/meta/ads/[adId]/pause/route.ts`.

**Superseded, kept for its root-cause value:** an earlier seam called `pauseAd()` and appended
journal events itself. That proved the provider client behaves and that the append functions accept
input — nothing about whether the shipped route produces durable lineage, which is the actual D069
claim. It was deleted rather than adapted.

Everything asserted below is written by production code; the seam only seeds fixtures, replaces
`globalThis.fetch`, and reads the database back.

| Proven | How |
| --- | --- |
| Claim + lineage created by production | exactly one action claim carrying the exact account, Ad and creative; `attempt_started` and a terminal completion present, with exact ad/creative/campaign/adset/account |
| One POST maximum | one POST for one authorized pause, naming the exact Ad and carrying the authorized credential |
| No automatic retry on ambiguity | transport ambiguity yields exactly one POST; the persisted receipt records `attemptCount: 1`, `automaticRetryAttempted: false`; never reported as success |
| Zero POST, fail-closed | deselection, revoked connection generation, identity/permission mismatch (a real session for a user with no membership), and kill switch |
| Append-only lineage | the journal refuses `UPDATE` and `DELETE` at the database |

### Instrumentation posture — section 9 complete (G0-F4 resolved)

First-party retained sink: `product_instrumentation_events`, scoped either to one business or to
the portfolio, and **never** to `businesses[0]` — the scope/tenancy pairing is enforced by a
database CHECK, so attributing cross-tenant work to one tenant is impossible at the storage layer.
No user id, email, session id, or free-text column. `surface` is a closed allowlist; the catch never
reads `error.message`. Writes are awaited and bounded (750ms) rather than detached. Retention runs
from the same cron as the other maintenance jobs and is proven idempotent.
`product_instrumentation_sink_health` makes a failing sink operator-visible rather than a console
line.

**All 36 events in the vocabulary have a shipped emitter.** Verified against the tree, not asserted:
every name in `PRODUCT_INSTRUMENTATION_EVENT_NAMES` has an emit site outside
`lib/product-instrumentation.ts`, `lib/migrations.ts` and test files. The per-family evidence table
is below under "Section 9". `lib/product-instrumentation-emitters.test.ts` holds the map and also
asserts that `lib/meta/ads-action-log.ts`, `lib/meta/manual-ad-status-reconciliation.ts` and
`lib/notification-store.ts` never reach for the client telemetry endpoint: a browser can report
intent, but only the server knows whether a claim was created, whether a POST went out, or whether a
delivery was attempted.

**Superseded:** an earlier revision of this section read "**Partially** resolved: five events have
real emitters." That was true when written and is false now.

### Mobile Tier-0 — capability-gated tasks ship; the device pass does not

Two different things were being reported as one. Separated:

- **Local, shipped, tested.** `components/meta/os/MobileTier0Triage.tsx` is mounted in
  `components/meta/os/DecisionsOsView.tsx` and gates on a phone-width media query and on whether
  ownership can be read. At phone width an operator reads a decision, sees its evidence, and takes
  ownership through `DecisionWorkflowControls`; `mobile_tier0_started` and `mobile_tier0_completed`
  are emitted, the latter from the transition that actually recorded ownership rather than from a
  click. Covered by `components/meta/os/mobile-tier0-triage.test.tsx` and captured at 320 and 390 in
  the six-width matrix.
- **Not local.** Section 10 of the plan requires a *physical* mobile Tier-0 pass. An emulated 390px
  viewport is not a device; touch targets, real keyboards and actual network conditions are not
  emulated here.

D5 keeps provider mutation (budget, bid, activation, bulk) on desktop. It does not make mobile
read-only, and it never excused missing telemetry for the triage task mobile is permitted to do.

**Superseded:** an earlier revision read "C-4 remains `local_pass` for its read model only … KPI
visibility only". That is contradicted by the shipped, mounted ownership write above.

### Local gates (recomputed on the final SHA)

| Gate | Exact command | Result |
| --- | --- | --- |
| Full suite | `LC_ALL=C npx vitest run` | **7,140 pass**, 0 fail, 61 skipped, 63 todo (720 files) |
| Focused D061–D069 | `npx vitest run lib/launchpad/meta-manual-authority.test.ts lib/meta/decision-origin-action-preflight.test.ts lib/meta/ads-action-log.test.ts lib/creative-decision-engine/__tests__/execution-safety.test.ts lib/creative-decision-engine/__tests__/golden-cases.test.ts lib/meta/ad-daily-write-ownership.test.ts` | **235 pass**, 43 todo (6 files) |
| Section 9 vocabulary + emitters | `npx vitest run lib/product-instrumentation.test.ts lib/product-instrumentation-emitters.test.ts` | 30 pass |
| Tier-0 freshness | `npx vitest run lib/tier-zero-freshness-coverage.test.ts lib/tier-zero-as-of.test.ts lib/tier-zero-idle-tab-revalidation.test.ts components/states/tier-zero-freshness.test.tsx app/api/reports/tier-zero-freshness.route.test.ts` | 85 pass |
| Accessibility | `npx vitest run lib/accessibility-contract.test.ts` | 15 pass, plus live browser checks in the smoke |
| Typography floor | `npx vitest run lib/typography-floor.test.ts` | 3 pass |
| Dark-mode absence | `npx vitest run lib/visual-dark-mode.test.ts` | 6 pass |
| History completeness | `npx vitest run lib/meta/history-projection-completeness.test.ts lib/meta/history-external-change-levels.test.ts lib/meta/history-sql-parameter-types.test.ts` | 19 pass |
| Typecheck / lint | `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| Production build | `npm run build` | clean |
| Migrations from zero | `LC_ALL=C EPHEMERAL_PG_BIN_DIR=… npm run test:migrations-from-zero` | PASS, idempotent, 11 DB seams |
| Visual matrix | `LC_ALL=C FULL_UI_SMOKE_ARTIFACT_SET=tier-zero-freshness npm run test:full-ui:visual` | **6 passed**: 320, 390, 768, 1280, 1440, 1728 — all light |

`test:full-ui:visual` sets `FULL_UI_SMOKE_EXTENDED=1`, so the six-width matrix above is what runs.
It captures 13 surfaces: login, overview, meta-decisions, meta-history, creative-studio, google-ads,
launchpad, automation, reports, settings, integrations, studio-copy, studio-inbox. Artifacts under
`docs/full-ui-redesign/playwright-smoke-artifacts/tier-zero-freshness/`.

Beyond screenshots the smoke asserts, in a real browser at every width: no page-level horizontal
scroll and no scroller hiding tabular content below 480px; focus visibility, positive tabindex,
undescribed images and reduced-motion honouring; and the Tier-0 freshness reading read back out of
the DOM, failing when a surface renders no reading, shows a figure while reporting loading, or
reports an error with no named code and no retry.

**No dark run is claimed.** Nothing applies the `.dark` class — no toggle, no theme provider, no
`prefers-color-scheme` rule — so a dark project would render light while filing screenshots under a
dark name. `lib/visual-dark-mode.test.ts` is the standing proof and fails the day a real mechanism
is added.

**Test-file impact, measured.** `git diff --name-status origin/main HEAD -- '*.test.ts' '*.test.tsx'`
reports 7,132_ADDED added and 7,132_MODIFIED modified. Pre-existing test files **were** modified,
because the contracts they encoded changed — D065's guards, D066's single-owner rule, the D063
constraint vocabulary, the health join, the comparison-preset contract and the bell. That is a
legitimate reason to edit a test; it is not "no pre-existing tests changed", and any earlier claim
to that effect is withdrawn.

**Environment note.** The ephemeral-Postgres suites need `LC_ALL` set on macOS. Without it PG16
fails with `postmaster became multithreaded during startup`, which reads as a code failure and is
not one.

### Section 9 — the four previously excluded families, verifiable in one pass

Each row is a command anyone can run. "Shipped emitter" means an emit site outside a test file.

| Family | Events | Shipped emitter | Tests | Real-Postgres seam |
| --- | --- | --- | --- | --- |
| Notification | attempted / delivered / opened / acknowledged | `lib/notification-store.ts:131,179,210,240` | `lib/notification-contract.test.ts`, `lib/notification-lifecycle.test.ts`, `lib/notification-read-model.test.ts`, `lib/notification-producer.test.ts`, `app/api/notifications/route.test.ts`, `components/notifications/notification-bell.test.tsx` | `scripts/ephemeral-postgres-notification-seam-child.ts` |
| Guarded | confirmed / provider-attempted / verified / failed / ambiguous / reconciled | `lib/meta/ads-action-log.ts`, `lib/meta/manual-ad-status-reconciliation.ts`, `app/api/meta/decision-action/preflight/route.ts` | `lib/meta/ads-action-log.test.ts`, `lib/meta/manual-ad-status-reconciliation.test.ts` | `scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts` |
| Mobile Tier-0 | started / completed | `components/meta/os/MobileTier0Triage.tsx:117,130`, mounted in `DecisionsOsView` | `components/meta/os/mobile-tier0-triage.test.tsx` | — (client task; the workflow write it hangs off is covered by the workflow route tests) |
| Google deep link | used | `components/google-ads/GoogleAdsIntelligenceDashboard.tsx`, URL built by `lib/google-ads/deep-link.ts`, rendered at three sites | `lib/google-ads/deep-link.test.ts`, `lib/google-ads/deep-link-wiring.test.ts` | — (no write; the builder refuses rather than guesses) |

`META_GUARDED_EXECUTION_ENABLED` is unset throughout. The guarded transitions are exercised against
real Postgres and a fake provider by the seam above, which is what makes them testable without any
provider write.

### Tier-0 freshness — one contract, thirteen surfaces

`components/states/TierZeroFreshness.tsx` with `useTierZeroFreshness` and
`store/tier-zero-freshness-store.ts`, mounted in **both** frames in
`components/layout/dashboard-frame.tsx` — the console one and the legacy one Overview renders
through. States: loading (no figure at all), refreshing, ready, partial (names the missing source),
error (bounded code, retry that re-runs the read that failed).

Every surface dates itself from a measured instant, never from a fetch time, a calendar date, an
echoed request parameter or a content edit time. `lib/tier-zero-as-of.ts` names what qualifies and
`lib/tier-zero-as-of.test.ts` fails any surface that hardcodes `asOf: null`.

Launchpad reports no age by argument rather than by default: it is a wizard composing from live
reads with no historical figures, and the test names it explicitly so the exemption has to be
defended. Audiences reports nothing because it is a declared planned surface that renders no data.

### Mobile Creative Studio — stacked cells carry their names

Below 767px `StudioOsView` turns each table row into a card and takes the header row out of the
layout, so no `<th>` can label anything. The stylesheet was written for exactly that —
`components/creatives/StudioOsView.tsx:154` renders
`tbody td::before { content: attr(data-label) }` — and **no `<td>` ever set the attribute**. The
comment three lines above it claimed "each cell carries its own label"; none did.

The committed 390px artifact was the proof: `$840.00`, `47`, `$3,360.00`, `$17.87`, `4.00x` — five
values in a fixed order that a buyer is expected to recognise by position, with the only thing that
named them hidden by the same stylesheet. It passed every clipping and overflow check because
nothing was clipped. The numbers were all visible; none of them said what it was.

Fixed in the rendered DOM: the metric cells carry `data-label={stackedCellLabel(id)}` and the
identity cell `data-label="Creative"`. `stackedCellLabel` resolves through the same `metricLabel(id)`
the column header uses, so the phone and the desktop cannot drift, and it keeps the `Meta-attr.`
qualifier — a Meta-attributed ROAS is not the same claim as the account's ROAS, and the phone is
where that context is least inferable.

| Evidence | Result |
| --- | --- |
| `components/creatives/StudioOsView.test.tsx` | 14 pass. The mobile-label block parses `<td>` elements out of the real `renderToStaticMarkup` output rather than testing `resolveCreativeColumnPriority`, which was already correct and unused by the table. Reverting the fix fails it with "9 of 9 stacked cells render a value with no name" |
| Six-width smoke | Below 480px it finds tables the stylesheet actually stacked (first body cell computed `display: flex`) and fails on any non-empty cell without a label |
| 320px artifact | `Creative`, `Spend $840.00`, `Purchases 47` — labelled, no horizontal scroll |
| 390px artifact | `Creative`, `Spend $840.00`, `Purchases 47`, `Meta-attr. Revenue $3,360.00`, `CPA $17.87`, `Meta-attr. ROAS 4.00x` — every value named |

The smoke also hides the Next.js dev-tools badge before capturing. It runs `next dev`, so that
floating indicator is in every screenshot and exists in no production build; it sat directly over
the CPA label at 390px and over `Spend` at 320px, which made the committed evidence unreadable for
the one thing it exists to show. It changes nothing the assertions read from the DOM.

### Integration of current `origin/main`

`origin/main` advanced to `4ddba8d0a` ("Keep a scope alive while its business cycle is still
running") while this candidate was frozen. Merged in with `--no-ff`.

That commit touches exactly one file, `lib/sync/worker-runtime.ts`, and this branch never modifies
it — so there was no semantic conflict to resolve, and `git diff origin/main HEAD --
lib/sync/worker-runtime.ts` is empty: the worker fix is carried through byte-for-byte alongside the
whole UX/native-authority body.

What it fixes matters for this release: the health gate asked whether each provider scope
heartbeated inside a five-minute window, and a business cycle only heartbeats at its boundaries, so
a long Google cycle looked dead while it was working. Fifty autoheal restarts across the acceptance
window were retiring a worker that was never unwell.

### Regression found by `verify:pre-push`, and what it says about ports

Stage 05 of the database seams failed on this branch and passed on clean `origin/main`. Not a
flake and not pre-existing: a regression this branch introduced, found only because the release
gate runs the seams.

Slice 5 (`e650163e8`) ported the native-authority branch's
`lib/creative-decision-engine/data-source.ts` wholesale. That file had forked before three main
fixes landed, so the port reverted all three while contributing nothing — the entire diff against
main was 4 insertions and 31 deletions, and those 4 were one reordering. It reverted **main's tests
for them in the same commit**, which is why the suite stayed green over a weaker contract.

| Lost | Guarded by | Actually caught by |
| --- | --- | --- |
| `AND binding.is_selected`, in both the hydration and completeness CTEs. Main's own comment: "a deselected account must not receive decisions" | nothing | nothing — restored by inspection |
| The compaction-aware retained-state clause on the receipts query | a unit test the port deleted | seam stage 05, forty minutes in |
| The COALESCE precedence from `6c24cede6` ("bind calibration reuse to full account identity") | a unit test the port inverted | nothing — restored by inspection |

Two of the three would have shipped silently. The selection one is the serious one: the engine
would hydrate and decide for accounts the operator had deselected.

The precedence looked like two competing intents and is not. Main's ordering is gated on
`$12::boolean`, so on a point-in-time replay that flag is false and the historical
`account_identity` wins regardless. Main's version is both the newer decision and the cutoff-safe
one; the inversion bought nothing.

Every other file where this branch net-removes main content was audited and is a genuine D061–D069
replacement: the zero-conversion burner resolves through `commercialStopLossThresholds`, the
campaign label guard implements the review-only policy, and the briefing action handlers replaced
candidate-id matching with exact-identity authority — stricter than what they removed, with
`hasNativeDecisionOriginLineage` still exported and used.

### Released to production

Deploy identity: `72b3897cfeb57eb17e86d8d20dfb28a8d6bdd1ca` — the merge commit for PR #205, which
differs from the local candidate `6b815b72297533dcb8e1dbdeb1fb8cc2d902ada8`.

| Step | Evidence |
| --- | --- |
| PR #205 CI | typecheck, test, database-seams, build — 4/4 pass; merge state CLEAN |
| Images | `omniads-web` `sha256:9809139b320d…`, `omniads-worker` `sha256:8cb5347734f1…`, both tagged with the exact SHA |
| `deploy/CUTOVER_REQUIRED` | absent on main |
| Deploy run 31347693416 | success — cutover gate, registry verification, migrations, recreate, local readiness, public build propagation, ingress smoke, all green |
| Public build readback | `https://adsecute.com/api/build-info` and `https://www.adsecute.com/api/build-info` both return the exact SHA; `/api/healthz` `ok: true` |
| Post-deploy verification 31347866497 | success; artifact records `deployGate: pass` and `releaseGate: pass` for the exact SHA |

Read-only production acceptance, signed in, no writes of any kind:

- **Agency Today / Overview** — 12 clients ranked, "1 of 12 clients need you first". A disconnected
  provider reads "Needs you first / Provider disconnected" with `—` rather than a fabricated zero,
  which is the health join. "No portfolio total — clients use different currencies" is the
  mixed-currency withholding, over live TRY/USD/GBP. Compare=None renders `— —` and "No comparison
  selected for this period", not a 0%.
- **Meta Decisions** — caught mid-load showing "Loading — no figures yet", then settled at "as of
  21h ago" with 64 structures and 21 ads. Two fail-closed disclosures render and name their source:
  "Native Ad decisions are degraded… Source: native_latest_job_engine_mismatch", and a commercial
  target review notice that states explicitly it does not suppress Scale/Cut authority.
- **Creative Studio** — 22 creatives, `Meta-attr.` qualifiers intact on Revenue and ROAS. The mobile
  fix is live and measured in the deployed DOM: 180 `td[data-label]` cells carrying `Creative`,
  `Spend`, `Purchases`, `Meta-attr. Revenue`, `CPA`, `Meta-attr. ROAS`, `Link CTR`,
  `CVR LPV to purchase`, and the deployed stylesheet carries
  `@media (max-width: 767px) .studio-table-scroll tbody td::before { content: attr(data-label) }`.
- **Reports** — "as of just now", from the route `generatedAt` added this session rather than the
  newest report's edit time. An empty list reads as genuinely empty.
- **Integrations** — "as of 1m ago" from each provider's own last completed sync. Meta Connected,
  Google Action required with a named queue-recovery reason, TikTok labelled "a visible roadmap
  placeholder, not a working connector".
- **Settings** — "as of just now" while "Member since 3/8/2026" appears only as account content.
  Before this session's fix the bar would have reported the signup date as the data's age.

**Not verified in production, and why.** The 320/390 Creative Studio *screenshot* was not retaken
against production: the available browser could not be resized below 1281px. Both halves of the fix
were measured in the deployed build instead — the labelled cells and the media rule above — and the
visual confirmation at 320 and 390 is the committed local evidence for the identical code.

### Post-release defects found in signed-in production, and closed

The release at `72b3897cf` was green on every gate and still shipped seven defects that only a
signed-in production pass could surface. Each is recorded here with the evidence that found it,
because "all gates green" was true at the time and was not enough.

| # | Defect | How it was found | Fix |
| --- | --- | --- | --- |
| 1 | Overview printed `0.0%` under Compare=None | Observed on live `/overview`: Pins said "No comparison selected" while Store Metrics, Meta, Google and Expenses cards showed `0.0%` for the same period | `resolveDelta` did `changePct ?? 0`. A missing comparison now renders `—` with the reason, no arrow and no colour; a genuine zero keeps its `0.0%`, because flat is a real result |
| 2 | Decisions called its range a "Decision date range" | The canonical read model types the scope `metricsRangeAffectsDecisionSnapshot: false` | Renamed to "Metrics window" with a line stating it does not change the current verdict or its authority. No resolver, threshold, confidence or snapshot semantics touched |
| 3 | 320px topbar controls physically overlapped | Measured in production: Refresh over Meta `3×16px`, Meta over Notifications `28×28px` | The bar was one fixed 50px row with `overflow: hidden`, so the controls stacked rather than clipped and nothing reported it. Freshness now takes its own row below 720px; nothing is hidden |
| 4 | Two dead affordances | "Notify me" wrote one line to the console; a `⌘K` hint sat in the platform menu with no handler | The notify link is removed rather than backed by an invented store. The shortcut is real, lives on the search control, and yields to inputs, textareas, contenteditable and IME composition |
| 5 | Studio essential text below the contrast and size floor | Token audit: Studio scopes its own palette, so the console-wide pass never reached it — `--ink3` 3.82:1, `--ink4` 2.31:1, and 81 sub-12px sizes | Tokens raised to clear 4.5:1 in both palettes, `--ink-decorative` added so the decorative case is declared rather than implied, and every sub-12px size raised |
| 6 | The sparkline implied a verdict | It accepted `tone` and dropped it (`tone: _tone`), painting every metric blue-to-emerald; the SVG was `aria-hidden` and the readout pointer-only | One neutral line for every metric, because there is no trustworthy per-metric direction here to colour from. Accessible name and summary, keyboard focus, Arrow/Home/End navigation, live region, dashed comparison |
| 7 | A false mobile read-only claim | The banner rendered on every route without its own mobile surface, including Settings and Integrations, which render working write controls at that width | Gated on a route/capability matrix. D5 gates provider mutation to desktop; it never covered account or workspace settings, and that is the distinction the old condition flattened |

An eighth was found by the matrix itself while proving the seventh, and is recorded here because
it was not on the list and would otherwise go unmentioned:

| # | Defect | How it was found | Fix |
| --- | --- | --- | --- |
| 8 | Console text painted in a border colour | The six-width run measured `data as of 8/10/2026` on `/platforms/meta/copies` at 1.60:1, at both 320 and 390 | `.ad-final` aliased `--muted-2` to `--adc-b2`, a hairline shade the next line also publishes as `--border-3`. Twenty-five text sites drew through it. `--muted-2` now resolves to `--adc-ink3`; the two genuine hairline users moved to `--border-3` and render identically |

Defect 8 is the same shape as defect 5 seen from the other side. Defect 5 was Studio scoping its
own palette so the console-wide pass never reached it; defect 8 was the console-wide layer itself
being wrong in a way no name revealed — `--muted-2` sits in the ink family and reads like "slightly
quieter than `--muted`". Only resolving the alias to a literal colour shows it, which is why
`lib/console-ink-token-contrast.test.ts` measures rather than lints the name.

Every one has a behaviour test proven to fail on the pre-fix code first, and the six-width matrix
now asserts each in a real browser: topbar rectangle intersections, fabricated comparison
percentages, computed contrast, computed type size, the Cmd/Ctrl+K and Escape path on the real
search field, and Arrow-key movement of the trend chart's reading.

Two of those assertions had to be corrected rather than satisfied, and both corrections preserved a
finding instead of erasing one. The contrast probe first reported 1.23:1 for black text on a pale
green cell — impossible, and caused by parsing `color-mix(in oklab, ...)` with an rgb-shaped
regex; it now normalises through canvas and composites alpha up the tree, and skips any colour it
cannot resolve rather than guessing. The token test first reported `--muted` failing at 1.17:1,
which was a file-wide search finding one of the five `--muted` declarations in `globals.css` — the
shadcn one, which nothing paints text with. Scoped to the declaring block, only the real defect
failed, at 1.5966:1 against the browser's independently measured 1.60.

### Remaining work, classified honestly

Two categories. Conflating them was a real defect in earlier revisions of this ledger.

**Closed 2026-08-09 (was listed here as open, now evidenced):**

- **Mobile composition.** The creative table stacks into task-priority cards below 767px; the
  committed 390px artifact shows identity, spend, purchases, revenue, CPA, ROAS and the full
  "Assessment unavailable" chip with no clipping and no horizontal scroll.
- **Typography floor.** 105 CSS rules, 530 Tailwind arbitrary sizes and 112 inline `fontSize`
  values below 11px raised to 12px; `small` floored. Enforced by `lib/typography-floor.test.ts`
  and by a computed-size assertion in the smoke, which caught text the stylesheet scan missed.
- **Clipping is a gate.** The smoke asserts no page-level horizontal scroll *and* that no scroller
  containing tabular content hides any of it. The second is the one that matters: the page-level
  check passed while the row still clipped, because the frame scrolled internally.
- **Section-9 instrumentation.** All 36 events, each with a shipped emitter, proven by
  `lib/product-instrumentation-emitters.test.ts`. Client-only interactions reach the sink through a
  bounded authenticated endpoint that re-validates every field server-side. Server-owned truth does
  not: `lib/meta/ads-action-log.ts`, `lib/meta/manual-ad-status-reconciliation.ts` and
  `lib/notification-store.ts` call `recordProductInstrumentationEvent` directly, and the same test
  asserts they never reach for the client endpoint. A browser can report intent; only the server
  knows whether a claim was created, whether a POST went out, or whether a delivery was attempted.
- **Accessibility.** 15 structural assertions plus live browser checks for focus visibility,
  positive tabindex, undescribed images and reduced motion. Findings fixed: the search box was a
  combobox with no `aria-expanded`, and animations ignored `prefers-reduced-motion`.
- **Visual matrix.** Six real light widths (320/390/768/1280/1440/1728), Overview and Integrations
  captured for the first time. The eight dark projects are removed: nothing applies the `.dark`
  class, so they rendered light while filing screenshots under a dark name.
  `lib/visual-dark-mode.test.ts` proves the absence of any user-exposed mechanism.
- **Agency Today health.** Joined to the canonical provider connection state instead of inferred
  from whether totals exist. A revoked token with cached numbers used to read "healthy" here while
  Integrations showed action required for the same client at the same moment.
- **History projection.** Workflow ownership and the append-only provider attempt journal are now
  projected. `history-projection-completeness.test.ts` asserts every declared source is queried,
  so a source the filter offers can never return empty because it was never wired.

### Section 9 — the four excluded families, verifiable in one pass

Each row is a command anyone can run. "Shipped emitter" means an emit site outside a test file.

| Family | Events | Shipped emitter | Tests | Real-Postgres seam |
| --- | --- | --- | --- | --- |
| Notification | attempted / delivered / opened / acknowledged | `lib/notification-store.ts:131,179,210,240` | `lib/notification-contract.test.ts`, `lib/notification-lifecycle.test.ts`, `lib/notification-read-model.test.ts`, `app/api/notifications/route.test.ts` | `scripts/ephemeral-postgres-notification-seam-child.ts` |
| Guarded | confirmed / provider-attempted / verified / failed / ambiguous / reconciled | `lib/meta/ads-action-log.ts:1668,2570,2590-2599,4223`; `lib/meta/manual-ad-status-reconciliation.ts:266`; `app/api/meta/decision-action/preflight/route.ts:130-134` | `lib/meta/ads-action-log.test.ts`, `lib/meta/manual-ad-status-reconciliation.test.ts` | `scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts` |
| Mobile Tier-0 | started / completed | `components/meta/os/MobileTier0Triage.tsx:117,130`, mounted at `components/meta/os/DecisionsOsView.tsx` | `components/meta/os/mobile-tier0-triage.test.tsx` | — (client task; the workflow write it hangs off is covered by the workflow route tests) |
| Google deep link | used | `components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1614`, URL built by `lib/google-ads/deep-link.ts` and rendered at three sites | `lib/google-ads/deep-link.test.ts`, `lib/google-ads/deep-link-wiring.test.ts` | — (no write; the builder refuses rather than guesses) |

Whole-vocabulary check, run against the tree rather than asserted: all 36 names in
`PRODUCT_INSTRUMENTATION_EVENT_NAMES` have an emit site outside `lib/product-instrumentation.ts`,
`lib/migrations.ts` and test files. `lib/product-instrumentation-emitters.test.ts` holds the map and
also asserts that `lib/meta/ads-action-log.ts`,
`lib/meta/manual-ad-status-reconciliation.ts` and `lib/notification-store.ts` never reach for the
client telemetry endpoint — a browser can report intent, but only the server knows whether a claim
was created, whether a POST went out, or whether a delivery was attempted.

`META_GUARDED_EXECUTION_ENABLED` is unset throughout. The guarded transitions are exercised against
real Postgres and a fake provider by the seam above, which is what makes them testable without any
provider write.

**Closed 2026-08-09, previously listed here as open.** Each of the five had a stated reason, and
in every case the reason described a missing implementation rather than a genuine impossibility.
Calling that "not contractable" was the error; the work is what closes it.

| Was open | What shipped | Evidence |
| --- | --- | --- |
| Notification lifecycle events | `lib/notification-store.ts` records the four real transitions, `lib/notification-producer.ts` creates them from anomalies, `app/api/notifications/route.ts` marks delivery on fetch and `app/api/notifications/[deliveryId]/route.ts` records open and acknowledge. Enqueue is an *attempt*; it becomes `delivered` only when the recipient's client has actually fetched it, because marking enqueue as delivery would make the delivery rate a measure of our own queue | `lib/notification-contract.test.ts`, `lib/notification-lifecycle.test.ts`, `lib/notification-read-model.test.ts`, `app/api/notifications/route.test.ts`, `scripts/ephemeral-postgres-notification-seam-child.ts` (real Postgres) |
| Guarded confirmed / provider-attempted / verified / failed / ambiguous / reconciled | Emitted at the actual transitions in `lib/meta/ads-action-log.ts` — confirmed when the claim row is inserted, provider-attempted inside the transaction *after* lineage validation so a refused attempt is never counted, and the completion event mapped from the recorded outcome. `lib/meta/manual-ad-status-reconciliation.ts` emits `guarded_action_reconciled` only when an ambiguity is actually closed, never on a blocked, still-settling or unnecessary run. `META_GUARDED_EXECUTION_ENABLED` stays unset; the fake-provider and Postgres seams exercise the production transitions | `lib/meta/ads-action-log.test.ts`, `lib/meta/manual-ad-status-reconciliation.test.ts`, `scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts` (real Postgres) |
| Mobile Tier-0 start/complete | `components/meta/os/MobileTier0Triage.tsx`, capability-gated on phone width and on whether ownership can be read, mounted in `components/meta/os/DecisionsOsView.tsx`. D5 still keeps provider mutation off mobile — it suppresses unsafe writes, it does not excuse missing telemetry for the triage task mobile *is* permitted to do. A task opened and abandoned records a start with no completion, which is the honest signal | `components/meta/os/mobile-tier0-triage.test.tsx` |
| Google deep-link used | `lib/google-ads/deep-link.ts` builds permission/account/entity-scoped links and refuses rather than guesses: no link without a numeric customer id, and a campaign link without a campaign id is refused rather than silently downgraded to an account link. Rendered in `components/google-ads/GoogleAdsIntelligenceDashboard.tsx`, and the anchor renders only when the builder returned a destination | `lib/google-ads/deep-link.test.ts`, `lib/google-ads/deep-link-wiring.test.ts` |
| Freshness adoption breadth | One contract across all ten Tier-0 surfaces via `components/states/TierZeroFreshness.tsx`, `components/states/useTierZeroFreshness.ts` and `store/tier-zero-freshness-store.ts`, mounted in both frames in `components/layout/dashboard-frame.tsx` (the console one and the legacy one Overview renders through). The Decisions inspector, which had no date on its evidence at all, now carries the lane snapshot date | `lib/tier-zero-freshness-coverage.test.ts`, `components/states/tier-zero-freshness.test.tsx`, `lib/tier-zero-idle-tab-revalidation.test.ts`, `app/api/reports/tier-zero-freshness.route.test.ts`, and the six-width freshness evidence under `docs/full-ui-redesign/playwright-smoke-artifacts/tier-zero-freshness/` |

**Found while capturing the freshness evidence, and fixed.** The History journal compared a UUID
`business_id` against the text `$1` on `meta_ads_action_mutation_attempt_events`. Because the
journal is one query with many UNION branches sharing one parameter type, Postgres refused the
*entire* query with `operator does not exist: uuid = text` — so History failed completely, every
source with it, for every user. It only shows up against a real database, which is why the
six-width run caught it and the unit suite did not.
`lib/meta/history-sql-parameter-types.test.ts` now reads each branch's table out of the migrations
and fails on any uncast UUID comparison; it was confirmed to fail on the pre-fix SQL rather than
pass vacuously.

**Two silent-surface defects, found by the evidence rather than by reading the code.** Both were
surfaces whose freshness wiring looked correct and reported nothing:

- `/platforms/meta` renders `DecisionsOsView`, not `MetaPlatformPage`, and `/platforms/meta/creatives`
  renders its own page, not `CreativeStudioWorkspace`. The wiring had been added to components those
  routes had stopped rendering. Each file passed its own coverage check while the surface stayed
  quiet. The coverage test now follows the route: the route must reference the component it is
  credited with rendering.
- Overview renders through `LegacyDashboardFrame`, and the bar was mounted only in `ConsoleTopbar`.
  Overview was reporting its data age to a bar that was never on screen. The coverage test now
  counts frames against bar mounts, and the smoke fails outright when a Tier-0 surface renders no
  reading at all — silence is the failure the contract exists to prevent, and it is how a surface
  goes quiet without anyone noticing.

**The four "age unknown" surfaces now report a measured instant.** Reading `null` because a route
published only date-range labels was true, and it was a reason to change the route rather than to
leave the operator without an age. Each route now publishes a real observation time:

| Surface | Published timestamp | Where |
| --- | --- | --- |
| Creative Studio, Creative inbox | `MAX(computed_at)` over the snapshot rows, as `snapshotLatest.observedAt` | `app/api/creatives/briefing/route.ts` |
| Studio — Copies | `MAX(updated_at)` over the `meta_ad_daily` rows in the window, as `meta.warehouseObservedAt` | `app/api/meta/copies/route.ts` |
| Studio — Landing pages | the GA4 retrieval time, stamped at the live fetch and carried by the cache | `app/api/analytics/landing-page-performance/route.ts` |

None of these is the route's own run time. `generatedAt` is kept on the copies response for
debugging and is explicitly not the as-of: it records when the request ran, which is fresh by
construction and would restate the age of the request as the age of the data. The GA4 stamp is
taken on the live retrieval and *not* on the cache-hit path, so a response served an hour later
reports when GA4 was read rather than when it was handed over; `lib/tier-zero-as-of.test.ts`
asserts that specifically.

Launchpad remains `null` by argument rather than by default: it is a wizard that composes from live
reads and shows no historical figures, and the test lists it explicitly so the exemption has to be
defended rather than assumed. Audiences reports nothing because it is a declared planned surface
that renders no data. Any other surface hardcoding `asOf: null` now fails
`lib/tier-zero-as-of.test.ts`.

**Reading the artifacts correctly.** Several surfaces render "age unknown" in the committed
evidence. That is the *fixture* speaking, not a missing contract: the smoke seeds a Meta decision
account and little else, so there are no Shopify sync rows for Overview, no completed provider syncs
for Integrations, no configured business control for Automation, no snapshot rows for Creative
Studio, and no Google accounts assigned at all — which Google reports as `partial` with the reason
named rather than as a bare unknown. Each of those surfaces asks its route for a real timestamp and
is told there is none, which is exactly what it should then say.

The wiring is proven by `lib/tier-zero-as-of.test.ts` — which asserts the routes publish the
timestamps and the surfaces read them — not by whether a fixture happens to carry data. A surface
that rendered a confident date over an empty warehouse would be the defect.

**Nothing remains open locally.** Every gap below needs the deploy, an approved provider call, or a
physical device — none has a local component that was skipped.

**Production-only or physical-device** — no local component exists:

| Gate | Needs |
| --- | --- |
| A-7 non-USD end-to-end, A-6 provider-health consistency, B-1 Agency Today across all clients | the deploy, signed in |
| X-6 exact deployed-build read-back | the deploy |
| B-7 / H2 guarded exact-Ad pause | deployed build + `META_GUARDED_EXECUTION_ENABLED=1` + an approved provider call |
| B-8 live policy/disapproval incident | a real disapproval from provider truth |
| C-1 broader execution breadth | Phase 11, after Gate A production evidence |
| C-2 delivered notifications | an enabled channel |
| C-5 sustained reliability + breaker | a production soak with live action classes |
| C-4 physical mobile Tier-0 | a real device |

---

## Completion ledger (master plan section 14)

One row per acceptance criterion, in the format the plan mandates.
`local_pass` and `staging_pass` are never equivalent to `production_pass`.
Reviewer is `owner (pending)` throughout: nothing here has been reviewed by a second person.

### Gate A — trust restoration

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 | Non-USD account shows one ISO currency across surfaces and report screen/share/print/CSV | `local_pass` | `metric-format`, `custom-report-renderer.currency` tests | `590ebd3bb`, `4cd8f59cc` | local | owner (pending) | Not observed on a signed-in non-USD production account |
| A-2 | Compare=None renders no delta and no directional colour | `local_pass` | `metric-semantics`, `MetricCard` tests | `590ebd3bb` | local | owner (pending) | Closed. The picker offered eight comparisons and every non-`none` choice became `previous_period`, so "Previous year" produced a previous-period delta under a year-over-year label. `previous_year` and `custom` were already implemented by `getComparisonWindow` and are now passed through; the four with no implementation are removed from the picker rather than aliased. Each surface offers only what its own route carries (`OVERVIEW_COMPARISON_PRESETS`), and four surfaces that read no comparison no longer render the control. `lib/comparison-preset-contract.test.ts` computes each preset's window and asserts they differ |
| A-3 | A cost increase never receives positive treatment | `local_pass` | `metric-semantics`, `MetricCard`, `roas-color-semantics` tests | `590ebd3bb`, J4 | local | owner (pending) | Closed. The audit found the main card was the defect: `SummaryMetricCard` coloured from the arithmetic sign, so a rising CPA, CPC or refund rate got the same emerald treatment as rising revenue. Cards now carry `trendSentiment` resolved from `getMetricDirection`, the arrow stays arithmetic, and Copies' three inline rules defer to the same helper. `lib/metric-direction-coverage.test.ts` asserts the criterion over every cost-like and value-like metric name in four spellings, plus the two defaults that matter: spend is directionless and an unclassified metric is never coloured by sign |
| A-4 | Duplicate Meta totals match or visibly explain the difference | `local_pass` | `overview-section-labels` tests | `14d771834` | local | owner (pending) | Mechanism behind Codex's live observation still unproven |
| A-5 | Mixed-currency fixtures never produce an unlabelled sum | `local_pass` | `agency-today-read-model` tests | `969d36675` | local | owner (pending) | No FX contract exists; totals withheld rather than converted |
| A-6 | Settings and Integrations show the same health at the same moment | `local_pass` | `provider-health-truth` tests | `eee0f01f3` | local | owner (pending) | Not observed live with a forced token failure |
| A-7 | Flagship report renders 7/7 widgets | `blocked_external` | in-process transport + widget failure isolation | `90838abb9` | — | owner (pending) | Root cause addressed; only a signed-in production render can confirm |
| A-8 | Share and print reproduce the on-screen window | `local_pass` | `share-period-fidelity` tests | `4cd8f59cc` | local | owner (pending) | Not confirmed against a live share link |
| A-9 | A failed widget is visible, scoped and never becomes empty data | `local_pass` | `report-widget-failure` tests | `90838abb9` | local | owner (pending) | — |
| A-10 | An idle tab revalidates or declares its age | `local_pass` | `query-client`, `data-freshness`, `tier-zero-freshness-coverage`, `tier-zero-idle-tab-revalidation`, `tier-zero-freshness` component and route tests, plus six-width rendered freshness evidence | `ec5b46ddf`, `eb94e0551`, `b153e585b`, `16fbfcbb2`, `7423f6644` | local | owner (pending) | All ten Tier-0 surfaces report through one contract, verified in a browser at six widths rather than by file inspection; revalidation proven through a real `QueryObserver` rather than by reading the config flag |
| A-11 | A failed workspace read produces error plus retry, not eternal loading or fabricated zero lanes | `local_pass` | `decision-lane-counts`, `decisions-error-recovery` tests | `ec5b46ddf`, `178cf6e89` | local | owner (pending) | — |

### Gate B — credible co-pilot

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B-1 | All assigned clients appear once, server-ranked, deep-linked | `local_pass` | `agency-today-read-model`, `agency-today/route` tests | `969d36675`, `c68fcbf27` | local | owner (pending) | Closed, and narrowed to what is true. Health reads the canonical `provider_connections` status **and** whether an account is selected: connected-with-nothing-selected is `action_required`, because nothing can produce data and a person has to fix it — finding G0-F5 reappearing on the surface whose job is deciding who to look at. Revoked, expired and error are treated alike, as Integrations treats them. Not shared: Integrations additionally applies client-side discovery-failure classification (quota class, stale-cached reads), which has no server-side equivalent; claiming full parity would be an overstatement. `app/api/agency-today/health-join.test.ts` |
| B-2 | Search finds a campaign, ad set, ad or creative by name or ID | `local_pass` | `entity-search`, `search/route`, `global-search`, `saved-views`, `saved-views-menu` tests | `4afd73bf1`, `fccd41899` | local | owner (pending) | Obsolete as written — a category error, not a gap. B-2's criterion is "Search finds a campaign, ad set, ad or creative by name or ID", which is met and tested. Saved views are slice D3c, whose own definition is "scoped, persisted, mounted on Decisions", i.e. complete as scoped. Mounting the menu on more surfaces is a D3c scope extension, not an unmet B-2 requirement, and is not carried here as an open item |
| B-3 | Permission-filtered entities never leak through search | `local_pass` | `search/route` tests; scope applied in SQL | `4afd73bf1` | local | owner (pending) | Not verified with a second tenant live |
| B-4 | Two users see consistent workflow state; stale edits conflict rather than overwrite | `local_pass` | `decision-workflow`, `decision-workflow/route`, `decision-workflow-controls` tests | `a1dec7ef5`, `178cf6e89` | local | owner (pending) | Two-operator conflict proven by contract and route; not yet observed with two live sessions |
| B-5 | Workflow changes never change engine labels or provider authority | `local_pass` | `decision-workflow` invariant test | `a1dec7ef5` | local | owner (pending) | — |
| B-6 | A direct Ads Manager edit appears as an external History row | `local_pass` | `external-change-attribution`, `history-external-changes` tests | `3f4fe5066`, `0a4c6e98e` | local | owner (pending) | Closed. Three sources were unqueried and the one that ran was gated on `daily_budget` alone — which reported nothing at all on an ABO account, where campaign budget is null in every row. The campaign gate now covers budget, lifetime budget, bid, bid strategy and optimization goal; `meta_adset_config_history` and `meta_entity_state_history` are projected, the latter reaching ad and creative status. Both require a previous row that differs, so the syncer's own cadence is not reported as operator activity. Not local: creative asset content edits (swapping an image, rewriting body text) produce a new creative id, and no local table records the previous asset — so that one provider fact needs production. `lib/meta/history-external-change-levels.test.ts` |
| B-7 | Exact single-Ad guarded pause with receipt and History row | `blocked_external` | capability resolver + preflight receipt, both proven with no provider call; resolver now conforms to D065 label/action derivation and D064 exact-Ad lineage (`guarded-action-capability` 17 tests, `guarded-action-panel`, `guarded-action-preflight`, `decision-action/preflight`) | `421ecefef`, `dd140f7ea`, `4a2c1b7e8` | local | owner (pending) | D065/D067 are now **implemented in code** on `ux/native-authority-integration`, not merely documented: origin declaration, exact-Ad lineage, the append-only attempt journal, one-POST semantics. What remains is the write itself: a deployed build with `META_GUARDED_EXECUTION_ENABLED=1` and an approved provider call |
| B-8 | Live policy/delivery incident coverage | `blocked_external` | contract carries `fix_policy`; live emission unverified | — | — | owner (pending) | Needs one live disapproval traced end to end |

### Gate C — primary agency OS

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Broader guarded execution breadth | `not_started` | — | — | — | owner (pending) | Phase 11; begins only after Gate A production evidence |
| C-2 | Delivered workflow notifications | `local_pass` for production and in-app delivery; `blocked_external` for an external channel | `notification-contract` + `notification-read-model` tests (32), ledger schema | `8c53ed23e`, `7f4a91c02` | local | owner (pending) | Producer, lifecycle and bell all ship; only an external channel is missing. The producer now runs from the maintenance cron (it existed and nothing invoked it) and its severity translation is fixed — it matched `critical`/`warning` against an anomaly vocabulary of `high`/`medium`/`low`, so every anomaly became `info`, info is skipped, and the producer could scan a business full of critical anomalies and create nothing while reporting success. The bell is mounted in both frames and cannot show a reassuring zero: no count while loading, an explicit `?` when the read failed, no badge only for a genuine zero. What needs a real channel is exactly one clause: "reaches the configured recipient through the enabled channel" |
| C-3 | Two-account, multi-currency correctness | `local_pass` | `agency-today-read-model`, `account-scope`, `account-scope-wiring` tests | `969d36675`, `af89e988e` | local | owner (pending) | Not demonstrated with two live accounts of different currencies |
| C-4 | Mobile Tier-0 | `local_pass` for the capability-gated tasks; `blocked_external` for the physical-device pass | `creative-column-priority`, `components/meta/os/mobile-tier0-triage.test.tsx`; 320 and 390 captured in the six-width matrix | `894858aee`, `1e35ad6f5`, `16fbfcbb2` | local | owner (pending) | Split into the two things it was conflating. **Local and shipped:** capability-gated triage, evidence and ownership at phone width, instrumented with `mobile_tier0_started`/`completed`, the latter fired from the transition that recorded ownership rather than from a click; captured at 320 and 390. **Not local:** section 10's *physical* device pass — touch targets, real keyboards and network conditions are not emulated. D5 keeps provider mutation (budget, bid, activation, bulk) on desktop; it does not make mobile read-only |
| C-5 | Sustained production reliability and breaker visibility | `not_started` | — | — | — | owner (pending) | Verified 2026-08-09 as having no local component. The plan's testable clause is "any `silent_failure` must visibly trip the action-class breaker; log-only discovery fails acceptance". `silent_failure` already surfaces as `danger` in the automation activity feed (not log-only), and `automation-view.tsx` declares "No per-class breaker evidence in v1" rather than implying coverage it lacks. A per-class breaker needs live action classes to trip and a soak to evidence |

### Cross-cutting

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X-1 | No regression in existing tests | `local_pass` | 0 failures against the 5,995 pre-program baseline. Pre-existing test files **were** modified where the contract they encoded changed; the earlier "no pre-existing tests changed" claim is withdrawn. Exact counts in CURRENT STATUS | branch tip | local | owner (pending) | — |
| X-2 | Schema changes build from zero and are idempotent | `local_pass` | `test:migrations-from-zero` PASS ×2 | `a1dec7ef5`, `8c53ed23e` | ephemeral Postgres | owner (pending) | Never run against real data |
| X-3 | Release candidate builds | `local_pass` | `npm run build` exit 0, 291 routes, 0 errors | branch tip | local | owner (pending) | — |
| X-4 | No user work, tenant data, receipt or snapshot lost | `local_pass` | primary tree unchanged at 219 modified / 127 untracked | — | local | owner (pending) | — |
| X-5 | Full-UI visual gate green | `local_pass` | `LC_ALL=C FULL_UI_SMOKE_ARTIFACT_SET=tier-zero-freshness npm run test:full-ui:visual` — **6 passed, exit 0** across six projects at 320/390/768/1280/1440/1728, 13 screenshot surfaces, artifacts under `docs/full-ui-redesign/playwright-smoke-artifacts/tier-zero-freshness/` including a per-width `*-freshness.json`. Beyond screenshots it asserts horizontal-scroll and tabular-clipping limits below 480px, focus visibility, positive tabindex, undescribed images, reduced motion, and the Tier-0 freshness reading read back from the DOM | `1e35ad6f5`, `b3f892ad2` | ephemeral Postgres | owner (pending) | Superseded: the earlier record of this row read "2 passed (desktop + mobile)" against artifact set `x5-visual-gate-green-2026-08-09`, which described the gate as it stood roughly 50 commits ago. The G0-F5 root cause below is retained because it is still the reason the fixture works |
| X-6 | Exact deployed build read back | `not_started` | — | — | — | owner (pending) | Requires deployment |


#### C-2 broken out by Phase 7 acceptance item

Recorded per item rather than as one blanket block, because most of Phase 7 did not need a channel.

| Phase 7 acceptance item | Status | Evidence |
| --- | --- | --- |
| A test critical event reaches the configured recipient through the enabled channel | `blocked_external` | The producer ships and runs; the in-app channel ships and delivers. What is missing is an *external* channel (email/push) and a signed-in recipient to receive it. Nothing here fakes it |
| Delivery failure is visible and retry policy is bounded | `local_pass` | `MAX_DELIVERY_ATTEMPTS`, `canRetryDelivery`, `describeDeliveryState`; an undelivered event still counts as unread rather than disappearing |
| Duplicate source events do not spam recipients | `local_pass` | `buildNotificationDedupeKey` excludes wall-clock time, so a re-run cannot re-alert; `resolveDeliveryDecision` suppresses a seen key |
| Deep link revalidates current state instead of presenting stale authority | `local_pass` | `resolveDeepLinkFreshness` presents as current only on a provably unchanged source version; unknown comparison and vanished targets both refuse |
| Daily digest totals reconcile with the server source counts | `local_pass` | `buildDailyDigest` reports `reconciled: false` and the exact discrepancy in both directions |

The bell is enabled. It was disabled for a real reason — no producer wrote notification events, so
an enabled bell would have rendered a confident `0 unread` meaning "nothing can generate these"
rather than "nothing is wrong" — and that reason is gone: the producer runs from the maintenance
cron and the whole attempted/delivered/opened/acknowledged lifecycle ships. Leaving it disabled
would now be the dishonest state, with alerts produced and delivered to nobody.

Its badge keeps the rule the rest of the console keeps, and this is where it matters most: no count
at all while the first read is in flight, an explicit `?` when the read failed, and no badge only
for a genuine zero. An operator who sees no badge concludes nothing needs them.

### Finding G0-F5 — an unassigned account is indistinguishable from an empty one

Discovered while fixing X-5, and the reason that gate looked like a fixture problem for so long.

`business_provider_accounts.is_selected` defaults to `FALSE` deliberately, so that deploying
code can never silently select an account on a business's behalf. The smoke seed inserted the
row without it. The account was therefore present but unassigned, and every account-scoped Meta
route answered:

```
403 {"error":"provider_account_not_assigned",
     "message":"The requested Meta account is not assigned to this business."}
```

On screen this rendered as a fully working Decisions surface with an empty structure list —
the same thing an account with no decisions looks like. Four rounds of fixture seeding
(warehouse dailies, authoritative publication pointers) were spent before the response was
actually read; all of it was reverted after measuring, because this business takes the demo
data path and never reads those tables.

Two defects, both fixed:

1. The seed now selects the account explicitly (`1e35ad6f5`).
2. The surface now repeats the server's reason instead of discarding it (`b3f892ad2`).
   "Decisions withheld - The requested Meta account is not assigned to this business" tells an
   operator to go and assign it. "Decision workspace unavailable" tells them to wait. A
   synthesised status line is not a reason and is not promoted into one.

The visual gate also asserted `Raw engine label`, a string that appears nowhere in the product
and never has, so it could not have passed. It now asserts the disclosure's real content and
that the version is populated rather than merely present.

### Finding G0-F4 — section 9 instrumentation has no sink to write to

> **Resolved 2026-08-09.** `lib/product-instrumentation.ts` and the
> `product_instrumentation_events` table are a first-party, tenant-scoped, retained sink with a
> bounded vocabulary enforced in CHECK constraints, an explicit 90-day retention column, no
> free-text or person-scoped field, and visible failure reporting. Agency Today and entity search
> emit to it. Retained below as the historical finding.

Section 9 requires product events (Agency Today viewed, search submitted, widget failed,
Google copy/CSV used, and so on) so the outcome metrics can be measured after release.

The only telemetry facility in the repo is `lib/operator-decision-telemetry.ts`. It is scoped
to operator decision events rather than product events, writes to stdout only when
`OPERATOR_DECISION_TELEMETRY_SINK=stdout`, and reports its own posture as:

```
sink: "stdout_staged", productionReady: false,
retention: "not_configured", alerts: "not_configured"
```

with the note "wire a retained metrics/log sink and alerts before live push rollout".

Instrumentation was therefore **not added**. Emitting events into a sink that retains nothing
would produce calls that look like measurement while measuring nothing — the same
"presented as functional when it is not" defect this program exists to remove, and it would
make section 9 appear satisfied while no outcome metric could actually be computed.

Unblocking needs an infrastructure decision first: choose a retained sink, define retention
and alerting, then instrument. Sending product events to an external analytics service is
also an outward data flow and needs its own approval.

### F2b — external changes in History: delivered

Landed in `0a4c6e98e`. Campaign configuration changes project as an `external_changes` kind
from `meta_campaign_config_history`, carrying the previous value, filtered to rows where
something actually changed, and attributed in `mapHistoryRow` via the tested correlation
rather than a second implementation in SQL.

Two notes for whoever extends it: the arm covers campaign daily budget, so ad-set and
creative-level configuration changes are still invisible; and adding a union arm to this
paginated query is genuinely delicate — this one broke three existing journal tests until the
action-log read was made conditional on a page actually containing an observed change.

### Summary

- `local_pass`: every criterion with a local component. C-4 is `local_pass` for its
  capability-gated mobile tasks — triage, evidence and ownership at phone width, instrumented and
  captured at 320/390 — and `blocked_external` only for the physical-device pass section 10
  requires.
- `blocked_external`: A-7, B-7, B-8, and C-2's external-channel clause. C-2's producer, lifecycle
  and in-app delivery are local and shipped; only "reaches the configured recipient through the
  enabled channel" needs a channel. B-7's blocker is not a missing contract — D065/D067 are
  implemented — but a deployed build with `META_GUARDED_EXECUTION_ENABLED=1` and an approved
  provider call.
- `not_started`: 3 criteria (C-1, C-5, X-6) — all downstream of deployment
- `failed`: **0 criteria.** X-5 was the last one and is now `local_pass`
- `production_pass`: **0 criteria.** No production acceptance is claimed anywhere in this program.
