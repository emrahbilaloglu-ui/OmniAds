# Media-Buyer UX Remediation — Delivery Ledger

Authority: `docs/full-ui-redesign/ADSECUTE_MEDIA_BUYER_UX_IMPLEMENTATION_MASTER_PLAN_2026-08-08.md`

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
| C2b | per-surface freshness disclosure | C2 | `local_pass` (`eb94e0551`) | additive chip |
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
| Full test suite | `npx vitest run` | 672 files / **6,236 tests pass** (baseline 5,995) — *as of that round; current is 6,846, see CURRENT STATUS* |
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
git diff --name-only origin/main HEAD | wc -l     # 378  candidate total
git diff --shortstat origin/main HEAD             # 378 files, +55,002 / -4,236
```

Those three historical figures are facts and are preserved. The candidate has since grown from
244 to 378 files: the typography floor touched every stylesheet and component carrying sub-11px
text, which is a wide but shallow change. The earlier claim
that "~60 files" were selected from the native branch is **withdrawn**: it was an
estimate presented as a count and was never measured. The candidate's 378 files
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

## CURRENT STATUS (authoritative, 2026-08-09)

Everything above this line is historical record. This section is the current truth; where the two
disagree, this section wins.

**Candidate:** the tip of `ux/native-authority-integration`, cut from `origin/main` @ `0bcf1fbf5`.
The exact tip SHA is stated in the deploy approval request, since a commit cannot record its own
hash.
**Scope vs `origin/main`:** 378 files changed, +55,002 / −4,236 (90 commits).

### D066 — decision-fact ownership (complete)

`meta_ad_daily` now has exactly one owner. `upsertMetaAdDailyRows` requires
`writeMode: "authoritative_fact"`; omitted, null, unknown and the retired `creative_enrichment`
lane all fail closed *before* the empty-rows shortcut, so a refusal is never a partial mutation.
Creative enrichment no longer writes decision facts — it was writing full economic evidence from
the creatives endpoint — and keeps its three dedicated writers (creative daily, creative
dimensions, media presentation). The authoritative payload is sanitized: creative-media, preview
and media-debug keys are removed recursively from `payload_json` while economic evidence is
retained.

| Evidence | Result |
| --- | --- |
| `lib/meta/ad-daily-write-ownership.test.ts` | 10 invariants |
| `scripts/ephemeral-postgres-ad-daily-ownership-seam-child.ts` | real-Postgres seam PASS (D066 requires a seam, not a mocked SQL-shape test) |
| `lib/meta/creatives-warehouse.test.ts` | now asserts `not.toHaveBeenCalled()` on the retired writer |

No ADR was needed: D066 prescribes this resolution verbatim ("owned only by authoritative insights
sync", "performs zero `meta_ad_daily` writes"). The decision was implemented, not amended.

### D069 / D065 / D067 — route-level write seam (complete)

`scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts` builds a real authenticated
session (a `sessions` row and its cookie) plus a genuinely connected, selected integration, then
calls the **shipped route handler** `app/api/meta/ads/[adId]/pause/route.ts`.

The previous seam called `pauseAd()` and then appended journal events itself. That proved the
provider client behaves and that the append functions accept input — it proved nothing about
whether the shipped route produces durable lineage, which is the actual D069 claim. It was
**deleted**, not adapted.

Everything asserted below is written by production code; the seam only seeds fixtures, replaces
`globalThis.fetch`, and reads the database back.

| Proven | How |
| --- | --- |
| Claim + lineage created by production | exactly one action claim carrying the exact account, Ad and creative; `attempt_started` and a terminal completion present, with exact ad/creative/campaign/adset/account |
| One POST maximum | one POST for one authorized pause, naming the exact Ad and carrying the authorized credential |
| No automatic retry on ambiguity | transport ambiguity yields exactly one POST; the persisted receipt records `attemptCount: 1`, `automaticRetryAttempted: false`; never reported as success |
| Zero POST, fail-closed | deselection, revoked connection generation, identity/permission mismatch (a real session for a user with no membership), and kill switch |
| Append-only lineage | the journal refuses `UPDATE` and `DELETE` at the database |

Reaching this meant satisfying the real contract rather than routing around it: explicit
`actionOrigin` (D065 forbids inferring it), explicit operator confirmation, and the server-presented
`adId` echoed in the body because the path parameter alone is not authority.

### Instrumentation posture (G0-F4 partially resolved)

First-party retained sink: `product_instrumentation_events`, scoped either to one business or to
the portfolio, and **never** to `businesses[0]` — the scope/tenancy pairing is enforced by a
database CHECK, so attributing cross-tenant work to one tenant is impossible at the storage layer.
No user id, email, session id, or free-text column. `surface` is a closed allowlist; the catch never
reads `error.message`. Writes are awaited and bounded (750ms) rather than detached. Retention runs
from the same cron as the other maintenance jobs and is proven idempotent.
`product_instrumentation_sink_health` makes a failing sink operator-visible rather than a console
line.

**Partially** resolved: five events have real emitters. See the open local gaps below for the rest.

### Mobile truth (partial, unchanged)

C-4 remains `local_pass` **for its read model only**. Section 10 of the plan requires a *physical*
mobile Tier-0 pass; an emulated 390px viewport is not a device. Tier-0 writes stay desktop-gated
per D5.

### Local gates (recomputed on the final SHA)

| Gate | Exact command | Result |
| --- | --- | --- |
| Full suite | `LC_ALL=C npx vitest run` | **6,865 pass**, 0 fail, 61 skipped, 63 todo (698 files) |
| Focused D061–D069 | `npx vitest run lib/launchpad/meta-manual-authority.test.ts lib/meta/decision-origin-action-preflight.test.ts lib/meta/ads-action-log.test.ts lib/creative-decision-engine/__tests__/execution-safety.test.ts lib/creative-decision-engine/__tests__/golden-cases.test.ts lib/meta/ad-daily-write-ownership.test.ts` | **235 pass**, 43 todo (6 files) |
| Instrumentation | `npx vitest run lib/product-instrumentation.test.ts lib/product-instrumentation-emitters.test.ts` | 28 pass |
| Typography floor | `npx vitest run lib/typography-floor.test.ts` | 3 pass |
| Typecheck / lint | `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| Production build | `npm run build` | clean |
| Migrations from zero | `LC_ALL=C npm run test:migrations-from-zero` | PASS, idempotent, including all three seams |
| Desktop + mobile smoke | `LC_ALL=C FULL_UI_SMOKE_ARTIFACT_SET=native-integration-2026-08-09 npm run test:full-ui:visual` | 2/2 across 9 surfaces, with no-clipping and computed-typography assertions |

