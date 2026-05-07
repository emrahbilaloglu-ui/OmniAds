# Creative Decision OS Snapshot Review

Date: 2026-04-25  
Reviewer: Claude Sonnet 4.6  
Branch reviewed: `main` (merged commit `7be5f28`)  
Scope: Focused review — snapshot correctness, date-range invariance, manual CTA, UI trust

---

## 1. Executive Verdict

**PASS WITH SMALL FIXES**

All five behavioral requirements are correctly implemented: no auto-run on page load, no date-range-triggered recompute, manual CTA only, snapshot persisted to DB, UI shows last-analyzed timestamp and scope. One dead export alias carries a naming risk but has no callers. One subtle mutation closure has a benign scope-change race that is not a safety concern.

---

## 2. What Was Reviewed

| File | Purpose |
|---|---|
| [docs/operator-policy/creative-segmentation-recovery/STATE.md](docs/operator-policy/creative-segmentation-recovery/STATE.md) | Root context and fix summary |
| [docs/operator-policy/creative-segmentation-recovery/reports/decision-os-snapshots/final.md](docs/operator-policy/creative-segmentation-recovery/reports/decision-os-snapshots/final.md) | Codex implementation report |
| [app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx](app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx) | Page query key, mutation, CTA, status UI |
| [app/api/creatives/decision-os/route.ts](app/api/creatives/decision-os/route.ts) | GET/POST route handlers |
| [lib/creative-decision-os-snapshots.ts](lib/creative-decision-os-snapshots.ts) | Snapshot store, identity, DB read/write |
| [components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx](components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx) | Drawer — not-run state, CTA, header |
| [components/platforms/meta/creatives/CreativeDecisionOsContent.tsx](components/platforms/meta/creatives/CreativeDecisionOsContent.tsx) | Drawer content panels |
| [components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx](components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx) | Inline overview panels (unused at this call site) |
| [components/platforms/meta/creatives/CreativesTopSection.tsx](components/platforms/meta/creatives/CreativesTopSection.tsx) | Filter bar, date range picker |
| [src/services/data-service-ai.ts](src/services/data-service-ai.ts) | Client-side fetch wrappers |
| [app/api/creatives/decision-os/route.test.ts](app/api/creatives/decision-os/route.test.ts) | API route tests |
| [app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx](app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx) | Page snapshot contract tests |
| [lib/creative-decision-os-snapshots.test.ts](lib/creative-decision-os-snapshots.test.ts) | Snapshot store unit tests |

---

## 3. Auto-Run Behavior

**PASS**

`creativeDecisionOsSnapshotQuery` calls `getCreativeDecisionOsSnapshot` (GET). The GET route handler (`route.ts:117`) calls `getLatestCreativeDecisionOsSnapshot` which queries the DB and returns whatever exists — it never calls `getCreativeDecisionOsForRange`. There is no `useEffect` that triggers analysis. The mutation `creativeDecisionOsRunMutation` is the only POST path; it is only called from `handleRunCreativeAnalysis`.

Test coverage in `page.test.tsx:237` confirms `mutateRunAnalysis` is not called on initial render and the only observed query keys are `meta-creatives-creatives-metadata` and `creative-decision-os-snapshot` (never the old `creative-decision-os` key).

---

## 4. Date-Range Recompute Behavior

**PASS**

The React Query key for the snapshot query is (`page.tsx:416-424`):
```
["creative-decision-os-snapshot", businessId, activeBenchmarkScope.scope, activeBenchmarkScope.scopeId ?? null]
```
`drStart` and `drEnd` are absent. Changing the date range does not invalidate this key, does not refetch, and does not call the POST endpoint.

The test at `page.test.tsx:252-265` explicitly changes `mockDateRange` from `last14Days` to `last30Days` and asserts:
- The snapshot query key is identical to the pre-change key.
- The metadata query key does include the new date (`2026-03-16`), confirming reporting tables update while the snapshot does not.

When the reporting range diverges from the snapshot's saved context, `decisionSnapshotReportingRangeDiffers` triggers an amber notice (`page.tsx:984-988`):
> "Reporting range changed. This Decision OS snapshot remains unchanged until you run analysis again."

The snapshot and `creativeDecisionOs` references are not touched.

---

## 5. Manual CTA Behavior

**PASS**

A "Run Creative Analysis" button with a Sparkles icon is rendered at `page.tsx:951-963`. It:
- Calls `handleRunCreativeAnalysis` on click.
- Is disabled while `creativeDecisionOsRunMutation.isPending` or `!canLoadCreatives`.
- Shows "Running analysis" + `animate-spin` while pending.

`handleRunCreativeAnalysis` calls `creativeDecisionOsRunMutation.mutate()` with no arguments; the mutation function captures `drStart`, `drEnd`, and `activeBenchmarkScope` from the closure at render time. The mutation's `onSuccess` handler calls `queryClient.setQueryData(creativeDecisionOsSnapshotQueryKey, payload)` to immediately update the snapshot cache without a refetch.

The drawer also exposes a "Run Analysis" button that calls the same `onRunAnalysis` prop (`CreativeDecisionOsDrawer.tsx:176`).

Test at `route.test.ts:546` confirms POST computes and saves; `page.test.tsx:249-251` confirms clicking does not auto-fire on render.

---

## 6. Snapshot Persistence

**PASS**

`POST /api/creatives/decision-os`:
1. Calls `getCreativeDecisionOsForRange` to compute the payload.
2. Calls `saveCreativeDecisionOsSnapshot` which inserts a new row into `creative_decision_os_snapshots` with status `'ready'`.
3. Returns `buildCreativeDecisionOsSnapshotResponse({ scope, snapshot, status: "ready" })`.

