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

Any later regression is measured against exactly these numbers.

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
| A1 | shared metric/currency/comparison contracts | G0 | `in_progress` | additive adapters |
| A2 | Overview/Commercial Truth trust semantics | A1 | `not_started` | surface adapters |
| B1 | report snapshot: currency and period fidelity | A1 | `not_started` | snapshot version |
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