An earlier revision of this section reported "160" and "247" for the focused suite in different
places. Both are withdrawn; the single command above and its count of **235** are the record.

**Test-file impact, measured.** `git diff --name-status origin/main HEAD -- '*.test.ts' '*.test.tsx'`
reports **49 added** and **32 modified**. The earlier claim that *no pre-existing test was changed*
is **false and withdrawn**: 32 pre-existing test files were modified. They were changed because the
contracts they encoded changed — D065's guards, D066's single-owner rule, the D063 constraint
vocabulary — and each change is described in the commit that made it. That is a legitimate reason to
edit a test, but it is not "no pre-existing tests changed", and the distinction matters.

**Environment note.** The ephemeral-Postgres suites need `LC_ALL` set on macOS. Without it PG16
fails with `postmaster became multithreaded during startup`, which reads as a code failure and is
not one.

### Remaining work, classified honestly

Two categories. Conflating them was a real defect in earlier revisions of this ledger.

**Closed 2026-08-09 (was listed here as open):**

- **Mobile composition.** The creative table stacks into task-priority cards below 767px; the
  committed 390px artifact now shows identity, spend, purchases, revenue, CPA, ROAS and the full
  "Assessment unavailable" chip with no clipping and no horizontal scroll.
- **Typography floor.** 105 CSS rules, 530 Tailwind arbitrary sizes and 112 inline `fontSize`
  values below 11px raised to 12px; `small` floored. Enforced by `lib/typography-floor.test.ts` and
  by a computed-size assertion in the smoke, which caught 9–10px text the stylesheet scan missed.
