# Decision Log

## D001 — Use V2 As Base And Evolve To V2.1

Decision: use existing `creative-decision-os-v2` as the base decision engine and evolve it to V2.1.

Reason: V2 already has a concise primary decision vocabulary and safety posture.

Rejected alternative: create a new standalone decision core.

Risk: V2 may need input expansion and problem-class refinements before it can support buyer-facing actions safely.

## D002 — Keep `primaryDecision` Separate From `buyerAction`

Decision: engine root remains `primaryDecision`; buyer language is produced by an adapter.

Engine `primaryDecision`:

- `Scale`
- `Cut`
- `Refresh`
- `Protect`
- `Test More`
- `Diagnose`

Buyer action:

- `scale`
- `cut`
- `refresh`
- `protect`
- `test_more`
- `watch_launch`
- `fix_delivery`
- `fix_policy`
- `diagnose_data`

Risk: collapsing these fields would mix engine semantics, UI labels, and safety posture.

## D003 — Use Deterministic Table-Driven Buyer Adapter

Decision: use a transparent adapter from engine output to buyer-facing action.

Reason: UI needs specific action language without turning UI into a decision engine.

Constraint: adapter must not become a hidden second decision engine.

## D004 — No Row-Level `brief_variation`

Decision: `brief_variation` is aggregate/page/family-level only.

Reason: variation needs often come from family/supply gaps, not one row.

Risk: row-level variation would mislead buyers and corrupt row action semantics.

## D005 — UI Must Not Compute Decisions

Decision: UI renders `decisionCenter`.

Reason: decision authority must be testable and reproducible.

Risk: UI-side meaning drift and duplicate vocabularies.

## D006 — Old Snapshots Must Remain Renderable

Decision: old V1/operator snapshots remain renderable through read-time adapters if needed.

Reason: historical reports and existing UI consumers must not break.

Risk: additive response design is required; do not rename routes initially.

## D007 — Missing Data Means `diagnose_data` Or Capped Confidence

Decision: required data gaps must produce `diagnose_data`, disabled action, or capped confidence.

Reason: fake certainty is worse than a conservative diagnostic.

Risk: buyer trust loss if `fix_delivery`, `fix_policy`, scale, or cut are emitted without proof.

## D008 — Minimal Detail Drawer Belongs In MVP

Decision: Minimal Detail Drawer is part of MVP.

Reason: Today Brief without "why" will not earn trust.

Risk: users will ignore recommendations if the engine root and evidence are hidden.

## D009 — Config-As-Data Is Required

Decision: thresholds must live in config, not scattered resolver branches.

Reason: launch windows, maturity, fatigue, and scale/cut thresholds need account/business tuning.

Risk: hard-coded thresholds cause silent drift and hard-to-review AI edits.

## D010 — Golden Cases And Invariants Before Resolver Changes

Decision: golden cases and invariants must land before behavior changes.

Reason: AI-generated resolver drift must be controlled.

Risk: plausible but inconsistent resolver rewrites.

## D011 — Kind-Aware Baseline Selection With Strict Canonical Fallback

Decision: when a creative's source campaign is labeled Main/Test/Mixed and
the kind-specific calibration row is sufficient, `decideCreative` uses a
kind-selected profile view: account baselines, spend-unit thresholds, funnel
calibration, and hard-action eligibility are selected together. Otherwise the
decision falls back to the canonical `all` profile.

Reason: Main and Test cohorts can have materially different distributions.
Using one shared baseline blurs decision boundaries and makes Test/Main
campaign labels operationally weaker than intended.

Risk: kind-aware decisions can diverge from canonical `all` decisions for
labeled creatives. Mitigation: GC-038 through GC-042 plus strict canonical
fallback for missing, sparse, or unlabeled kind data. `DecisionOutput`
also exposes `decisionKindSource` so API/debug consumers can distinguish
kind-selected decisions from canonical fallback while `accountProfile` remains
the canonical account-wide profile.

Rejected alternative: per-gate kind selection. That would mix Main/Test
threshold logic across gate files and violate D009.

Rejected alternative: include Test-fatigue refresh-to-cut semantic switching in
the same slice. That changes operator-visible label semantics and belongs in a
separate phase.

## D012 — Test Cohort Refresh Signals Become Cut Semantics