On failure the route returns a 500 without saving any row, so no failed run is recorded as a successful analysis.

The snapshot includes:
- `snapshotId` (UUID)
- `businessId`
- `scope`: analysisScope, analysisScopeId, benchmarkScope, benchmarkScopeId (identity fields)
- `generatedAt` (ISO datetime, used for display)
- `decisionAsOf` (operator decision date)
- `sourceWindow`: reportingStartDate, reportingEndDate, analyticsStartDate, analyticsEndDate, decisionWindowStartDate, decisionWindowEndDate (context only, not identity)
- `payload` (full `CreativeDecisionOsV1Response`)
- `inputHash`, `evidenceHash`

Reporting dates are stored as context only and are not part of the lookup query (`lib/creative-decision-os-snapshots.ts:299-306`). The DB query uses `business_id`, `surface`, `analysis_scope`, `analysis_scope_id`, `benchmark_scope`, `benchmark_scope_id` as identity fields.

Test at `snapshots.test.ts:105` confirms reporting dates are stored in `sourceWindow` but do not appear in scope identity. Test at `route.test.ts:482` confirms GET loads snapshot without calling the Decision OS engine.

---

## 7. Last Analyzed / Scope UI Clarity

**PASS**

The status badge (`page.tsx:456-462`) resolves to:
- `"Decision OS: Running"` — mutation pending
- `"Last analyzed: 2026-04-10 14:32 UTC"` — ready snapshot
- `"Decision OS snapshot loading"` — initial query loading
- `"Decision OS has not been run for this scope."` — no matching snapshot

The status card (`page.tsx:975-991`) renders:
```
{decisionSnapshotStatusLabel}
Analysis scope: {analysisScopeLabel} · Benchmark: {benchmarkScopeLabel} · Decision as of {date}
[amber notice when reporting range differs]
[rose error line when run failed]
```

The drawer header (`CreativeDecisionOsDrawer.tsx:165-171`) shows:
```
{decisionAsOf} · {primary30d.startDate} – {primary30d.endDate} · {totalCreatives} creatives
```
or when no decisionOs but snapshot exists:
```
Last analyzed {timestamp} UTC
```
or when no snapshot:
```
Run analysis to generate a snapshot
```

The not-run section (`CreativeDecisionOsDrawer.tsx:222-246`) explicitly says:
> "Reporting range changes do not recompute Creative Decision OS. Run analysis to create or refresh the saved operator snapshot."

A media buyer has four separate surfaces that communicate the snapshot model.

---

## 8. Remaining Risks

### R1 — Mutation closure / scope-change race

If the user changes `benchmarkScopeMode` while `creativeDecisionOsRunMutation` is pending:
- The mutation continues with the benchmark scope captured at click time.
- The `onSuccess` handler calls `queryClient.setQueryData(creativeDecisionOsSnapshotQueryKey, payload)` where `creativeDecisionOsSnapshotQueryKey` is captured in the outer closure at the time `useMutation` was defined.

In practice this means: if scope changes during a run, `onSuccess` writes to the key for the scope that was active at button-click time, not the scope currently displayed. This is not a safety risk (it does not trigger an unreviewed action) but could confuse the UI state momentarily — the new scope's query would refetch from GET and show the correct result, but the old scope key would be written with a new snapshot.

Severity: low UX edge case, not a safety concern.

### R2 — Dead export alias `getCreativeDecisionOs`

`src/services/data-service-ai.ts:345`:
```ts
export const getCreativeDecisionOs = runCreativeDecisionOsAnalysis;
```
No callers in the codebase. The name implies a read operation but aliases a POST that computes and persists. A future contributor finding this alias could accidentally trigger a live run instead of loading the snapshot.

Severity: low currently (no callers), moderate if misread in the future.

### R3 — Analysis scope always equals benchmark scope

`resolveCreativeDecisionOsSnapshotScope` sets `analysisScope === benchmarkScope` in all cases. The snapshot schema has separate `analysisScope` and `benchmarkScope` fields, but they are always assigned from the same `benchmarkScope` input. If these two concepts need to diverge (e.g. account-wide analysis but campaign-only benchmark), the identity function will need updating. Low risk for the current feature set.

### R4 — Test coverage gap: existing snapshot survives date-range change

The page test verifies that the snapshot query key does not change when the date range changes. It does not render a scenario where an existing `ready` snapshot is loaded and then the date range changes, confirming that the displayed snapshot content is unchanged. This is a minor coverage gap and not a correctness risk given the query key evidence.

---

## 9. Required Fixes

### Fix 1 — Remove or rename the dead alias (recommended, not blocking)

**File:** [src/services/data-service-ai.ts](src/services/data-service-ai.ts) line 345  
**Action:** Delete `export const getCreativeDecisionOs = runCreativeDecisionOsAnalysis;` or rename to `computeAndSaveCreativeDecisionOs` if the alias is needed for anything not yet imported.  
**Why:** Misleading name, no callers, naming risk for future contributors.

No other required fixes. R1 and R3 are noted for awareness; neither affects current correctness.

---

## 10. Another Codex Pass Needed

**No.**

The snapshot pass is correct and complete. Fix 1 is a cleanup item that can be done in a routine pass or left as low-priority technical debt. It does not affect snapshot behavior, UI correctness, or operator safety.

---

## Final Chat Summary

- **Verdict:** PASS WITH SMALL FIXES
- **Auto-run still present:** no
- **Date-range recompute still present:** no
- **Snapshot persistence works:** yes
- **UI clarity acceptable:** yes
- **Another Codex pass needed:** no
- **Exact first fix if needed:** delete `export const getCreativeDecisionOs = runCreativeDecisionOsAnalysis` at `src/services/data-service-ai.ts:345`