- **Clipping is now a gate.** The smoke asserts no page-level horizontal scroll *and* that no
  scroller containing tabular content hides any of it. The second check is the one that matters: the
  page-level check passed while the row still clipped, because the frame scrolled internally.

**Locally reachable and NOT yet done** — these are open local gaps, not production gates:

| Gap | What remains |
| --- | --- |
| Section-9 instrumentation coverage | 5 of section 9's minimum events have emitters. Client-row open, search-result open, saved-view create/apply, evidence viewed, the report generate/fail/retry/share/print/CSV family, Google copy/CSV/deep-link, health recovery, notification delivery lifecycle, guarded dry-run and mobile Tier-0 have no server emission point on this candidate. The vocabulary deliberately excludes them rather than declaring dead names |
| Accessibility verification | Keyboard/focus/accessible-name/status, 200% zoom, reduced motion and long-text/localisation are not systematically verified on the changed surfaces |
| Visual evidence breadth | Smoke now captures 9 surfaces (login, Decisions, Studio, Copies, Inbox, Launchpad, Automation, Reports, Settings) at the configured 390/768/1280/1440/1728 projects. Overview/Agency Today, the Decisions inspector and Integrations health are still not captured |
| Freshness adoption, Agency Today health join, History projection completeness | Previously noted in this ledger and still open locally |

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
| A-2 | Compare=None renders no delta and no directional colour | `local_pass` | `metric-semantics`, `MetricCard` tests | `590ebd3bb` | local | owner (pending) | Picker still collapses 8 presets to previous_period server-side |
| A-3 | A cost increase never receives positive treatment | `local_pass` | `metric-semantics`, `MetricCard`, `roas-color-semantics` tests | `590ebd3bb`, J4 | local | owner (pending) | Applied to Overview + Google card; other surfaces unaudited |
| A-4 | Duplicate Meta totals match or visibly explain the difference | `local_pass` | `overview-section-labels` tests | `14d771834` | local | owner (pending) | Mechanism behind Codex's live observation still unproven |
| A-5 | Mixed-currency fixtures never produce an unlabelled sum | `local_pass` | `agency-today-read-model` tests | `969d36675` | local | owner (pending) | No FX contract exists; totals withheld rather than converted |
| A-6 | Settings and Integrations show the same health at the same moment | `local_pass` | `provider-health-truth` tests | `eee0f01f3` | local | owner (pending) | Not observed live with a forced token failure |
| A-7 | Flagship report renders 7/7 widgets | `blocked_external` | in-process transport + widget failure isolation | `90838abb9` | — | owner (pending) | Root cause addressed; only a signed-in production render can confirm |
| A-8 | Share and print reproduce the on-screen window | `local_pass` | `share-period-fidelity` tests | `4cd8f59cc` | local | owner (pending) | Not confirmed against a live share link |
| A-9 | A failed widget is visible, scoped and never becomes empty data | `local_pass` | `report-widget-failure` tests | `90838abb9` | local | owner (pending) | — |
| A-10 | An idle tab revalidates or declares its age | `local_pass` | `query-client`, `data-freshness` tests | `ec5b46ddf`, `eb94e0551` | local | owner (pending) | Chip mounted on Overview; Decisions had its own; other surfaces still to adopt it |
| A-11 | A failed workspace read produces error plus retry, not eternal loading or fabricated zero lanes | `local_pass` | `decision-lane-counts`, `decisions-error-recovery` tests | `ec5b46ddf`, `178cf6e89` | local | owner (pending) | — |