Decision: when a resolver gate emits `refresh` for a creative whose source
campaign is explicitly labeled Test, the engine pipeline transforms that label
to `cut` before soft-only hard-action eligibility is applied. The transform is
recorded on `DecisionOutput.labelTransform` as
`test_cohort_refresh_to_cut`, and the reason receives a
`[test_cohort: refresh->cut]` prefix.

Reason: Test campaigns are experiment slots. A fatigue/refresh signal in Test
does not mean "refresh this stable winner"; it means the experiment has reached
a negative or exhausted outcome and should leave the test pool. Main and Mixed
campaigns keep the existing `refresh` semantics.

Ordering: the transform runs inside `finalizeDecision` before
`applySoftOnlyLabel`, so it sees the raw gate-emitted label before any
`hardActionEligibility` downgrade. This is required because `applySoftOnlyLabel`
already converts `refresh` to `keep` when refresh is disabled. Placing the
transform after `finalizeDecision` would miss those cases. The engine-level
`enforceHardActionEligibility` call remains an idempotent defensive duplicate.

Scope: resolver gate files remain unchanged. `gates/types.ts::finalizeDecision`
is the pipeline orchestrator and now owns this semantic transform. No new
`DecisionLabel` value is introduced, no UI computes the transform, and
`labelTransform` is an API/debug diagnostic only.

Rejected alternative: persist `labelTransform` into
`engine_v3_decision_snapshots_daily` in the same slice. Persistence was deferred
to D013 because this phase already changed behavior and should not have bundled
a schema migration/rollback concern.

## D013 — Persist Test Cohort Label Transform Diagnostics

Decision: persist `DecisionOutput.labelTransform` into
`engine_v3_decision_snapshots_daily.label_transform` as a nullable constrained
diagnostic field. The only allowed non-null value is
`test_cohort_refresh_to_cut`.

Reason: `labelTransform` explains why a Test campaign refresh signal became a
cut-style decision. Keeping it only on the live/API `DecisionOutput` loses that
audit context when daily snapshots are inspected later.

Scope: this is persistence-only. It does not add a new `DecisionLabel`, does not
change resolver math, does not change UI read paths, and must not be used by UI
code to compute `buyerAction`.

Risk: adding new transform values later requires a schema migration to widen the
constraint. That is intentional; a new semantic transform should be an explicit
decision-log event rather than an untracked string extension.

## D014 — Separate Commercial Maturity From Scale Readiness

Decision: cut and scale share the same commercial spend maturity floor, but
scale keeps separate purchase-depth and recent-hold guards. Commercial maturity
is the loss-budget threshold derived from the resolved spend unit and the risk
preset multiplier: aggressive `1.5`, balanced `2.0`, conservative `2.5`.

Reason: cut asks whether enough money has been risked to judge a loser. Scale
asks whether a winner is proven enough to replicate. A global `hardCut`
multiplier such as conservative `8.0` is too strict for cut maturity and also
incorrectly blocks scale evaluation before the scale-specific purchase and
recent-performance checks can run.

Scope: `maturityGate` now blocks only creatives below commercial spend
maturity. It no longer requires a winner-pool purchase floor. `ratioZonesGate`
uses the same commercial spend maturity for scale spend readiness, and still
requires `scaleMinPurchases` plus recent 7d ROAS holding before emitting
`scale`.

Rejected alternative: keep `hardCut` as the generic maturity gate and add
Test-only bypasses. That would mask the root issue for Main campaigns and keep
cut/scale readiness coupled to the wrong threshold.

## D015 — Gate Hard Scale By Account Winner Benchmark Readiness

Decision: `scaleMinPurchases` remains account-history based, but hard scale now
requires the account winner benchmark to be trustworthy. The first production
gate uses the existing account calibration readiness sample and requires a
positive `winnerPurchaseP50`; if either is weak or missing, the scale-zone
creative stays `keep` with near-scale blockers and scale-readiness badges.

Reason: a fixed purchase floor such as `5` would violate account-relative
calibration and penalize low-volume accounts whose real winner distribution is
lower. But falling back to `1` when the account winner benchmark is missing can
emit hard scale from noise. Scale asks whether a winner is proven enough to
replicate, so missing or thin benchmark evidence must block hard scale without
changing cut maturity.

Scope: no UI-side decision logic. The resolver emits the `keep` label, reason,
and `scale_readiness_blocked` / `scale_calibration_thin` badges. The briefing
API routes those near-scale blocks to Watching instead of Healthy so hard scale
and blocked scale candidates are visibly distinct. Raw `scale` decisions that
are downgraded by soft-only hard-action eligibility also receive
`scale_readiness_blocked`.

