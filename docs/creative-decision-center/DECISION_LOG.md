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

## D023 — Wire Bridged V3 Rows Into The Flagged Briefing Response Only

Decision: when `GET /api/creatives/briefing` receives the explicit
`?decisionCenter=1` / `?decisionCenter=true` / `?decision_center=...` flag,
the route maps the already-produced, campaign-label-guarded V3
`DecisionOutput` rows through the PR7B V3 bridge, the existing deterministic
buyer adapter, and the snapshot builder. The default briefing response remains
unchanged when the flag is absent.

Reason: PR7A proved the additive response shape with an empty snapshot. PR7B
proved the isolated V3-to-V2.1 bridge without runtime consumers. PR7C connects
those two pieces in shadow mode so the contract can be inspected through the
real route while keeping legacy lanes, drawer consumers, and the active engine
as the buyer-facing default.

Scope: route-only wiring in `app/api/creatives/briefing/route.ts` and matching
route tests. The route uses existing `DecisionOutput` values after
`decideCreative(...)` and `applyCreativeCampaignLabelGuard(...)`; it does not
change gate ordering, thresholds, confidence formulas, label transforms,
campaign-label guard behavior, or lane classification. Plain no-op V3 `keep`
and `out_of_scope` decisions remain omitted by the bridge. Mapped rows keep
`queueEligible: false` and `applyEligible: false` through the V2.1 engine
contract. The disabled-engine path still emits an empty snapshot only when the
flag is explicitly requested.

Adapter versioning: when the enabled route attempts the bridged shadow path,
the snapshot `adapterVersion` composes the bridge and adapter constants as
`creative-decision-center.v3-bridge.v1+creative-decision-center.shadow-adapter.v1`.
This applies even if all V3 decisions are omitted and `rowDecisions` is empty,
so operators can distinguish "bridge ran and omitted all rows" from the
disabled/legacy empty snapshot. The snapshot contract does not gain a new
top-level `bridgeVersion`.

Validation: the route still validates the assembled snapshot with
`validateDecisionCenterSnapshot(...)` and
`auditDecisionCenterSnapshotInvariants(...)`; validation failure returns
`decisionCenter: null` instead of a malformed shadow payload.

Constraint: no UI component consumes `decisionCenter` in this slice. UI code
must not parse `sourceDecision`, compute `buyerAction`, compute
`executionAction`, or infer action-board buckets. Any default response change,
UI consumption, route rename, non-shadow action queueing, or Meta write path
requires a separate decision-log entry and user approval.

Rejected alternatives:

- Emit bridged rows by default. That would change the default response shape and
  make the V2.1 surface buyer-visible before fallback behavior is reviewed.
- Recompute V2.1 rows from raw Meta/warehouse signals in the route. That would
  create a second decision engine outside the tested V3 resolver and bridge.
- Expand `DecisionCenterSnapshot` with `bridgeVersion` during route wiring.
  Version composition inside `adapterVersion` is enough for the shadow payload
  and avoids a contract migration.

Risk: a flagged snapshot may have fewer rows than the legacy briefing lanes
because the bridge intentionally omits plain `keep` and `out_of_scope` rows.
Mitigation: PR9 UI consumption must retain legacy fallback rendering until the
V2.1 surface is deliberately made default.

## D024 — Keep Aggregate Decisions As A Deny-By-Default Structural Gate

Decision: `lib/creative-decision-center/aggregate-builder.ts` is a structural
gate for already-proposed page/family aggregate candidates. It does not
discover candidates, derive family winners, compute fatigue clusters, rank
rows, or inspect active engine metrics. The current briefing route passes an
empty candidate list, so the flagged `decisionCenter.aggregateDecisions` field
remains `[]` until a later ADR adds an explicit candidate source.

Reason: PR12 needs the aggregate contract surface and guardrails without
activating family/supply decisions whose required data is not ready. A
deny-by-default gate lets the route and tests prove that aggregate actions
stay disabled when family/supply evidence is missing while preserving the
future page/family shape.

Required data mapping:

| aggregate action | code-level required data keys | DATA_READINESS source row |
| --- | --- | --- |
| `brief_variation` | `family_winner_fatigue`, `backup_variant_status`, `creative_supply_backlog` | family winner/fatigue, no backup, backlog/supply |
| `creative_supply_warning` | `creative_supply_backlog`, `recent_launches`, `production_state` | creative supply/backlog/winner gap |
| `winner_gap` | `last_winner_date`, `historical_snapshot_window` | last winner date |
| `fatigue_cluster` | `fatigue_trend_window`, `cluster_definition`, `performance_trend` | top N fatigue proof |
| `unused_approved_creatives` | `creative_review_status`, `delivery_proof`, `lifetime_delivery` | approved status + no delivery |