### Gate B — credible co-pilot

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B-1 | All assigned clients appear once, server-ranked, deep-linked | `local_pass` | `agency-today-read-model`, `agency-today/route` tests | `969d36675`, `c68fcbf27` | local | owner (pending) | Health beyond freshness not yet joined into the row |
| B-2 | Search finds a campaign, ad set, ad or creative by name or ID | `local_pass` | `entity-search`, `search/route`, `global-search`, `saved-views`, `saved-views-menu` tests | `4afd73bf1`, `fccd41899` | local | owner (pending) | Saved views mounted on Decisions; other surfaces can adopt the same menu |
| B-3 | Permission-filtered entities never leak through search | `local_pass` | `search/route` tests; scope applied in SQL | `4afd73bf1` | local | owner (pending) | Not verified with a second tenant live |
| B-4 | Two users see consistent workflow state; stale edits conflict rather than overwrite | `local_pass` | `decision-workflow`, `decision-workflow/route`, `decision-workflow-controls` tests | `a1dec7ef5`, `178cf6e89` | local | owner (pending) | Two-operator conflict proven by contract and route; not yet observed with two live sessions |
| B-5 | Workflow changes never change engine labels or provider authority | `local_pass` | `decision-workflow` invariant test | `a1dec7ef5` | local | owner (pending) | — |
| B-6 | A direct Ads Manager edit appears as an external History row | `local_pass` | `external-change-attribution`, `history-external-changes` tests | `3f4fe5066`, `0a4c6e98e` | local | owner (pending) | Covers campaign budget changes; ad-set and creative-level config not yet projected |
| B-7 | Exact single-Ad guarded pause with receipt and History row | `blocked_external` | capability resolver + preflight receipt, both proven with no provider call; resolver now conforms to D065 label/action derivation and D064 exact-Ad lineage (`guarded-action-capability` 17 tests, `guarded-action-panel`, `guarded-action-preflight`, `decision-action/preflight`) | `421ecefef`, `dd140f7ea`, `4a2c1b7e8` | local | owner (pending) | D065/D067 are now **implemented in code** on `ux/native-authority-integration`, not merely documented: origin declaration, exact-Ad lineage, the append-only attempt journal, one-POST semantics. What remains is the write itself: a deployed build with `META_GUARDED_EXECUTION_ENABLED=1` and an approved provider call |
| B-8 | Live policy/delivery incident coverage | `blocked_external` | contract carries `fix_policy`; live emission unverified | — | — | owner (pending) | Needs one live disapproval traced end to end |

### Gate C — primary agency OS

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Broader guarded execution breadth | `not_started` | — | — | — | owner (pending) | Phase 11; begins only after Gate A production evidence |
| C-2 | Delivered workflow notifications | `blocked_external` | `notification-contract` + `notification-read-model` tests (32), ledger schema | `8c53ed23e`, `7f4a91c02` | local | owner (pending) | 4 of the 5 Phase 7 acceptance items are now locally proven (see below); only "reaches the configured recipient through the enabled channel" needs a channel |
| C-3 | Two-account, multi-currency correctness | `local_pass` | `agency-today-read-model`, `account-scope`, `account-scope-wiring` tests | `969d36675`, `af89e988e` | local | owner (pending) | Not demonstrated with two live accounts of different currencies |
| C-4 | Mobile Tier-0 | `local_pass` (read model only) | `creative-column-priority` tests; emulated mobile viewport green in the full-UI visual gate | `894858aee`, `1e35ad6f5` | local | owner (pending) | **Partial by the plan's own terms.** Section 10 lists a *physical* mobile Tier-0 pass among the gates local or staging results cannot satisfy, and an emulated 390px viewport is not a device. KPI visibility only; Tier-0 writes remain desktop-gated per D5 |
| C-5 | Sustained production reliability and breaker visibility | `not_started` | — | — | — | owner (pending) | Verified 2026-08-09 as having no local component. The plan's testable clause is "any `silent_failure` must visibly trip the action-class breaker; log-only discovery fails acceptance". `silent_failure` already surfaces as `danger` in the automation activity feed (not log-only), and `automation-view.tsx` declares "No per-class breaker evidence in v1" rather than implying coverage it lacks. A per-class breaker needs live action classes to trip and a soak to evidence |