Future improvement: replace the current P50-only purchase benchmark with a
winner distribution that includes winner count and P25/P75 purchase depth. Until
that data is available, hard scale is allowed only when the current P50
benchmark and calibration sample are ready.

## D016 — Separate Scale Verdict From Campaign-Kind Execution Action

Decision: the engine may still emit the semantic verdict `scale`, but the
briefing API must adapt the primary UI action by campaign kind. Explicit Test
campaigns map scale to `Promote to main`; explicit Main campaigns map scale to
`Scale budget`; Mixed campaigns map scale to `Review structure & scale`; missing
campaign labels remain blocked by the campaign-label guard and must not show a
hard scale execution action.

Reason: `scale` answers "is this creative a winner?". It does not by itself
answer "where should the operator execute the next move?". In a Test campaign,
the commercially correct next action is usually moving the winner into the Main
structure. In a Main campaign, the next action is budget/volume scaling, not
another promote-to-main CTA. Mixed campaigns need structure review before an
execution instruction.

Scope: this is an API/action-adapter change, not resolver math. UI components
render the server-supplied primary action and may only use conservative fallbacks
for legacy cards. The UI fallback may map generic `scale` to promote only when
`campaignKind === "test"`.

Rejected alternative: keep mapping every `scale` to `Promote to main`. That
mislabels Main campaign winners and creates a silent path where UI copy implies a
different operational move than the engine evidence supports.

Deferred: batch/cohort-level diagnostics such as "100 test creatives all failed
to find a target/breakeven winner" require aggregate account/campaign context.
They should not be implemented as row-level creative action logic.

## D017 — Add V2.1 Contract Types And Structural Validators Without Runtime Wiring

Decision: add `creative-decision-center.v2.1` TypeScript contract types,
literal constants, structural validators, and opt-in invariant audit helpers in
an isolated `lib/creative-decision-center` module.

Reason: PR4 needs a typed contract surface before the buyer adapter,
`decisionCenter` response, and UI migration work. The contract module makes
`primaryDecision`, `buyerAction`, row decisions, aggregate decisions, snapshots,
and config shape explicit without changing the active resolver or UI path.

Scope: validators check only structure: required keys, primitive types, literal
membership, row-level `brief_variation` exclusion, snapshot required fields, and
`queueEligible` / `applyEligible` staying false. Semantic checks such as
high-confidence output with missing data live in a separate opt-in invariant
audit helper that returns violations and is not wired into runtime decisions.

Constraint: no active engine, Meta, API route, UI component, script probe, or
archive module may import `lib/creative-decision-center` in PR4. The new module
may be imported only by its own tests until a later ADR explicitly wires a
consumer.

Rejected alternative: unarchive the old V2.1 module wholesale. That would bring
adapter, snapshot builder, observability, and historical assumptions back into
scope instead of adding only the PR4 contract surface.

Risk: if later slices turn validators into runtime gates without ADR review,
structural checks could become hidden policy. Mitigation: keep semantic audits
separate and require a later decision-log entry before any runtime consumer uses
them for enforcement.

## D018 — Centralize Low-Risk Engine Config Values Without Behavioral Drift

Decision: move the already-named low-risk Creative Decision Engine thresholds,
window sizes, default business config values, and preset multipliers into
`lib/creative-decision-engine/config-values.ts` while preserving all existing
public exports and values.

Reason: PR5 needs a config-as-data surface before later adapter and response
work can reason about thresholds consistently. The first slice intentionally
centralizes only values that already have stable names or documented defaults,
so it improves auditability without changing resolver math, fallback order,
gate eligibility, confidence behavior, labels, or buyer-facing output.

Scope: `config.ts`, `engine-presets.ts`, data freshness thresholds, zero
conversion age floor, kind-aware calibration floor, campaign-label confidence
cap, operator-response lookback, and calibration sample window now read from
the central config module. Compatibility exports remain in their previous
modules, and tests freeze both the exact literal values and the old public
surface.

Intentionally left in place for later, separately reviewed slices:
`fatigue.ts` decay/concentration/frequency/fallback thresholds,
`gates/ratio-zones.ts` ratio-zone/fallback thresholds, resolver inline
confidence adjustments, lifecycle SQL literals, and any value whose move would
touch active gate ordering or decision semantics.