Scope: the builder imports only contract types, emits only
`CreativeDecisionCenterAggregateDecision[]`, strips any row-only fields by
constructing output objects field-by-field, and suppresses a candidate when
required data is missing, candidate `missingData` is non-empty, or a
family-scoped candidate lacks `familyId`. It never writes row decisions,
`buyerAction`, `uiBucket`, `creativeId`, queue/apply metadata, or Meta actions.

Constraint: `brief_variation` remains aggregate-only. Future candidate
providers such as family analyzers, supply trackers, approved-creative
delivery trackers, or historical winner-gap calculators require a separate
ADR and explicit tests before the route may pass non-empty candidates.

Rejected alternative: hardcode `aggregateDecisions: []` in the route forever.
That would keep PR12 safe but would not document the gate policy or protect a
future implementation from silently activating aggregate actions without
family/supply readiness proof.

Risk: a later slice could wire a candidate source without proving the
DATA_READINESS fields. Mitigation: module-isolation tests cover the builder,
route tests lock empty default aggregate output, and builder tests suppress
all aggregate actions unless their required data keys are explicitly present.

## D025 — Keep Decision Center Observability As Env-Gated Shadow Telemetry

Decision: PR13 adds passive, env-gated observability for the flagged
`decisionCenter` snapshot path. The event builder is a pure function in
`lib/creative-decision-center/observability.ts`; it receives an already-built
snapshot plus pre-hashed identifiers and returns deterministic structured
events. The briefing route emits those events only when both conditions are
true: the request explicitly asks for `decisionCenter`, and
`DECISION_CENTER_OBSERVABILITY` is truthy (`1`, `true`, or `enabled`).

Reason: PR_SEQUENCE PR13 requires rollout monitoring without changing the
snapshot contract, active resolver decisions, UI, queue/apply paths, or Meta
writes. Env-gated `console.info` events provide a small rollback surface for
shadow rollout: unset the env flag and telemetry stops without changing route
behavior.

Scope:

- Builder input is pre-hashed only: `businessIdHash`, `accountIdHashes`, and
  `snapshotId`. The builder never receives raw business IDs, account IDs,
  creative IDs, row IDs, family IDs, names, copy, URLs, tokens, or customer
  data.
- Route hashing happens before calling the builder. The route logs a fixed
  handler identifier (`GET /api/creatives/briefing`) and never logs request URL
  or query string.
- Each event carries
  `creative-decision-center.observability.v1` for schema versioning.
- Event payloads include snapshot counts, row distribution, aggregate
  distribution, missing-data counts, fallback counts, high-confidence action
  counts, high-priority low-confidence counts, and
  `primary_to_buyer_divergence` rollout-watch counts.
- Telemetry failure is caught and must never alter the briefing response.

Salt sourcing: production should set
`DECISION_CENTER_OBSERVABILITY_SALT`. When the salt is absent, hashes use the
local default `creative-decision-center.observability.v1.local-default` and
are visibly prefixed with `unsalted:`. This keeps tests and local dev
deterministic while making missing production salt obvious in logs.

Naming constraint: PR_SEQUENCE mentions conflict metrics, but the event is
named `decision_center.primary_to_buyer_divergence`, not
`decision_center.mapping_conflict`. The divergence name is intentional because
`primaryDecision` and `buyerAction` are separate concepts by design. A
Scale-to-`diagnose_data` row caused by missing campaign labeling is a bridge
safety fallback, not necessarily an engine conflict or bug.

Rejected alternatives:

- Emit observability by default whenever the route is called. That would add a
  production side effect to the default path and make rollback harder.
- Put hashing inside the builder. That would make the isolated Decision Center
  package know about raw tenant/account identifiers and weaken the PII
  boundary.
- Log request URLs. Query strings can contain raw `businessId` and other
  identifiers, so the route field must remain a fixed handler name.
- Use the word `conflict` for primary-to-buyer divergence. That would imply
  `primaryDecision` and `buyerAction` are supposed to match, contradicting
  D002/D019.

Risk: console transport is only a scaffold, not a production metrics backend.
Mitigation: events are structured JSON behind a stable log marker and version.
A later production-readiness PR can swap transport to a metrics sink without
changing the pure event builder contract.