### Cross-cutting

| ID | Criterion | Status | Evidence artifact | Build/commit | Environment | Reviewer | Remaining caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X-1 | No regression in existing tests | `local_pass` | current: **6,846 pass**, 0 fail, vs the 5,995 pre-program baseline; every addition new, no pre-existing test changed | branch tip | local | owner (pending) | — |
| X-2 | Schema changes build from zero and are idempotent | `local_pass` | `test:migrations-from-zero` PASS ×2 | `a1dec7ef5`, `8c53ed23e` | ephemeral Postgres | owner (pending) | Never run against real data |
| X-3 | Release candidate builds | `local_pass` | `npm run build` exit 0, 291 routes, 0 errors | branch tip | local | owner (pending) | — |
| X-4 | No user work, tenant data, receipt or snapshot lost | `local_pass` | primary tree unchanged at 219 modified / 127 untracked | — | local | owner (pending) | — |
| X-5 | Full-UI visual gate green | `local_pass` | `npm run test:full-ui:visual` — 2 passed (desktop + mobile); screenshots under `playwright-smoke-artifacts/x5-visual-gate-green-2026-08-09/` show 5 campaigns and a populated `Recommendation version` | `1e35ad6f5`, `b3f892ad2` | ephemeral Postgres | owner (pending) | Root cause was not the fixture: the seeded account was never selected, so every account-scoped route answered 403. See G0-F5 |
| X-6 | Exact deployed build read back | `not_started` | — | — | — | owner (pending) | Requires deployment |


#### C-2 broken out by Phase 7 acceptance item

Recorded per item rather than as one blanket block, because most of Phase 7 did not need a channel.

| Phase 7 acceptance item | Status | Evidence |
| --- | --- | --- |
| A test critical event reaches the configured recipient through the enabled channel | `blocked_external` | Needs a channel and a producer. Nothing here fakes it |
| Delivery failure is visible and retry policy is bounded | `local_pass` | `MAX_DELIVERY_ATTEMPTS`, `canRetryDelivery`, `describeDeliveryState`; an undelivered event still counts as unread rather than disappearing |
| Duplicate source events do not spam recipients | `local_pass` | `buildNotificationDedupeKey` excludes wall-clock time, so a re-run cannot re-alert; `resolveDeliveryDecision` suppresses a seen key |
| Deep link revalidates current state instead of presenting stale authority | `local_pass` | `resolveDeepLinkFreshness` presents as current only on a provably unchanged source version; unknown comparison and vanished targets both refuse |
| Daily digest totals reconcile with the server source counts | `local_pass` | `buildDailyDigest` reports `reconciled: false` and the exact discrepancy in both directions |

The bell remains disabled deliberately. No producer writes notification events, so an enabled bell
would render a confident `0 unread` that means "nothing can generate these" rather than "nothing is
wrong". The plan gates the bell on state and delivery truth existing; the state contract now exists,
the producer and channel do not.

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

- `local_pass`: 23 criteria of 30 as of the X-5 round. **Superseded by CURRENT STATUS above**, which
  supersedes this count: the ten remaining gates are all production-only and enumerated there.
  C-4 is `local_pass` for its read model only — the plan requires a physical-device pass it cannot claim.
- `blocked_external`: 4 criteria (A-7, B-7, B-8, C-2) — **see CURRENT STATUS for the current reasons**;
  B-7's blocker is no longer a missing contract
- `not_started`: 3 criteria (C-1, C-5, X-6) — all downstream of deployment
- `failed`: **0 criteria.** X-5 was the last one and is now `local_pass`
- `production_pass`: **0 criteria.** No production acceptance is claimed anywhere in this program.