Constraint: PR5 does not authorize value changes, inline literal extraction
from high-risk resolver/gate code, buyer adapter implementation, route/UI
wiring, or any default `decisionCenter` response. Any future threshold change
or semantic regrouping still requires explicit review and approval.

Rejected alternative: move every inline number in the resolver and gates in one
pass. That would make behavior drift hard to isolate and would mix mechanical
config cleanup with policy changes.

Risk: a mechanical import move could accidentally alter a fallback value or
public export. Mitigation: keep old modules as compatibility re-export
surfaces, add lockstep tests for all moved values, and keep this as a separate
rollback commit.

## D019 — Add `executionAction` Vocabulary For Campaign-Kind Execution CTA

Decision: keep `CreativeDecisionCenterBuyerAction` stable at the existing nine
values and add an optional, nullable `executionAction` field on row decisions
and on `BuyerActionMappingRule.output`. The execution-action union is the
minimal vocabulary required to satisfy D016 and golden cases GC-054, GC-055,
GC-056: `"promote_to_main" | "scale_budget" | "controlled_scale"`.

Reason: D016 already separates the scale verdict from the campaign-kind
execution move. Treating the execution CTA as a separate, optional field
preserves the disjoint `primaryDecision` and `buyerAction` unions from D002,
keeps the `actionBoard` keyed only by `buyerAction`, and lets a labeled
Test/Main/Mixed scale row carry the correct operator-facing move without
forcing UI code to compute it.

Scope: contract-only surface in `lib/creative-decision-center/contracts.ts` and
`docs/creative-decision-center/CONTRACTS.md`. PR4 isolation rules still apply:
no active engine, Meta, API route, UI component, script probe, or archive
module may import the contract module in this slice. `executionAction` is
strictly opt-in for rules and rows; absent or `null` means no execution move
is asserted. UI must not derive `executionAction` from raw signals; the
deterministic adapter is the only authorized producer (in a later slice).

Constraint: `actionBoard` stays keyed only by `buyerAction`. UI bucketing must
not switch to `executionAction`. Validators check `executionAction` only when
present and only as a literal-union/nullable membership test; no
cross-field semantic policy lives in the validator.

Rejected alternatives:
- Expand `CreativeDecisionCenterBuyerAction` with `promote_to_main`,
  `scale_budget`, `controlled_scale`. That would silently change the
  `actionBoard` shape, break PR4 contract symmetry between row buyerAction and
  uiBucket, and force every downstream consumer to handle five extra values.
- Relabel GC-054/055/056 expectations to a single `scale` buyerAction. That
  would erase the D016 test surface for campaign-kind execution moves.

Risk: a later slice could try to make `executionAction` mandatory or
re-key the `actionBoard` from it. Mitigation: keep this ADR as the bound,
keep `executionAction` optional and nullable, and add validator and contract
tests that assert it never replaces `buyerAction` for row bucketing.

## D020 — Carry Non-V2.1 Engine Labels As `sourceDecision` Metadata, Not As New `primaryDecision` Values

Decision: keep `CreativeDecisionOsV21PrimaryDecision` stable at the existing
six values (`Scale`, `Cut`, `Refresh`, `Protect`, `Test More`, `Diagnose`).
Upstream engine labels that do not map cleanly to those six (today V3
`keep`, `same_as_canonical`, and any future engine-only label) are surfaced as
an optional, free-form `sourceDecision` audit string on
`CreativeDecisionCenterRowDecision`. The deterministic adapter is responsible
for mapping the engine output to one of the six V2.1 primary decisions and
recording the upstream label in `sourceDecision`.

Reason: GOLDEN_CASES.md references engine-side labels such as `Keep` and
`Same as canonical` that are not user-facing V2.1 primary decisions. Adding
them to `CreativeDecisionOsV21PrimaryDecision` would expand the buyer-facing
contract by accident and would conflict with D002. A separate opaque audit
field preserves the upstream label for the drawer/debug surface without
changing the primary-decision union or the buyer-facing UI vocabulary.

Scope: contract-only addition of `sourceDecision?: string | null` on
`CreativeDecisionCenterRowDecision`. The field is free-form because the upstream
engine label set evolves independently of the V2.1 contract. The adapter is
the only authorized writer; UI must not parse `sourceDecision` to compute
`buyerAction`, `primaryDecision`, or any operator-facing label.

Constraint: do not add `Keep`, `Same as canonical`, `Out Of Scope`, or any
other label to `CreativeDecisionOsV21PrimaryDecision` without a separate
decision-log entry that documents explicit user approval. Validators must
treat `sourceDecision` as optional, nullable, free-form string only.