## D026 — Keep Legacy V1/V2/Operator Systems Archived And Import-Blocked Until Replacement Is Stable

Decision: PR14 adds static guardrails only. Legacy V1/V2/operator source stays
archived under `lib/archive/v1-v2-v21`, and active runtime code must not import
old legacy modules or archived modules.

Reason: the migration still needs old snapshot/render compatibility while the
V2.1 Decision Center path becomes stable. Keeping legacy code archived preserves
rollback/reference material, while import blocking prevents accidental
reactivation of legacy UI/API modules during later slices.

Scope: static test plus this ADR only. No active engine algorithm, resolver,
gate ordering, confidence math, UI behavior, route name, queue/apply path, Meta
write path, response default, or snapshot shape changes.

Import scan policy: the guard scans active `app`, `components`, `src`, and `lib`
TypeScript import/export specifiers, including `lib/release-authority` files.
It intentionally keys off import/export specifiers rather than raw substring
matches, so release inventory path metadata and V2.1 contract-version literals
remain valid documentation without becoming false positives.

Constraint: deleting, unarchiving, or serving the legacy systems requires a
separate migration plan and ADR. Old V1/operator/V2 snapshots must stay
renderable until the replacement surface is default, proven stable, and
explicitly approved.

Rejected alternatives:

- Delete the archived legacy files now. That would violate the old-snapshot
  compatibility boundary and remove rollback evidence before V2.1 is default.
- Leave the archive available without active import guardrails. That would let
  future slices accidentally reintroduce legacy runtime paths through aliases
  or relative imports.
- Exclude active release-inventory files from the scan. That would hide a real
  future import regression in an active runtime-adjacent inventory module.

Risk: guardrails can become stale if the archive is intentionally migrated
again. Mitigation: the test is static and rollback is narrow: update or remove
the PR14 guardrail test together with the migration ADR.

## D027 — Make Decision Center The Production-Default Creative Surface

Decision: the Meta Creatives briefing response includes the additive
`decisionCenter` snapshot by default, and the Creative page renders the
server-supplied Decision Center Today Brief, Action Board, drawer evidence, and
asset-library labels by default when a valid snapshot is present.

Scope: surface/default behavior only. This does not change resolver math, gate
ordering, thresholds, confidence bands, hard-action eligibility, queue/apply
eligibility, Meta write behavior, route names, or snapshot contract semantics.
The inclusion gate controls whether an already computed `decisionCenter`
snapshot is serialized into the response; it is not a decision-engine or
resolver gate.

Reason: PR7 through PR10 established the additive API shape and read-only UI
consumption behind an explicit flag. The next production step is to remove the
URL flag requirement so the page defaults to the buyer-facing answer:
"what should I do, why, and with how much confidence?" Keeping the change at
the surface layer preserves the active decision algorithm boundary.

Rollback controls:

- `?decisionCenter=0`, `?decisionCenter=false`, `?decisionCenter=off`, or
  `?decisionCenter=no` disables the response field and UI surface for a request.
- The snake-case `decision_center` parameter supports the same values.
- `DECISION_CENTER_DEFAULT_DISABLED=1`, `true`, or `enabled` disables default
  inclusion at runtime unless the request explicitly asks for
  `?decisionCenter=1` or `?decisionCenter=true`.

Compatibility: legacy briefing fields remain present and old consumers can keep
reading `actionNow`, `watching`, `healthy`, `pulse`, and `source`. UI components
must continue to fail closed when `decisionCenter` is null or malformed, and
must not compute `buyerAction` from legacy labels.

Observability: D025 remains intentionally explicit. Making the surface default
does not automatically expand production telemetry volume. Decision Center
observability continues to require both a truthy `DECISION_CENTER_OBSERVABILITY`
environment value and an explicit truthy request parameter. A future change to
emit observability for all default traffic requires a separate approval/ADR.

Rejected alternatives:

- Change resolver gates or buyer-action mapping while making the surface
  default. That would mix an adoption rollout with algorithm behavior change.
- Remove the legacy response fields at the same time. That would violate old
  snapshot/consumer compatibility and remove rollback paths too early.
- Emit observability on every default response immediately. That would create a
  production logging-volume change outside the approved surface rollout.

Risk: malformed or missing snapshots are now on the default path. Mitigation:
the route keeps structural validation and null fallback, the UI helpers render
empty read-only states for malformed data, and request/env opt-outs provide a
narrow rollback without reverting resolver code.
