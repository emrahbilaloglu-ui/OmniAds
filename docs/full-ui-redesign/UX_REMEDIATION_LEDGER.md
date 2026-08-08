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

### Finding G0-F3 — the Decisions as-of date resolver queries a column that does not exist

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

**Status: `blocked_external` — needs an owner decision, not a unilateral fix.**
Correcting the predicate changes which as-of date the Decisions surface resolves, which is a
semantics change in a decision read path. The plan requires resolver semantics changes to
carry executable golden/invariant coverage plus a `DECISION_LOG.md` entry, and D13
(date-range replay leak) governs exactly this area. The fix is also entangled with G0-F1:
the D061–D069 decisions and the native-ad snapshot tables this query reaches for live on the
unmerged branch. Recommended resolution order: land the native-authority work on main
(G0-F1), then fix this predicate under a new ADR with golden coverage.

Until then the smoke cannot pass, and no slice may claim it as a gate.

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
   reaches main. It may not be satisfied by re-implementing a lighter UI-only write path — the plan
   forbids exactly that. Unblocking requires an owner decision to merge/rebase that feature.
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
| J1 | Decisions typography and contrast floor | A1 | `local_pass` (`46d992883`) | surface-scoped CSS |
| S-SMOKE | fix pre-existing full-UI smoke failure (G0-F2/G0-F3) | G0-F1 + ADR | `blocked_external` | test-only |
| B2 | report in-process builders and widget recovery | B1 | `not_started` | builder-by-builder |
| C1 | unified provider health | G0 | `not_started` | additive read model |
| C2 | freshness/revalidation/error states | C1 | `not_started` | runtime policy flag |
| D1–D3 | Agency Today, search, saved views | A1,C1 | `not_started` | Client Overview fallback |
| E1–E2 | Google scope guards, copy/CSV/deep links | A1 | `not_started` | read-only, independent disable |
| F1–F2 | workflow overlay, external changes, History | D1 | `not_started` | additive/append-only |
| G1–G2 | notification ledger and delivery | F1,C1 | `not_started` | per-channel disable |
| H1 | Decision capability/preflight UI | C2,F2 | `not_started` | no provider execute |
| H2 | exact single-Ad pause execution | H1 + D065/D067 | `blocked_external` (G0-F1) | action-class disable |
| I1 | auth/query/self-fetch performance | C2 | `not_started` | refactor-only |
| J1–J2 | tokens/type/contrast, responsive/mobile Tier-0 | A1 / H2,J1 | `not_started` | surface-scoped |
| L | release soak and final acceptance | all | `not_started` | exact build rollback |

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

Suite growth is exactly the tests added at each step; no baseline test changed behavior.
All four rows are `local_pass` only. **No production acceptance is claimed** — that
requires deployment, which is an explicit approval gate this program has not reached.