Rejected alternative: extend the V2.1 `primaryDecision` union with `Keep`
and `Same as canonical`. That would change the buyer-facing primary contract,
require updating every downstream consumer (drawer copy, snapshot consumers,
adapter table), and would silently re-introduce a V3 engine concept into a
V2.1 buyer surface without a documented mapping.

Risk: the free-form string could drift into a hidden second union. Mitigation:
the adapter is the only allowed writer, validators reject anything but a
nullable string, and tests assert no UI/route consumer reads `sourceDecision`
to compute decisions.

## D021 — Flagged `decisionCenter` Briefing Response Shape With No Live Row Adaptation

Decision: extend `GET /api/creatives/briefing` with an additive,
opt-in-only `decisionCenter` field on the JSON response. The field is
populated by the structural snapshot builder
(`lib/creative-decision-center/snapshot-builder.ts`) and shipped with
empty `rowDecisions`, empty `aggregateDecisions`, empty `todayBrief`,
and the fully empty `actionBoard` the builder produces. The field is
attached only when the request carries `?decisionCenter=1`,
`?decisionCenter=true`, or the snake-case `?decision_center=...`
equivalent. The default response shape is unchanged.

Reason: PR_SEQUENCE PR7 acceptance asks for an additive `decisionCenter`
response that preserves the legacy briefing response and old snapshot
rendering. Mapping active V3 `DecisionOutput` rows into V2.1 row
decisions would be policy/runtime behavior and is explicitly out of
scope for PR7A. Shipping the contract surface behind a flag lets
adapter/shadow tooling stand the response up without touching the
active engine output and without committing to a live mapping.

Scope: route-level additive field, type-level extension of
`CreativesBriefingResponse`, and a module-isolation allowlist for the
exact route, route-test, and response-type files. No UI component
consumes `decisionCenter`. The snapshot validator and invariant audit
must both pass; if either fails, the field is set to `null` rather than
silently shipping a malformed snapshot. The disabled-engine path also
honors the flag and emits a snapshot stamped with
`engineVersion: "disabled"`; the field is omitted on the disabled path
by default to avoid implying live decisions.

Constraint: PR7A must not map active engine decisions into row
decisions, must not let the UI render `decisionCenter`, must not rename
the briefing route, and must not change the legacy response shape when
the flag is absent. Module isolation still forbids `lib/meta`,
`lib/creative-decision-engine`, `scripts/creative-decision-center`, and
any non-allowlisted file under `app/` or `components/` from importing
`@/lib/creative-decision-center`.

Rejected alternatives:
- Always emit `decisionCenter` on every response. That would change the
  default response shape and force consumers to decide what to do with
  empty rows, which is policy by another name.
- Adapt live V3 `DecisionOutput` rows into `rowDecisions`. That is the
  buyer-adapter wiring described in D003/D019 and requires explicit
  user approval before it can ship even in shadow mode on a real route.
- Wire the response into an existing component flag (for example a
  drawer). UI consumption is deferred to a later PR_SEQUENCE slice
  behind its own ADR.

Risk: future PRs could wire the UI directly off `decisionCenter` and
collapse the legacy lanes into it without a separate decision. Mitigation:
the route test enforces that the field is absent by default, the
module-isolation test allowlist enumerates the only files allowed to
import `@/lib/creative-decision-center`, and the response interface
documents that the UI must not consume the field.

## D022 — Map V3 Decisions Into V2.1 Through A Conservative Bridge

Decision: add a separate V3-to-V2.1 bridge before any live row adaptation.
The bridge maps a V3 `DecisionOutput` plus explicit route context into a
discriminated bridge result: either a mapped V2.1 engine output plus the exact
adapter input, or an intentional `omit` result with an explicit omit reason.
The existing deterministic buyer adapter remains unchanged and continues to
accept only already-produced V2.1 engine output.

Reason: V3 and V2.1 do not share a one-to-one vocabulary. V3 emits
`scale`, `keep`, `refresh`, `cut`, `test_more`, `diagnose`, and
`out_of_scope`, while the V2.1 buyer surface has six primary decisions and a
separate nine-value buyer-action vocabulary. Changing the adapter input would
turn the adapter into a hidden second decision engine and would break the
PR6B separation between engine-root output and buyer-language mapping. A
dedicated bridge keeps the current V3 engine stable, keeps the V2.1 contract
stable, and makes future V4/V3 replacement a single-point change.

