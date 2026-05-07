# Creative Decision Center V2.1 Repo Audit

Generated from repo inspection and spike runs on 2026-04-30. This pass did not change runtime behavior.

## Baseline Health

| Check | Command | Result | Creative Decision Center relevance |
|---|---|---:|---|
| Package manager | `package-lock.json`, `package.json` | npm | No pnpm/yarn/bun lock present. |
| Full unit suite | `npm test` | 309 files / 2257 tests passed | Baseline green. |
| Creative focused tests | `npx vitest run lib/creative-decision-os.test.ts ...` | 9 files / 216 tests passed | Current V1/V2/operator coverage is healthy. |
| V2 safety gate | `npm run creative:v2:safety` | passed | 78 gold rows, macro F1 97.96, 0 severe/high mismatches, queue/apply all false. |
| V2.1 spike artifact guard | `npx vitest run scripts/creative-decision-center-v21-spike.test.ts` | 1 file / 3 tests passed | Verifies generated golden cases, no row-level `brief_variation`, and explicit live-read status. |
| Self-hosted smoke | `npm run creative:v2:self-hosted-smoke` | failed preflight | Missing `CREATIVE_V2_SMOKE_BASE_URL`; not a code failure. |
| Lint | n/a | no package script | Do not invent command. |
| Typecheck | n/a | no package script | Do not invent command. |

## Existing Creative Decision Coverage

Existing tests are not empty. Files found:

| Area | Files |
|---|---|
| V1 engine/source/snapshots | `lib/creative-decision-os.test.ts`, `lib/creative-decision-os-source.test.ts`, `lib/creative-decision-os-snapshots.test.ts` |
| V2 engine/preview/safety | `lib/creative-decision-os-v2.test.ts`, `lib/creative-decision-os-v2-preview.test.tsx`, `lib/creative-v2-no-write-enforcement.test.ts`, `scripts/creative-v2-safety-gate.ts` |
| Operator policy/surface | `lib/creative-operator-policy.test.ts`, `lib/creative-operator-surface.test.ts` |
| Scoring/challenger | `lib/creative-media-buyer-scoring.test.ts`, `lib/creative-old-rule-challenger.test.ts` |
| UI consumers | `components/platforms/meta/creatives/CreativeDecisionOsDrawer.test.tsx`, `components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx`, `components/platforms/meta/creatives/CreativesTopSection.test.tsx`, `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx` |
| Scripts/labs | `scripts/creative-live-firm-audit.test.ts`, `scripts/creative-segmentation-calibration-lab.test.ts`, `scripts/creative-segmentation-holdout-validation.test.ts` |

Missing coverage for V2.1:

| Gap | Why it matters |
|---|---|
| Buyer adapter tests | UI should render `buyerAction`, not infer from V1/operator labels. |
| Data readiness tests | `fix_delivery`, `fix_policy`, `watch_launch` are unsafe without proof fields. |
| Aggregate decision tests | `brief_variation` must not leak into row-level actions. |
| Read-time old snapshot adapter tests | Old V1/operator snapshots must remain renderable. |
| Before/after conflict tests | Scale vs cut conflicts need an explicit gate before rollout. |

## Decision-Source Inventory