Scope: bridge-only policy documented in `V3_TO_V21_MAPPING.md` and enforced
by tests in a later implementation slice. The bridge version is
`CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION =
"creative-decision-center.v3-bridge.v1"`. The bridge may import V3 types from
`@/lib/creative-decision-engine/types` as type-only metadata but must not
runtime-import the active engine, call `decideCreative`, call resolver gates,
call Meta API functions, call route code, call UI code, access DB clients, read
`process.env`, fetch, or run scripts. It does not change resolver math,
confidence formulas, gate ordering, labels emitted by V3, or default UI
behavior.

Conservative mapping:

- V3 `scale` maps to V2.1 `Scale` with `problemClass: performance` and
  `actionability: review_only`; the existing adapter owns Test/Main/Mixed
  execution CTA resolution.
- V3 `cut` maps to V2.1 `Cut` with `problemClass: performance` and
  `actionability: review_only`.
- V3 `refresh` maps to V2.1 `Refresh`; fatigue badges map it to
  `problemClass: fatigue`, otherwise the bridge uses `problemClass: creative`.
- V3 `test_more` maps to V2.1 `Test More` with
  `problemClass: insufficient_signal`.
- V3 `diagnose` maps to V2.1 `Diagnose` with `actionability: diagnose`;
  badge context chooses `data_quality`, `campaign_context`, or `performance`.
- V3 `keep` is not a buyer-facing V2.1 primary decision. It is mapped only
  when the V3 output carries an explicit review-worthy signal such as blocked
  scale readiness, thin scale calibration, weak performance, low CTR, or
  unlabeled campaign context. Plain no-op `keep` rows are intentionally omitted
  from `rowDecisions` so Healthy/no-action creatives do not become fake tasks.
- V3 `out_of_scope` is intentionally omitted from `rowDecisions`; the legacy
  lanes and source metadata can still represent it if needed.

Safety constraints: the bridge must not emit `fix_delivery`, `fix_policy`,
or high-confidence launch/fatigue outputs without the proof fields listed in
`DATA_READINESS.md`. Missing or degraded data must add `missingData` and cap
the row confidence band through the existing adapter/invariant path. All
bridge-generated engines keep `queueEligible: false` and `applyEligible: false`.
Campaign-label gaps are campaign context problems, not generic data-quality
problems: `unlabeled_campaign_context` and missing campaign label map to
`problemClass: campaign_context`.

Audit constraint: the bridge must preserve V3 label-transform audit context in
D012/D013. Adapter `sourceDecision` is derived as `decision.labelTransform`
when present, otherwise `v3:<decision.label>`. This metadata is passed to the
adapter; it is not embedded in the V2.1 engine output and must not be used by
UI code to compute `buyerAction`.

Bridge v1 maturity constraint: the first bridge may use only the conservative
metrics-based maturity heuristic documented in `V3_TO_V21_MAPPING.md`. D014
commercial-maturity integration requires widening bridge input and is deferred
to a separate ADR.

Testing constraint: PR7B implementation must update module-isolation tests so
`v3-bridge.ts` can type-import V3 output types while runtime engine imports
remain forbidden, and must document known PR7B-beta golden-case coverage gaps
instead of asserting future `fix_delivery`, `fix_policy`, or `watch_launch`
behavior before the proof fields exist.

Rejected alternatives:

- Change the existing adapter to accept raw V3 `DecisionOutput`. That would
  collapse D003 and D020 boundaries, mix source-engine labels with buyer
  mapping policy, and make adapter tests depend on active engine types.
- Add `Keep`, `Out Of Scope`, `review`, or `same_as_canonical` to V2.1
  primary or buyer-action unions. That would expand the buyer-facing contract
  without proving UI and snapshot compatibility.
- Emit every V3 `keep` as a V2.1 row. That would flood the Action Board with
  non-actions and make Healthy/no-op creatives look actionable.
- Add a new top-level `bridgeVersion` field to `DecisionCenterSnapshot` in
  PR7B-beta. The bridge exposes its own version constant; route wiring may
  compose that into `adapterVersion` while the snapshot contract remains V2.1.

Risk: omitting plain `keep` rows means a drawer opened from a legacy Healthy
row may not always find a V2.1 row decision during the shadow phase. Mitigation:
UI slices must keep legacy fallback rendering until V2.1 is default and must
show `sourceDecision` only as audit metadata, never as a decision input.