| File | Exported types/functions | Produces | Facing | Vocabulary | Imports | Must not lose | Risk |
|---|---|---|---|---|---|---|---|
| `lib/creative-decision-os.ts` | V1 action/lifecycle/row/response types; `buildCreativeDecisionOs` | V1 snapshot, lifecycle, families, supply plan, operator policy attachment | Production-facing through snapshot route and Creative page | V1 lifecycle/action/supply-plan vocabulary | Many UI/API/services; see `01-vocabulary-mapping.md` | Family grouping, windows, benchmarks, fatigue, protected winners, supply plan, trust/provenance | High |
| `lib/creative-decision-os-v2.ts` | V2 primary decision constants, input/output types, `resolveCreativeDecisionOsV2` | V2 primary decision, safety blockers, no-write queue/apply false | Preview/test/safety, not production default | `Scale`, `Cut`, `Refresh`, `Protect`, `Test More`, `Diagnose`; `creative`, `campaign-context`, `data-quality`, `insufficient-signal` | V2 preview/evaluation/scripts/tests | Safety gate: Scale review-only, Diagnose diagnose-only, no queue/apply writes | Medium |
| `lib/creative-media-buyer-scoring.ts` | scorecard types lines 12-118, `buildCreativeMediaBuyerScorecard` line 1370 | Relative performance, maturity, trend, efficiency, winner/loser signals | Signal layer through operator policy | `scale_review`, `cut`, `refresh`, `campaign_blocked`, `benchmark_weak` | `creative-operator-policy.ts`, tests, live audit script | Evidence maturity and media-buyer reason tags | Medium |
| `lib/creative-old-rule-challenger.ts` | `CreativeOldRuleChallengerResult` lines 7-19, `buildCreativeOldRuleChallenger` line 87 | Legacy comparator decisions | Script/test-only | `scale_hard`, `scale`, `watch`, `test_more`, `pause`, `kill` | Segmentation/live audit scripts and test | Regression/challenger cases only; not user authority | Low |
| `lib/creative-operator-policy.ts` | `CREATIVE_OPERATOR_SEGMENTS` lines 23-39, `CreativeOperatorActionClass` lines 82-91, `assessCreativeOperatorPolicy` line 987 | Operator segment/state/push readiness/blockers/missing evidence | Production-facing through V1 creative rows | `scale_ready`, `scale_review`, `kill_candidate`, `needs_new_variant`, `blocked`, `monitor`, `variant`, etc. | V1 engine, scoring, tests | Required/missing evidence, blocker, review-only, queue safety semantics | High |
| `lib/creative-operator-surface.ts` | quick filters, UI primary/subtone/reason tags, `resolveCreativeOperatorDecision`, `buildCreativeOperatorItem` | User-facing labels, buckets, quick filters, operator item | Production-facing UI vocabulary | `scale`, `test_more`, `protect`, `refresh`, `cut`, `diagnose`, `review_only`, `queue_ready` | Creative page, drawer, support, top section, detail | UI bucket logic, reason-label mapping, preview truth summary | High |
| `lib/creative-decision-os-v2-preview.ts` | preview row/payload types lines 82-168, mapper line 290, surface model line 494, payload builder line 610 | V2 preview payload from V1 snapshot | Preview-only | V2 primary plus urgency/review groups | V2 preview route/component/tests | V1-to-V2 input mapper and no-write preview contract | Medium |
| `lib/creative-decision-os-snapshots.ts` | `CreativeDecisionOsSnapshotApiResponse` lines 75-82, save/get helpers | Snapshot storage/read response | Production API | V1 `decisionOs` response shape | snapshot route, V2 preview, service, drawer | Old snapshot response compatibility | High |
| `app/api/creatives/decision-os/route.ts` | `GET` line 117, `POST` line 141 | GET latest V1 snapshot; POST builds+saves V1 | Production API | V1 snapshot response | page service | Route shape must not be renamed; POST is write path | High |
| `app/api/creatives/decision-os-v2/preview/route.ts` | `GET` line 80 | Optional V2 preview from latest V1 snapshot | Preview-only | V2 preview | page service | Query-flagged preview path | Medium |
| `src/services/data-service-ai.ts` | snapshot fetch line 290, V2 preview fetch line 322 | Client fetch layer | Production client | V1 snapshot and V2 preview response types | Creative page | Additive `decisionCenter` parsing must not reject old responses | High |
| `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` | snapshot query lines 430-441, V2 preview lines 448-464, V1 extraction lines 474-478, component wiring lines 1214-1284 | Main Creative page data orchestration | Production UI | V1/operator quick filters and V2 preview | service + operator surface | UI migration must be incremental and flagged | High |
| `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx` | props lines 29-47 | V1 Decision OS drawer shell | Production UI | V1/quick filter labels | V1 types/operator filters | Can host minimal drawer later, but current drawer is V1 | Medium |
| `components/platforms/meta/creatives/CreativeDecisionOsContent.tsx` | imports V1/operator | V1 overview content | Production UI | lifecycle/family/supply plan | V1/operator quick filter | Existing V1 snapshot rendering | Medium |
| `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx` | imports V1/operator; hardcoded label helper | V1/operator overview labels | Production UI | lifecycle/action/operator labels | V1/operator | Label logic must move behind adapter | High |
| `components/platforms/meta/creatives/CreativeDecisionSupportSurface.tsx` | builds operator surface lines 86-99 | Preview truth and operator support surface | Production UI | operator buckets/preview truth | operator surface | Surface summary currently computes display meaning | High |
| `components/platforms/meta/creatives/CreativesTopSection.tsx` | filter fields lines 101-123, quick filters lines 604-664 | Quick filter UI and decision filters | Production UI | lifecycle, primaryAction, operatorSegment, pushReadiness | operator surface/V1 | Filters need backward-compatible field mapping | High |
| `components/platforms/meta/creatives/platforms/meta/creatives-top-section-support.ts` | `applyCreativeFilters` line 262, decision fields lines 351-364 | Applies V1 decision filters | Production utility | V1/operator fields | V1 type | Must read old + decisionCenter fields | High |
| `components/platforms/meta/creatives/CreativeDetailExperience.tsx` | V1 creative lookup line 301, operator item line 305, report-to-legacy decision lines 351-363 | Detail drawer decision content | Production UI | V1 report/action/lifecycle | operator surface/V1 | Best candidate for minimal V2.1 detail drawer adapter | High |
| `components/platforms/meta/creatives/CreativesTableSection.tsx` | accepts `decisionOs` | Table-level V1 decision context | Production UI | V1 decisions | Creative page | Table badge migration likely medium/high | Medium |
| `app/(dashboard)/platforms/meta/platforms/meta/creatives/page-support.tsx` | imports V1/operator, label mapper | Shared creative analysis and labels | Production utility | V1/legacy labels | V1/operator | Must avoid another hidden decision mapping layer | High |
| `lib/command-center.ts` | imports V1; priority mapping and actions | Cross-surface command opportunities | Production/service | V1 primary actions | V1 | Hidden consumer; migration can break Command Center | High |

## Hard Unknowns

| Unknown | Evidence |
|---|---|
| Live DB snapshot availability | `DATABASE_URL` is not set in shell; generated spike says no live read attempted. |
| Actual production coverage for status/policy/24h fields | Current public row contracts do not expose enough fields. |
| Whether DB tables already store effective/review status | Fetcher requests `effective_status` filter but row mapper/type do not expose it. |
| Whether old snapshots can all adapt cleanly | Need read-only snapshot sample from DB. |
