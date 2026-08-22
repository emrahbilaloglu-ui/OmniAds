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

| aggregate action            | code-level required data keys                                               | DATA_READINESS source row                        |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `brief_variation`           | `family_winner_fatigue`, `backup_variant_status`, `creative_supply_backlog` | family winner/fatigue, no backup, backlog/supply |
| `creative_supply_warning`   | `creative_supply_backlog`, `recent_launches`, `production_state`            | creative supply/backlog/winner gap               |
| `winner_gap`                | `last_winner_date`, `historical_snapshot_window`                            | last winner date                                 |
| `fatigue_cluster`           | `fatigue_trend_window`, `cluster_definition`, `performance_trend`           | top N fatigue proof                              |
| `unused_approved_creatives` | `creative_review_status`, `delivery_proof`, `lifetime_delivery`             | approved status + no delivery                    |

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

## D028 — Add Measurement Infrastructure Before Any Creative Auto-Execution

Decision: Creative automation readiness may consume persisted realized-outcome
summaries, but the runtime remains `read_only` until empirical thresholds,
preflight, rollback, post-action monitoring, and explicit operator enablement
all pass. This slice adds the outcome table/job surface and wires aggregate
Decision Center candidates from persisted history without enabling mutations.

Reason: a 10/10 decision system needs measured hard-action precision, recall,
calibration error, critical false-positive rate, missed-opportunity rate,
snapshot coverage, and data freshness. Code-level safety checks alone cannot
prove these metrics. Persisted outcomes must join a decision snapshot to T+7
and T+14 realized Meta creative metrics before automation-readiness claims can
be credible.

Scope:

- Add `engine_v3_decision_outcomes_daily` as a read-only measurement table
  derived from persisted decision snapshots and later Meta creative metrics.
- Add a read-only outcomes job that classifies historical decisions into
  positive, negative, neutral, or unknown outcome rows.
- Let briefing cards pass a business-level backtest summary into the existing
  automation-readiness gate when outcome rows exist.
- Wire page-level aggregate candidates only from explicit persisted-history
  evidence. Missing or stale history suppresses the aggregate rather than
  inventing a recommendation.

Constraints:

- No Meta write endpoint is called.
- `creativeAutomationReadiness` keeps `tier: "read_only"` and
  `autoExecuteEligible: false`.
- Aggregate decisions remain page/family-level. They must not attach to a
  random row or emit row-level `brief_variation`.
- Missing or stale persisted history must suppress aggregates and automation
  evidence rather than produce high-confidence output.

Rejected alternatives:

- Use the current screen rows alone to infer winner gaps. That lacks historical
  cadence evidence and would create false supply alarms.
- Treat the new outcome classifier as proof of automation readiness on day one.
  It only becomes evidence after the decision snapshots, outcome rows, and
  realized Meta metrics have enough coverage and sample size.
- Open an executor path in the same slice. Measurement and execution are
  separate safety boundaries.

Risk: early outcome classifications are heuristic until enough historical
rows accumulate and are manually reviewed. Mitigation: the job stores the
classifier version and evidence JSON per row, the automation gate still blocks
without threshold-passing summaries, and the table is append/upsert measurement
infrastructure, not an execution trigger.

## D029 — Proof-Gate Delivery, Policy, And Launch Buyer Actions

Decision: the active V3 resolver may expose `fix_delivery`, `fix_policy`, and
`watch_launch` through the existing Decision Center bridge only when explicit
proof fields are present on the server-produced `CreativeInput`.

Scope:

- Add read-only input fields for first seen/spend basis, latest daily
  spend/impressions, and policy/review reason strings when the warehouse
  exposes them.
- Emit a verified no-delivery diagnostic only when an ACTIVE creative has both
  latest-window spend and impressions present, equal to zero, and sourced from
  a fresh warehouse row.
- Emit a policy diagnostic only when effective status, review status, or
  policy/disapproval/limited reason text proves a policy/review block.
- Treat stale insight data as a confidence-cap and missing-evidence signal.
  Verified no-delivery still requires a fresh latest-window proof floor. Explicit
  policy/review proof remains visible when present, but stale evidence prevents
  high-confidence or auto-applicable handling.
- Match review status through explicit blocked enum values rather than broad
  substring matching. Free-form reason fields remain proof only when populated
  by the warehouse as policy/disapproval/limited reasons.
  Normalization uppercases and converts spaces/dashes to underscores before
  matching `REJECTED`, `DISAPPROVED`, `DISAPPROVED_OR_LIMITED`, or `LIMITED`.
  Current live warehouse inspection found no populated
  `review_status`/`ad_review_status`/`approval_status` values, and found
  `WITH_ISSUES` only as an `effective_status`; `WITH_ISSUES` and
  `PENDING_BILLING_INFO` are therefore deliberately not treated as strict
  policy blocks unless a separate reason field proves the block.
- Add launch-monitoring metadata to below-maturity `test_more` decisions only
  when first-spend or first-seen basis exists and the creative is inside the
  configured launch window.

Constraints:

- UI continues to render server-supplied fields and must not compute
  `buyerAction`.
- The bridge still maps deterministic V3 badges to V2.1 buyer actions; it does
  not inspect raw performance rows or become a second resolver.
- If proof fields are absent, old safe fallbacks remain: low-delivery warnings
  stay `diagnose_data`, policy stays unasserted, and launch rows remain
  `test_more`.

Rejected alternatives:

- Map the old `delivery_limited` badge to `fix_delivery`. That badge only
  proves recent 7d spend absence and would overstate delivery causality.
- Infer policy blocks from weak performance. Policy requires explicit status or
  reason proof.
- Use age alone for `watch_launch`. Launch monitoring requires an explicit
  first-spend or first-seen basis so it is auditable.

## D030 — Wire Unused-Approved Aggregate Behind Proof Gates

Decision: the briefing route may emit the existing
`unused_approved_creatives` page-level aggregate from `meta_creative_daily`
only when both explicit review/approval status proof and zero lifetime
delivery proof are present for the candidate creatives.

Scope:

- Use the existing aggregate builder; do not add row-level `brief_variation` or
  a second decision core.
- Treat explicit review/approval status as the status proof source for this
  aggregate. Active effective status alone is not sufficient.
- Suppress the candidate if policy or review reason text is populated.
- Require the latest status proof row to be inside the configured
  unused-approved lookback window so old zero-delivery rows do not create a
  stale backlog recommendation.
- Require lifetime spend and impressions to be zero before describing a
  creative as unused; the delivery sum remains lifetime within the warehouse,
  not just the lookback window.
- Pass `creative_review_status`, `delivery_proof`, and `lifetime_delivery` as
  available aggregate data only when every emitted candidate has the required
  proof. Otherwise the deny-by-default aggregate builder suppresses it.
- Cap affected creative ids through central config so the aggregate is auditable
  without serializing an unbounded backlog.

Constraints:

- This aggregate is recommendation evidence only; it does not create, edit,
  launch, pause, or publish anything.
- Missing enrichment must suppress the aggregate instead of producing a
  high-confidence supply recommendation.
- Aggregate query errors are logged and must not break row-level briefing
  decisions.

Rejected alternatives:

- Infer unused-approved backlog from zero spend alone. That would confuse
  paused, rejected, inactive, or unlaunched rows with approved assets.
- Infer approval from active effective status alone. That would overstate the
  warehouse's current proof coverage while review-status fields are sparse.
- Attach the recommendation to an arbitrary creative row. This remains
  page-level aggregate context.

## D031 — Separate Decision Math Score From Measurement And Automation Readiness

Decision: Creative briefing responses may expose a read-only measurement
reconciliation object and card-level explainability/priority metadata, but these
fields do not change the engine label and the UI must render them without
computing `buyerAction`.

Reason: decision-math quality, UI explainability, UI visibility, measurement
readiness, and automation readiness are distinct concerns. Treating missing
outcome windows, stale measurement rows, or operator labels as pure decision
math failures makes the score misleading. The route now publishes enough
server-side evidence to audit live UI counts against persisted snapshots and to
explain why a card is prioritized.

Scope:

- `measurementReconciliation` is read-only and may compare briefing lane counts,
  `decisionCenter` row counts, latest snapshot rows, outcome availability, and
  input completeness.
- `priorityScore` is a server-produced actionability ordering hint based on
  spend at risk or above-target opportunity, confidence, severity, and action
  type. UI sorting may consume it; UI must not derive labels or buyer actions
  from it.
- `explainability` surfaces target, ratio-to-target, threshold provenance,
  calibration, blocker traces, and empirical metrics when available.
- Automation remains read-only until empirical outcome, executor, preflight,
  rollback, holdout, operator enablement, and post-action monitoring evidence
  are all present.

Rejected alternative: keep the score model as a single number that mixes
decision math, UI visibility, missing outcomes, and automation architecture.
That hides whether the algorithm is wrong or the proof substrate is simply not
ready yet.

## D032 — Treat Stale Source Evidence As A Confidence Cap, Not A Terminal Stop-Loss Blocker

Decision: source-row freshness older than the configured stale threshold is no
longer a terminal `Diagnose` when the row already satisfies severe stop-loss
math. The resolver adds a `stale_evidence` badge, caps confidence, and lets
zero-conversion, commercial maturity, and ratio-zone stop-loss gates run. Stale
scale evidence remains hard-vetoed because scaling needs fresh recent-hold
proof.

Reason: stale evidence is a safety condition, not proof that a severe mature
loser should be hidden behind a diagnostic row. A buyer still needs to see the
stop-loss risk, but Adsecute must not present it as high-confidence or
auto-applicable until fresh evidence is available.

Scope:

- Stale source evidence adds a server-produced `stale_evidence` badge and caps
  confidence through config-as-data.
- Stale mature losers may emit `cut`; stale scale candidates emit near-scale
  `keep` with `scale_readiness_blocked`.
- Verified no-delivery still requires a fresh latest-window proof floor.
- Stale landing/checkout diagnosis does not terminally block downstream
  stop-loss math; any funnel issue remains secondary evidence on the cut.
- Policy proof remains visible when explicit policy/review evidence exists,
  while confidence remains capped by stale evidence.
- UI and Decision Center bridge only render server-supplied labels, badges,
  missing-data markers, and lane decisions; UI does not compute `buyerAction`.

Rejected alternatives:

- Keep stale source evidence as a terminal `Diagnose`. That hides clear
  stop-loss decisions and makes severe losers look like data-refresh tasks.
- Allow stale scale. Recent-hold and marginal-return proof are inherently
  freshness-sensitive, so stale scale must remain blocked.
- Use a manual refresh button as the primary fix. The button may help operators
  during incidents, but the decision contract must stay correct even when a
  source row is stale.

Implementation addendum (2026-07-12): remove the later 7-day hard-action label
cliff. It contradicted this decision by converting a visible mature stop-loss
`cut` into `diagnose` at hour 169. The existing source-freshness boundary now
does both jobs: stale/unknown evidence caps confidence and blocks performance
execution authority, while a severe stop-loss verdict remains `cut` with
`blockedActionType=cut`. Stale `scale` and `refresh` remain non-hard published
labels with their intended action preserved as held provenance.

## D033 — Replace Manual Campaign Labeling With Automatic Campaign Context

Decision: manual Campaign Labeling must stop being an operator-required
workflow. The engine still needs campaign context, but that context must be
produced server-side by an automatic, deterministic, provenance-carrying
Campaign Context Resolver before it can drive kind-aware baselines, test
semantics, or buyer-facing execution CTAs. The backend should assign campaign
context automatically by default; an explicit user correction may override that
automatic assignment when the user chooses to fix it.

Reason: the existing Main/Test/Mixed campaign label is not cosmetic. It drives
three separate safety contracts: calibration cohort selection, test-specific
semantic transforms, and hard-action blocking when campaign role is unknown.
Deleting the concept outright would reopen unsafe behavior that the current
label guard intentionally blocks. The correct product interpretation is:
operators should not be asked to label campaigns manually; the server must
infer campaign role and expose confidence, evidence, and blockers. User
correction is an exception path, not the primary source of truth and not a
required queue.

Scope for the next slice is documentation and shadow design only:

- Add an explicit specification for an Automatic Campaign Context Resolver in
  `AUTOMATIC_CAMPAIGN_CONTEXT_SPEC_2026-07-06.md`.
- Keep active resolver behavior unchanged until golden cases, historical
  replay, live shadow, and user approval gates pass.
- Treat existing `meta_campaign_labels` rows as compatibility, evaluation,
  backfill evidence, and possible migration storage for explicit user
  overrides. The buyer-facing product must not ask the operator to label
  campaigns before decisions can work.
- Introduce additive provenance concepts such as `campaignKindSource`,
  `campaignContextConfidenceClass`, resolver version, and evidence JSON before
  UI or adapter consumption.
- Replace the current label-missing operator language with automatic-context
  blockers such as `campaign_context_unresolved`,
  `campaign_context_low_confidence`, and `campaign_context_conflict`.

Constraints:

- UI must not compute `buyerAction`, `campaignKind`, campaign-context
  confidence, or fallback action semantics.
- The resolver must be deterministic, config-as-data, and explainable. The
  first version must be rule/score based, not ML/LLM based.
- Kind-aware calibration may use only high-confidence inferred campaign
  context, and only after existing kind-slice sample floors pass.
- Test classification requires stricter evidence than Main classification
  because false Test context can trigger more destructive semantics such as
  refresh-to-cut or promote-to-main misrouting.
- Context class changes require hysteresis; a single-day signal swing must not
  flip Test/Main/Mixed semantics.
- Old snapshots and current V1/operator/V2/V3 compatibility must remain
  readable through additive fields and fallbacks.

Rejected alternatives:

- Delete campaign context and remove the guard. That violates the invariant
  against high-confidence hard actions when required context is missing.
- Keep the current manual labeling modal as the primary fix. Operational
  evidence showed the manual workflow is not reliable enough to unblock the
  engine.
- Use campaign/adset names as the main classifier. Naming is high-precision
  but low-coverage and account-specific; it must be one signal among several.
- Let UI derive context from campaign names or card data. That would create a
  second decision layer outside the tested server pipeline.

Risk and approval gates:

- If the user wants to remove Main/Test/Mixed semantics themselves, not just
  manual labeling, that is a separate product decision.
- Allowing medium-confidence context to leave mature stop-loss cuts visible is
  looser than the current unlabeled guard and requires explicit user approval
  before implementation.
- User overrides must be explicit, auditable, and visible as a source. They must
  not hide resolver quality problems or recreate the old required labeling
  workflow under another name.
- The inferred resolver must not be consumed by production decisions unless
  high-confidence rows pass a labeled evaluation bar, recommended at least 90%
  accuracy, and live shadow shows acceptable divergence.

### D033 Implementation Status Addendum (2026-07-06)

Implementation landed behind the kill switch with zero default behavior change:

- Resolver: `lib/creative-decision-engine/campaign-context/resolver.ts`
  (deterministic, config-as-data, family-prefix inheritance for cold start,
  age-normalized turnover, single-creative catalog floor override; version
  `campaign-context-resolver.v1-shadow-2026-07-06`).
- Producer: `lib/creative-decision-engine/jobs/campaign-context-job.ts`, first
  and non-gating step of the scheduled producer chain; persists
  `engine_v3_campaign_context_daily` with daily two-consecutive-day hysteresis.
  The table populates in every mode, so live shadow starts on deploy.
- Consumption: all four decision surfaces read
  `readCampaignContextLabelMap` (`campaign-context/source.ts`). Under the
  default `CAMPAIGN_CONTEXT_MODE=legacy_labels` this is byte-identical to the
  previous meta_campaign_labels path (full suite green, 3477 tests). Under
  `automatic`: user_override -> system_inferred -> unknown; guard trust
  classes: override/high = labeled semantics; medium = canonical baselines,
  no Test transforms, hard scale/refresh demoted, mature cut visible with
  `campaign_context_low_confidence` (user approved 2026-07-06); low/unknown =
  unresolved demotion; conflict = unresolved with conflict badge. `unknown`
  mode is the emergency circuit breaker.
- Historical evaluation (read-only, live DB): pooled active-labeled agreement
  13/16, high-confidence 7/7, false-Test 0/38 any class; artifacts in
  `AUTOMATIC_CAMPAIGN_CONTEXT_SHADOW_2026-06-01_TO_2026-07-05.md`.
- Codex deploy-gate review fixes (2026-07-06): V3 and evidence routes now
  pass request `asOf` into automatic context reads; campaign meta feature IO
  matches the warehouse dual-identity pattern
  (`business_ref_id::text = $1 OR business_id = $1`); unresolved automatic
  context entries carry `kind: null` rather than a placeholder kind.
- The consumption flip to `automatic` remains a separate deploy decision:
  bump `ENGINE_VERSION`, promote guard-level context tests into canonical
  golden cases, run >=7 days of live shadow, and keep rollback via
  `CAMPAIGN_CONTEXT_MODE=legacy_labels`.

## D034 - Reduce Decision Authority When Commercial Targets Are Stale

Status: superseded by D058 for decisions produced by the 2026-07-15
target-age-advisory epochs. Historical snapshots keep this contract.

Decision: a configured commercial target remains inspectable after it becomes
stale, but it must not retain the same decision authority as a recently
confirmed target. A target is fresh for 30 days from its persisted
`updated_at`. A positive target older than 30 days, or one whose update time is
unknown, is resolved as `commercial_truth_stale`, receives the visible
`Target stale - reduced authority` badge and a 15-point confidence penalty,
and makes target-derived hard actions ineligible. Fresh targets preserve the
existing `commercial_truth` behavior unchanged.

Reason: business economics can change independently of Meta performance. A
historical ROAS target is still useful context and should not disappear, but a
hard scale or cut based on an unconfirmed commercial assumption is false
precision. Treating an unknown timestamp as fresh would silently grant full
authority to legacy rows that cannot prove recency.

Implementation contract:

- `resolveBusinessTargetPackFreshness` is the shared 30-day clock for engine,
  Meta account pulse, and commercial-target adapters.
- Resolver inputs carry `commercialTargetFreshness`; persisted or derived
  profiles expose the same provenance through
  `quality.commercialTruthFreshness`.
- The target value and target-relative math remain visible for diagnosis.
- Freshness affects authority, not the target number: no fallback target is
  fabricated and no stale target is silently replaced by an account baseline.
- Any behavior-changing rollout uses a new `ENGINE_VERSION` so prior snapshots
  remain readable and reversible.

Rejected alternatives:

- Hide or delete stale targets. That removes useful operator context and makes
  the reason for reduced authority opaque.
- Treat an unknown update time as fresh for compatibility. That grants hard
  action authority without evidence.
- Let each UI surface decide its own freshness threshold. That would create
  inconsistent authority and a second decision layer outside the server.
- Fall back silently to the account baseline whenever a configured target is
  stale. That changes the economic yardstick without an explicit operator
  decision.

Golden coverage: GC-077 through GC-079 lock fresh, stale, and unknown target
freshness behavior. Gate and account-profile tests additionally lock the badge,
confidence delta, and hard-action eligibility boundaries.

## D035 - Serve Diagnose As A Resolution State, Not A Buyer Decision

Decision: persisted `diagnose` and adapter-level `diagnose_data` remain readable
for engine and snapshot compatibility, but the Meta Decisions server contract
must not present `diagnose_data` as a buyer action. The account-scoped read
model converts it into `decisionState: blocked`, a nullable `buyerAction`, and
a deterministic, server-owned `resolution`. Known engine decisions keep
`decisionState: act` or `monitor`; `out_of_scope` becomes `not_applicable`.

Reason: `diagnose_data` currently represents several different conditions:
missing evidence, automatic campaign-context uncertainty, tracking faults,
funnel bottlenecks, and unknown adapter fallbacks. Ranking all of them as Act
Now and labeling them "Investigate Data" or "Cannot Assess" turns a safety
fallback into a vague pseudo-decision. It also hides valid `keep` and
`test_more` states behind an assessment classifier that never classified them.

Meta Decisions compatibility contract:

- `legacyBuyerAction` preserves the adapter output for audit and old snapshot
  interpretation.
- `buyerAction` is null when `decisionState` is `blocked` or
  `not_applicable`; blocked rows are never apply-eligible.
- A blocked row must carry a versioned `resolution` with `code`, `category`,
  `owner`, `label`, and `nextStep` produced from persisted badges and blockers.
- Delivery, policy, tracking, landing-page, checkout, campaign-context, and
  freshness states use distinct resolution codes. UI must not infer them from
  reason text.
- `test_more` is assessed as Learning; ordinary `keep` as Stable; generic
  `refresh` as Refresh Candidate; known funnel diagnoses as Funnel Bottleneck.
  "Cannot Assess" is not a valid label for these known states.
- The Meta OS UI has separate Act Now, Needs Resolution, and Monitoring lanes.
  A layer remembers its own lane and falls back to a non-empty lane when its
  selected lane has no rows.
- Automatic campaign role remains the default. A system-owned campaign-context
  resolution may expose an explicit Main/Test/Mixed correction for authorized
  users; the correction is optional, audited, and never inferred in the UI.
- Exact-ad candidate selection runs after server semantic classification. A
  bounded response must reserve representation for every non-empty lane before
  filling remaining capacity by priority; confidence-only pre-capping is
  forbidden.
- Candidate receipts expose pre-cap and selected counts by lane, plus explicit
  ambiguous, unresolved-identity, and not-applicable counts.
- The first response remains bounded at 60 exact ads. An explicit Show More
  command asks the server to expand the same deterministic ordering in 60-row
  increments, capped at 300; the client never appends or re-ranks raw rows.

Compatibility and scope:

- No historical snapshot label is rewritten and no decision formula changes.
- The engine may continue persisting `diagnose` until a separately versioned
  engine-output migration is approved. The Meta read-time projection is the
  compatibility boundary for current and old rows.
- New snapshots persist nullable `blocked_action_type` audit metadata so a
  context-held Scale, Cut, or Refresh signal survives the DB round-trip. Old
  rows remain readable; `stop_loss_review` is the only safe legacy fallback for
  a held Cut, and no free-form reason text is parsed.
- A future engine contract may persist the full resolution directly, but the UI
  must consume the same discriminated server contract rather than inspecting
  raw labels.

Rejected alternatives:

- Rename `diagnose_data` to a friendlier action. This preserves the semantic
  error: missing authority is still not a buyer decision.
- Parse free-form reason strings in the UI. That creates an untested second
  resolver and breaks as copy changes.
- Remove ambiguous creative-to-ad omissions. Creative-grain metrics cannot be
  copied to an arbitrary ad when multiple ads share the creative.
- Increase the candidate cap without changing ordering. A larger
  confidence-only cap can still starve an urgent or blocked lane on a larger
  account.

## D036 - Safety-Dominant Hard-Action Hysteresis

Decision: hard-action hysteresis is asymmetric. Exiting a `scale`, `cut`, or
`refresh` decision into any soft, blocked, or not-applicable state publishes
the current guarded decision immediately. Entering a hard action still
requires two consecutive evaluations. A direct switch between hard actions is
neutralized to `keep` for the pending evaluation and confirms only if the new
hard action repeats. Pending output carries `blockedActionType` for the raw
hard action and an explicit statement that no hard action is currently
published.

Reason: the previous label-only implementation could combine yesterday's
`scale` or `cut` label with today's opposite reason, badges, confidence, and
safety blockers. It could therefore resurrect an action that policy, delivery,
commercial-truth freshness, campaign-context, or data-health logic had already
blocked. Hysteresis is allowed to reduce noisy action entry; it is not allowed
to outrank safety or create a hybrid decision tuple.

Implementation contract:

- The canonical hard-action set is `scale`, `cut`, and `refresh`.
- Hard-to-soft and soft-to-soft transitions publish immediately.
- Soft-to-hard and hard-to-different-hard transitions require the raw hard
  action to repeat on the next evaluation.
- A first-ever hard observation also publishes canonical `keep`; a missing or
  unreadable baseline never grants bootstrap hard-action authority.
- Every pending hard entry publishes `keep`, never the previous hard or soft
  verdict. This prevents diagnostic/action hybrid tuples.
- Pending decisions are non-executable and retain the intended hard action only
  as `blockedActionType`/raw-label audit metadata.
- The decisions producer and live briefing route must use the identical helper.
- Hysteresis memory is read at the same account or campaign scope as the
  decision profile that produced the current verdict.
- Stale or pending hard verdicts may remain visible for review, but briefing
  serialization must expose a review CTA and never a provider-write CTA.
- Any rollout uses a new `ENGINE_VERSION`; prior snapshots remain readable.

Rejected alternatives:

- Republish the previous hard label with today's decision payload. This is the
  unsafe hybrid behavior being removed.
- Delay safety exits for a second evaluation. A stale, policy-blocked, or
  no-delivery signal must remove hard-action authority immediately.
- Remove hysteresis entirely. Requiring confirmation before a new hard action
  still reduces boundary noise without preserving obsolete authority.

## D037 - Separate Performance Decay From Audience Fatigue

Decision: `watch` and `fatigued` require audience-pressure evidence or a
benchmark-relative weakening signal in addition to metric decay. Winner memory
plus one or more declining performance metrics is not sufficient by itself.
When a floor-clearing recent 14-day window is available, decay comparisons use
that recent window instead of the overlapping 28-day cumulative metric; an
improving recent period cannot be labeled fatigued merely because an older
cumulative maximum was higher.

Reason: the previous final branch classified former winners as fatigue-watch
with no pressure evidence. Read-only historical inspection found 1,033 stored
watch rows across engine versions, all below frequency 2.5 and with a maximum
frequency of 1.70. In the active lifecycle path spend concentration and
benchmark trends are not populated, so these rows were performance-decay
observations mislabeled as audience fatigue. The overlapping-window maximum
could additionally call a recovering recent period fatigued.

Implementation contract:

- `fatigued` requires winner memory, at least two material decay signals, and
  exposure pressure or benchmark weakening.
- `watch` requires pressure/benchmark evidence plus either composite decay for
  a non-winner or at least one decay signal for a former winner.
- Decay without pressure leaves fatigue status `none`; lifecycle position may
  still communicate decline.
- A recent window is used as the comparison endpoint only when it clears the
  same spend and purchase floors as winner memory.
- When recent14 is available, decay is computed only against an explicit,
  directly preceding disjoint period. Overlapping cumulative last30/90 maxima
  are not valid fatigue baselines; missing prior-period rates fail closed.
- Runtime hydration materializes that direct `prior14` period from daily facts;
  it is not reconstructed by subtracting rates without denominators.
- Frequency pressure is relative to the current account's 28-day creative
  distribution (P75, minimum eight creatives), never a global 2.5 cliff. The
  stored daily-frequency average remains supporting evidence rather than a
  standalone proof of cross-day unique reach.
- Benchmark weakening can establish pressure but cannot substitute for a
  material CTR, click-to-purchase, or ROAS decay signal.
- The published `winnerMemory` field and status both use disjoint strong-window
  evidence; nested cumulative windows remain unsuitable as independent votes.
- This is a behavior-changing release and shares the new D036 engine epoch.

## D038 - Make Funnel Diagnosis Material And Economically Subordinate

Decision: a funnel stage is weak only below both the account lower quartile and
the risk-preset fraction of the account median:
`weak_threshold = min(Q25, weak_multiplier * Q50)` when both are available.
Landing-page or checkout evidence cannot terminally replace the decision when
the ad's `ROAS / target_ROAS >= 0.85`; it remains a visible secondary badge and
downstream economic gates decide whether the result is Keep, Winner, or another
economically authorized state. Funnel evidence may still explain improvement
opportunity, but it cannot turn observed target-beating economics into generic
indecision.

Reason: comparing a rate directly with P25 made an arbitrarily small miss a
terminal diagnosis. Live evidence included a target-beating ad whose
Link-to-LPV rate was 30.06% against a 30.84% P25. The old ordering erased the
stronger commercial result and converted a useful diagnostic into indecision.
The new rule stays account-relative, uses the configured risk posture, and
keeps causal funnel evidence without letting it contradict observed economics.

## D039 - Separate Growth Targets From Loss Boundaries

Decision: a campaign/ad-set budget expansion requires a fresh explicit target
ROAS; a hard economic cut requires a fresh explicit break-even ROAS. The engine
must not manufacture either boundary by multiplying the other. Loss-budget
maturity is `max(calibrated_hard_cut_spend, CPA_baseline * risk_multiplier)`.
The risk multiplier is an explicit operator posture; currency-specific fixed
spend floors are forbidden.

Relative CPL, cost-per-ATC, CPC, or engagement rank may identify a review
candidate, but it cannot authorize a spend change until the commercial target
contract models that same optimization outcome. A fresh purchase target does
not become a goal-specific upper-funnel target by implication.

Reason: `break_even_roas * 1.15` did not define an acceptable growth return,
and `target_roas * 0.75` did not prove a loss. `TRY 1500 / EUR 50 / default 50`
also changed authority by currency rather than account economics. Relative
winner identification may still operate below the business target, but that is
a portfolio role or promotion candidate, not automatic budget scale.

## D040 - Fail Closed At Mixed Creative Context Grain

Decision: a creative aggregate is decision-eligible only when its positive-
spend source rows resolve to exactly one provider account, campaign, ad set,
optimization context, objective, and funnel cohort. Missing identity or any
mixture emits `out_of_scope`; no dominant-spend percentage may select one
context on behalf of the rest.

Reason: one creative can be reused across countries, objectives, campaigns,
ad sets, and ads. Attaching the aggregate result to the latest context produces
confident but wrong actions. The current guard is intentionally conservative;
the durable solution is native ad-grain inputs with creative-level portfolio
rollups kept separate from execution authority.

## D041 - Use Independent Evidence In Structure Decisions

Decision: cumulative `3/7/14/30/90d` campaign windows are converted into
disjoint `0-3 / 4-7 / 8-14 / 15-30 / 31-90` bands before weighted history is
computed. `w_i = 2^(-midpoint_i / 14)`, weighted ROAS is
`sum(w_i * revenue_i) / sum(w_i * spend_i)`, and weighted CPA is
`sum(w_i * spend_i) / sum(w_i * purchases_i)`. A non-monotonic cumulative
chain stops at the first invalid band; older windows cannot compensate.

Actual maturity uses observed `firstDeliveryDate`, distinct `activeDayCount`,
and as-of calendar age: `age = min(explicitAge, activeDays, calendarAge)`.
Comparisons are isolated by provider account, currency, funnel intent, campaign
lane, and compatible bid/optimization context. Hard actions require current
active delivery, calibrated sample readiness, fresh commercial authority, and
the action-specific safety gate.

Reason: nested windows are not independent votes, a one-day campaign is not
90 days old because a `last90` row exists, and cross-account/currency peers do
not define a coherent threshold.

## D042 - Gate Every Funnel Percentile By Its Own Sample

Decision: each funnel P25/P50 value is emitted only when that metric itself has
at least 20 non-null creative observations. A dense CTR population cannot lend
its sample count to sparse click-to-purchase, checkout, or landing-page rates.

Reason: percentile availability is metric-specific. Reusing a shared sample
count made one-row downstream rates look calibrated. Twenty is a minimum
estimation-safety policy, not a performance threshold; a future weighted
calibration may replace it with effective sample size.

## D043 - Make Historical Inputs Bitemporal And Generation-Complete

Decision: commercial targets are append-only `upsert/delete` versions and are
read with both `effective_at <= cutoff` and `recorded_at <= cutoff`. No mutable
current target may be projected backward and no synthetic pre-history backfill
is allowed. A date-only decision `asOf` resolves to the scheduled `03:00Z`
producer cutoff; an explicit timestamp preserves that exact instant. Raw Meta
snapshot reconstruction accepts only exact-day rows fetched
by cutoff, segments repeated fetches at each terminal cursor, selects the latest
generation without falling back to an older complete one, and evaluates
duplicates/conflicts only within that generation.

Missing exact-day scopes, incomplete generations, or missing ad/adset/campaign
identity produce `unknown`, never `pass`. Source windows that merely span the
decision date are rejection inventory, not decision evidence.

## D044 - Keep Measurement Claims Below Their Evidence Ceiling

Decision: hard-action ECE is computed on hard-known outcomes only, and recall
uses a dated opportunity set rather than counting only emitted decisions.
Historical replay must report PIT fidelity, unknown/censored outcomes, source
mode, and action-policy contamination. Distribution-derived confidence is not
called calibrated probability until accrued outcomes feed the confidence model
and action/treatment logging permits a causal or controlled-canary evaluation.

Reason: replaying labels over restated facts can expose formula behavior and
authority collapse, but it cannot establish counterfactual lift. A 9.5 claim
therefore requires zero future leakage, complete input manifests, calibrated
hard-action precision/recall/ECE, and live controlled evidence; deterministic
tests alone cannot satisfy that bar.

## D045 - Revalidate Commercial Authority At Generation And Serve Time

Decision: dated Meta Structure snapshot generation reads the append-only target
pack at that date's exact `03:00Z` producer cutoff. Serving a persisted snapshot
revalidates every spend-changing recommendation against the current target pack;
a now-stale, deleted, missing, or objective-incompatible target immediately
demotes the recommendation to review-only and removes `proposedAction` and
`targetValue`.

Creative/Ads hard-action eligibility uses the same action-specific separation:
`scale` requires a fresh explicit target ROAS and `cut` requires a fresh explicit
break-even ROAS. A fresh target CPA can define an observation/spend unit, but it
cannot authorize either ROAS action by itself. Refresh eligibility remains a
separate non-budget action gate.

Reason: target authority is time-dependent. Projecting today's mutable target
into an older snapshot is future leakage, while continuing to serve yesterday's
`act` after the target expired or was deleted preserves authority that no longer
exists. A generic high-confidence spend unit is not a substitute for the
economic boundary of the specific action.

## D046 - Treat A Durable Terminal Raw Cursor As Fetch Completion

Decision: a checkpoint with `nextPageUrl = null` is terminal and must never fall
through to the first-page URL. The first-page URL is used only when no checkpoint
exists. Raw page indexes are partition-global, so a post-fetch checkpoint's next
index is `last_page_index + 1`, not the number of pages in the selected fetch
generation. Restore validates one latest generation, exact durable row count,
cursor equality, contiguous indexes from that generation's own origin, and
refuses fallback to an older complete generation.

Reason: repeated terminal polls can share a partition/run while page indexes
continue globally. Re-fetching page one after restoring a completed generation
double-counts metrics and then creates a checkpoint/raw mismatch. Counting pages
also fails whenever the generation begins at a non-zero global index.

## D047 - Exhaust Historical Simulation Before Declaring An Evidence Blocker

Decision: every decision change that can be evaluated from retained historical
facts must run through one cutoff-strict, paired baseline-versus-challenger
simulation contract before it may be deferred to live accrual. The opportunity
cohort is fixed before any variant is evaluated; variants may not create their
own episode populations. Results are reported separately for exact raw PIT,
persisted decision-input, and restated warehouse source modes.

The execution grain is native `ad_id` for Ads decisions, `adset_id` for ad-set
actions, and `campaign_id` for campaign actions. `creative_id` remains a
portfolio/grouping identity and must not own provider execution when one
creative is reused. A Test winner is an ad-level portfolio role with a
`promote_to_main` action; budget expansion belongs only to the verified campaign
or ad-set budget owner.

Each simulated row must bind an input manifest containing the cutoff, source
generation or row identifiers, hierarchy/goal/country/currency provenance,
target/config provenance, missing/conflicting fields, outcome-completeness
receipt, and deterministic hash. Restated rows or current SCD0 dimensions may
support sensitivity analysis, but they must never be labeled exact PIT.

Historical evaluation uses rolling-origin fitting and later-period testing.
Hard precision, opportunity recall, ECE, false-action cost, unknown/censored
rates, action stability, and safety violations are stratified by grain, action,
business, objective/optimization context, currency, source mode, and treatment
status. Zero-ROAS rows with complete positive-spend outcomes are known losers,
not unknown. Closed windows require a dated ingestion-completeness receipt.

Only facts that were never retained, provider/manual actions that were never
logged, missing successor lineage, and counterfactual effects without a
contemporaneous control may remain physically unreconstructable. Mutable-target
projection, unmatched variant cohorts, partial outcome windows, window-seam
duplication, reversed non-hard polarity, and zero-ROAS censoring are
implementation defects and must be fixed rather than listed as evidence limits.

Campaign-kind conditioning may enter H1 only after its own cutoff-safe
segmentation gate passes. H11's four bounded automatic-context policies did not
pass the locked coverage/Test-recall gates, while legacy labels are current-only
operator state. A rejected shadow classifier may not manufacture calibration
cells; kind-conditioned H1 is therefore eliminated by an upstream authority
invariant, not silently omitted. Country conditioning may run as a separately
labeled restated sensitivity only when every source day uses the latest
complete raw country generation observed by that decision's producer cutoff;
both retained `fetched_at` and `created_at` must be at or before the cutoff.
The generation is reconciled to each normalized ad-day, multi-country ads
remain spend-share vectors, and sparse shares fall back without increasing
confidence. The cutoff-strict 288-variant replay found 69
country-conditioned locked rows but zero
decision changes, so the account-goal parent is retained without claiming
country irrelevance or exact PIT authority.

H9 seasonality includes `none` and `day_of_week_match` on the same fixed
structure cohort. Month-of-year/year-over-year adjustment is eliminated because
the retained 224-day history contains less than one annual cycle; fitting it
would be an unidentifiable calendar recency proxy, not seasonal evidence.

Reason: replay can eliminate many formula, segmentation, confidence, stability,
and authority alternatives immediately. Waiting for new data while retained
history can answer the same question wastes evidence. Conversely, presenting a
restated or unmatched replay as causal proof creates false certainty. This
decision maximizes historical learning while preserving D043 and D044.

### D047 runtime implementation addendum - parallel native-ad shadow

Decision: native-ad runtime authority is implemented as a parallel shadow
producer, not as nullable ad columns on the legacy creative decision tables.
`runAdDecisionsJob` uses `engine_v3_native_ad_decisions_shadow_job`, epoch
`v3-ad-2026-07-12-native-provenance-shadow`, and only the
`engine_v3_ad_decision_*` context/evaluation/snapshot/event family. The legacy
`runDecisionsJob` and creative authority tables remain untouched so an older
rollback binary cannot interpret a native ad row as a creative row.

Every native computation is keyed by business, provider account, entity type,
ad ID, scope, and epoch. `creative_id` is nullable grouping evidence only.
Campaign context comes from the ad's own campaign. Hysteresis and change events
use the same native composite key. Context, immutable evaluation, and snapshot
materialization share one transaction/savepoint and a snapshot is accepted only
when its evaluation ID, identity, scope, date, input hash, and decision hash all
match. A missing schema capability or broken link fails closed before native
snapshot authority is committed.

Native profile availability is isolated per account/calibration cell. A
missing or evidence-unready cell does not abort unrelated ready cells and does
not make a present-day dimension-only ad disappear. Instead the producer
persists a canonical `native_ad_soft_only` context plus a `diagnose` snapshot
with zero hard-action eligibility, a `native_calibration_unavailable` badge,
an explicit blocker, and `calibration_row_id = NULL`. Ready cells retain their
exact native calibration UUID. Only schema failure, invalid batch/replacement
lineage, target-authority mismatch, or broken evaluation linkage aborts the
transaction. No legacy creative calibration or lifecycle row is promoted to
calibration authority.

Present-day hydration may seed a currently assigned dimension/state ad with no
insights row, but marks performance metrics unobserved and publishes only a
diagnostic/context fail-close result. Historical hydration never seeds from
current dimensions. Optional event metrics remain null when their source keys
are absent; they are not coerced into measured zeroes. The parallel migration
contract is recorded in
`D047_NATIVE_AD_PARALLEL_SCHEMA_2026-07-12.md`; the shadow producer is not yet
scheduled and cannot activate until that capability gate passes.

Runtime repair addendum (2026-07-14): entity `observed_at` may be the provider's
old `updated_time`, so complete-run manifest membership is bounded by
`captured_at`. A zero-row decision success is not reusable when the corrected
current complete manifest is non-empty. In that case the scheduler retains the
successful calibration, reruns native decisions, and invalidates the downstream
operator-response success so the chain repairs itself on the next normal cron.
The migration-ready CREATE/constraint/index SQL is exported from
`lib/creative-decision-engine/ad-evaluation-schema.ts` and alters no legacy
creative table.

## D048 - Require Controlled Causal Evidence For Automation Eligibility

Decision: observational pre/post outcomes remain valid review metrics but can
never satisfy the Meta automation gate. Automation evidence must declare the
controlled-causal contract, use a randomized controlled assignment, bind the
experiment, assignment, estimate, recommendation, and treatment receipt IDs,
and reconcile that receipt to a successful provider-verified
`meta_ads_action_log` row. A payload claim, `operatorActed`, or the legacy
`empiricalOutcomeModelAvailable` flag is insufficient.

Payload `experimentId`, `assignmentId`, and `estimateId` values are descriptive
only. A controlled row must also join a durable randomized-assignment registry
and finalized control-estimate registry. Until those registries exist, the
production read model returns both validations as false and the controlled
sample is structurally zero. Duplicate assignments and reused action receipts
are excluded and block eligibility; one provider receipt may not be amplified
into multiple causal observations. Eligibility also requires exact equality
between claimed and accepted controlled rows and zero invalid receipt,
assignment, or estimate counts, so a high-confidence valid subset cannot hide a
malformed row in the same claimed batch. Dry-run action logs are not treatment
receipts, a finalized control estimate may not be reused across observations,
and causal evidence cannot open execution without a separate explicit operator
enablement gate that defaults closed.

Precision, negative-rate, sample-size, confidence, commercial-anchor,
preflight, rollback, and executor requirements continue to apply to the
controlled subset. The observational summary remains visible and separate so
operators can learn from it without silently promoting correlation to causal
authority.

Reason: natural regression to the mean after an unexecuted recommendation can
look positive. The previous contract could therefore open automation after ten
correlational rows even when no treatment occurred. Requiring a reconciled
controlled assignment closes that false-authority path without deleting useful
observational evidence.

## D049 - Cap Account Cut Grading At Fresh Explicit Breakeven

Decision: the account-relative cut-zone boundary is
`min(account_ROAS_ratio_P25, break_even_ROAS / target_ROAS, 1.0)` only when the
account P25 and both commercial anchors are finite, positive, explicit, and
fresh enough to retain cut authority. Otherwise the existing account-P25 path
remains unchanged. Break-even is a safety ceiling; it may narrow but never
widen the account cut zone.

Reason: the cutoff-strict H3 replay evaluated all 16 preregistered boundary and
purchase-floor variants. The same full-cohort V0 comparison before and after
D049 changed cut emissions from 1,390 to 1,380, removed all ten
breakeven-above safety violations, retained 96 supported known cuts, reduced
refuted known cuts from 32 to 29, and left opportunity recall unchanged. The
calibration-selected midpoint challenger found 18 additional supported losses,
but had only 90 known outcomes, 82.2% precision, a 73.1% Wilson lower bound,
and changed established working-zone/fatigue semantics; it did not pass the
declared promotion gate and is rejected.

This is a review-only resolver safety change, not causal lift or automation
evidence. The engine version changes to
`v3-2026-07-12-breakeven-cut-ceiling`; prior snapshots remain readable under
their original version key.

Rejected alternatives:

- Midpoint P25-to-breakeven expansion. It increased recall but widened the cut
  zone and failed the precision/sample gate.
- Fixed purchase floors. They reduced opportunity recall without establishing
  a portable precision gain.
- Current P25 without a breakeven ceiling. It retained seven locked-test safety
  violations.

## D050 - Active-Only Decisions And Automatic Context Without Required Labeling

Decision: the Meta Decisions workspace serves actionable campaign, ad-set, and
Ad decisions only when the current provider hierarchy is live. `ACTIVE` and
`WITH_ISSUES` are live states; `PAUSED`, `ARCHIVED`, `DELETED`, and unknown
status are withheld from the main queues. Existing snapshots are not deleted or
excluded from lineage reconciliation. Their outputs are served in a separate
`Inactive assets` envelope as advisory-only records with zero provider-write
authority.

Automatic Campaign Context is now the product default. Explicit user
corrections still override system inference. The retained H11 challenger did
not pass the locked authority gate, so inferred Main/Test/Mixed context cannot
silently gain kind-specific hard-action authority. Until
`CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENABLED=1` is opened after a new passing gate,
even high-confidence inferred context is consumed as medium, canonical
role-neutral semantics are used, and any context-dependent hard action remains
explicit but review-only. It is not rewritten to `diagnose` and the operator is
not asked to label the campaign. `CAMPAIGN_CONTEXT_MODE=legacy_labels` remains
the rollback compatibility mode; `unknown` remains the emergency circuit
breaker.

Presentation addendum (2026-07-13): when evidence floors prevent a trusted
Main/Test/Mixed classification, the server may expose the resolver's
highest-scoring role as a provisional automatic role. The persisted decision
input remains `kind=null`, canonical role-neutral baselines remain in force,
and no Test transform, hard-action authority, or provider write may follow
from the provisional value. The UI must say that classification is automatic
and optional to correct; it must not render `Label needed` or create a manual
campaign-label queue.

If a current provider campaign has not reached the daily context source yet,
the same presentation layer uses the resolver's shared name vocabulary and
falls back to provisional Main when no token is present. This closes the
operator-label requirement without claiming evidence that does not exist:
confidence remains Unknown and the value still has zero evaluation or write
authority. The current provider campaign name is fetched in the existing
read-only active-Ad receipt; no extra provider request or mutation is added.

Structure recommendations expose current bid strategy/value, the previous
different bid value and capture time, daily/lifetime budget, and range-correct
budget utilization from the server contract. Constrained-bid scale advice
requires a complete 30-day delivery window and profitable account-relative
evidence before recommending a bid increase; selected-range spend is not
divided by a hard-coded 28 days. Meta budget and currency-formatted bid fields
remain provider minor units at the write boundary, but all decision math and
operator display convert them to account-currency major units before comparing
them with spend or formatting money.

Reason: closed assets in an actionable queue mix resurrection advice with live
budget decisions and can authorize the wrong provider mutation. Requiring
manual campaign labeling recreates an operator queue the automatic system was
designed to remove. Conversely, treating a failed shadow classifier as action
authority is not automation; it is unmeasured risk. This split preserves clear
mathematical verdicts, keeps corrections optional, and retains a separate gate
for behavior-changing role semantics.

## D051 - Structure Requires Exact Current ACTIVE Status

Decision: this narrows D050 for the buyer-facing Structure surface. A campaign
or ad set may enter Structure only when its current served status is explicitly
`ACTIVE`. `WITH_ISSUES`, closed statuses, and missing status truth are excluded
from Structure and served through the advisory-only `Inactive assets` envelope.
An ad set additionally requires an explicitly `ACTIVE` parent campaign.

The lane classifier owns the primary filter. The OS presentation composer
rechecks `entityConfiguration.status === ACTIVE` and fails closed if upstream
lane data is malformed or status truth is missing. This is a serving-contract
change only: persisted recommendation snapshots and decision mathematics are
unchanged.

Selected-range metrics may remain historical, but their end-of-range status is
not current-delivery authority. Before classification, every Structure
candidate and its parent hierarchy are reconciled with a read-only current Meta
status probe. If the metric source is historical and current status cannot be
verified, the candidate is normalized to `UNKNOWN` and withheld rather than
inheriting a stale `ACTIVE` value.

Reason: treating `WITH_ISSUES` as operationally live made the word "active"
ambiguous and allowed non-delivering hierarchy rows to occupy the same surface
as budget and bid decisions. Exact status membership is deterministic, visible
to the operator, and prevents synthetic campaign groups from resurrecting an
active child whose parent campaign is closed.

## D052 - Structure Separates Inventory Visibility From Action Authority

Decision: this supersedes D051 only for buyer-facing Structure membership.
Structure shows the complete account-scoped campaign and ad-set inventory by
default, with optional delivery-status and decision-lane filters. The server
presentation contract owns membership, hierarchy, and urgency; the UI may only
filter those supplied fields and must not derive a buyer action or urgency.

D051 remains binding for action authority. A recommendation, provider mutation,
or urgent action badge requires the entity's current served status to be exactly
`ACTIVE`; an ad set also requires an exactly `ACTIVE` parent campaign. Closed,
`WITH_ISSUES`, and unknown inventory rows are context-only, receive no provider
write action, and cannot inherit a stale recommendation merely because they are
visible. Their neutral inventory state is distinct from the advisory inactive
asset envelope used for explicit reactivation candidates.

Exact current hierarchy is necessary but not sufficient provider-write
authority. Campaign/ad-set `proposedAction` and historical `execute_*` values
remain advisory until those entity levels have an immutable canonical
decision-origin contract. The server emits `review_drill` for them and the
client independently normalizes stale/injected `execute_pause`,
`execute_resume`, or `execute_bid` values to review-only. Explicit manual
campaign/ad-set routes are a separate operator contract and must never be
presented as execution of the recommendation.

Urgency is a server-owned presentation field derived from the canonical
recommendation lane and priority. Campaign urgency is the maximum of its own
active recommendation and active child-ad-set urgencies. It changes ordering
and attention treatment only; it does not change resolver math, confidence,
execution eligibility, or provider-write authority.

Reason: operators need the whole account hierarchy for orientation and should
choose when to narrow it, while execution safety requires a much smaller exact
active set. Conflating visibility with authority either hides useful structure
or resurrects closed assets. Keeping the two contracts separate provides full
inventory without weakening D051's write boundary.

## D053 - Native Ad Context Repair And Soft Relative Ranking

Decision: current native-Ad hydration treats the bound `provider_accounts`
timezone as the current physical-account clock. Currency is instead resolved
from the latest cutoff-safe finalized/passed daily source identity and may use
the bound provider account only when that source currency is absent. A mutable
SCD0 provider currency must never overwrite retained source currency. Historical
replay resolves both currency and timezone from cutoff-safe daily source
identity only: currency must be complete and singular across the admitted
window, while timezone must be complete and singular on the latest admitted
source date. It never consumes current config or SCD0 dimensions. For a current
run only, missing daily campaign/ad-set objective or optimization fields may be
filled from the latest config-history row whose `captured_at` and `created_at`
both precede the decision cutoff. Existing non-null daily context is never
overwritten.

An existing `business_target_packs` row with no history is bootstrapped once
into `business_target_pack_history`. Its original `updated_at` is the effective
time and migration time is the recorded time, so the migration restores
bitemporal provenance without pretending that an old target was reconfirmed.
A target-history record newer than the completed calibration batch invalidates
calibration reuse and therefore invalidates downstream Decisions and operator
response reuse on the next natural scheduled chain.

For purchase-ROAS decisions, an exact optimization cell with fewer than ten
mature Ads may use the same account/objective/purchase pooled cell only when
commercial authority is not fresh, the pooled cell has at least ten mature Ads,
and pooled P60 exists. Pooled cells are soft-only by contract: they cannot
authorize scale, cut, refresh, or provider writes. Within that physical
native-Ad account scope, when a stale commercial target sits above the eligible
account baseline, P75 is used at 30+ mature Ads or P60 at 10-29 mature Ads for
relative ranking; both stale-target and account-baseline provenance remain
visible. Legacy Creative decisions and fresh commercial truth are never changed
by this fallback.

Non-purchase optimizations are served as `out_of_scope`, not `diagnose`, because
purchase-ROAS actions do not apply. A native Ad whose terminal diagnosis
confidently assigns the weak step to landing page or checkout is served as
`keep` with an explicit site-fix instruction; the Ad is not blamed for a
downstream-owned failure. Missing or contradictory evidence still fails closed
as `diagnose`.

Reason: IwaStore proved that all required data could exist while the native path
joined the wrong timezone, suppressed config fallback, and lacked target
history provenance. That produced 985 syntactically valid but commercially
empty `diagnose` rows. The repaired contract preserves cutoff safety and hard
action authority while allowing the existing engine to issue differentiated,
review-safe decisions instead of converting every uncertainty class into one
operator question.

## D054 - Native Decision Reads Follow The Latest Effective Terminal Run

Decision: the Meta Decisions read model selects the latest effective terminal
native-Ad producer run inside the requested account and as-of boundary. A newer
failed or non-overlap-skipped run invalidates an older successful generation;
the reader falls back to legacy creative evidence as degraded and review-only
instead of silently serving stale native authority. A fresh `running` attempt
does not blank the last valid terminal success. An advisory-lock skip is ignored
only when an overlapping terminal holder for the same business, job, engine,
and as-of date proves that another scheduler invocation owned the work.

The server presentation exposes source health and the exact fallback reason.
Every active Decisions surface must display degraded native source health as an
account-scoped blocking warning. Legacy evidence may remain visible, but it may
not authorize exact-Ad actions. Historical date selection bounds both native
generation and legacy snapshot reads to the same server-resolved date.

Reason: selecting only the latest successful run allowed a newer producer
failure to be hidden indefinitely. That made an account appear healthy while
the current native pipeline was broken and made date-filtered views consume a
different evidence epoch from the rest of the workspace.

## D055 - Stale Commercial Targets Require Explicit Reconfirmation

Status: superseded by D058 for action authority. Value validation,
bitemporal history, compare-and-swap writes, and atomic replacement remain
binding; elapsed time and value-preserving reconfirmation no longer grant or
remove decision authority.

Decision: target-pack freshness is authority, not display metadata. Stale
commercial anchors remain visible but cannot authorize hard Scale/Cut actions.
They are never refreshed from account performance, a background job, or an
unchanged ordinary save. Reconfirmation is an explicit collaborator action
that accepts no economic values, locks and copies the current server-side pack,
uses the previously observed `updated_at` as a compare-and-swap guard, and
writes a new identical bitemporal `upsert` history version with a fresh shared
effective/recorded time.

Every non-null anchor must be finite and positive. When both sides are present,
`target_roas >= break_even_roas` and `target_cpa <= break_even_cpa` are required.
Missing anchors remain missing; presentation helpers may not fabricate a
configured CPA or ROAS value from another anchor. Stale, unknown-freshness,
missing, or unreadable target authority is surfaced as a warning scoped to
hard target-dependent actions and must not globally disable review-only or
unrelated operations. Local unsaved edits cannot reconfirm the older server
value.

Reason: silently renewing old economics would turn age into false authority,
while forcing operators to change a still-correct number destroys historical
truth. Explicit value-preserving reconfirmation supplies a durable human
attestation, rejects stale browser retries, and keeps the decision engine
fail-closed without inventing account-specific thresholds.

## D056 - Decision Authority Provenance Is A Versioned First-Blocker Chain

Decision: every newly produced legacy Creative and native Ad decision persists
four distinct stages. `pre_authority_label` is the mathematical/semantic label
after explicit semantic transforms but before authority restrictions.
`authority_blocker` is the first effective restriction in the closed blocker
vocabulary. `raw_label` is the post-authority label before hysteresis, and
`label` is the published label after hysteresis. `blocked_action_type` remains
an execution/presentation hint and is not a substitute for blocker provenance.

The first blocker wins. A later freshness, campaign-context, native-metric, or
native-profile restriction may add evidence but must not overwrite the earlier
cause. `pre_authority_label` is audit evidence only: a hard value in that field
never authorizes a provider mutation. Execution continues to depend on the
post-authority raw/published label, native calibration lineage, confidence,
current state, and existing write guards. Historical rows remain nullable and
the reader must display provenance as unavailable rather than infer it from
reason text, badges, or the final label.

The canonical evaluation contract advances to v2, native Ad evaluation to v4,
native outcome to v2, workspace read contract to v2, and OS presentation to
v3. Decision reason truth-source wording and canonical hashes also change, so
the producer epochs advance to `v3-2026-07-14-decision-health-provenance` and
`v3-ad-2026-07-14-decision-health-provenance-shadow`. Prior snapshots remain
readable under their original version keys.

Reason: a single final label cannot distinguish weak mathematics from a strong
verdict withheld by stale evidence, profile eligibility, campaign context, or
native data readiness. Persisting the chain makes account-wide failure classes
measurable without weakening authority, eliminates reason-string parsing, and
prevents a replay or UI from accidentally turning a pre-authority hard verdict
into an executable action.

## D057 - Native Authority Is Attempt-Durable And Epoch-Explicit

Decision: a native Ad decision attempt is inserted and committed before the
work transaction begins. Transaction failure updates that durable attempt to
`failed`; process death leaves a visible `running` attempt that becomes failed
after the reader grace period. The authority reader ranks the latest effective
terminal attempt across all engine versions inside the requested as-of bound.
A newer failure, skip, or successful generation from another engine version
invalidates older current-version authority. Only an overlapping terminal
holder may neutralize an advisory-lock skip.

`authority_blocker IS NOT NULL` unconditionally implies
`authorized_action IS NULL`, even when a hard raw label survives in audit
provenance. The native snapshot CHECK contract must accept that review-only
hard tuple while rejecting the same tuple if it carries a non-null authorized
action. A hysteresis-suppressed hard raw label also has no authorized action;
the database accepts that state only with a matching `blocked_action_type` and
`pending_transition` badge. Database lineage constraints accept any non-empty historical engine
version while current application writes still require the current version.
Exact native backtests accept an explicitly requested engine version and reject
rows from any other version; they never silently substitute the current epoch.
Commercial-truth full replacements use one transaction, a per-business
transaction advisory lock shared with value-preserving target reconfirmation,
and a deterministic locale-independent snapshot revision compare-and-swap.
Malformed, anchorless, type-confused, or stale browser payloads cannot
partially replace targets, country economics, promotions, constraints, or
calibration profiles.

Generalized operator-response constraints retain the immediately preceding
production epoch literal in a semantically non-restrictive expression. This
keeps the prior image's catalog inspector rollback-compatible while accepting
all non-empty historical epochs. Decision-origin action lineage additionally
requires a non-null engine version. The compatibility migration runs only when
the full lineage column set exists and only rebuilds a constraint whose
definition is not already compatible.

Reason: success-only reads hid newer failures, work-local job rows disappeared
on rollback, and current-epoch database checks made historical evidence
unreadable after a version bump. Those failures are systemic authority defects,
not account-specific formula problems. Durable attempts, cross-epoch ranking,
closed action authorization, exact replay epochs, and atomic commercial truth
make failure visible without weakening decision thresholds.

## D058 - Configured Commercial Targets Do Not Expire With Age

Decision: a configured commercial target with cutoff-safe persisted timestamp
provenance and a finite positive action-specific anchor remains authoritative
until a later semantic upsert or delete replaces it. Elapsed time alone cannot
change the target value, effective threshold, confidence, hard-action
eligibility, buyer action, authority blocker, or provider-write eligibility.
The 30-day status may remain visible as advisory review metadata, but it is not
a decision input.

The canonical engine remains the sole owner of target-relative Scale/Cut
mathematics. An old target may not be replaced by account P75/P60 merely
because of age. Adapters, read models, routes, and UI may not turn an engine
Scale/Cut into Keep, Test More, or Watch by applying another age clock. A
serve-time guard may still fail closed for a missing/deleted anchor, an
invalid or unknown timestamp, cutoff-unsafe history, an action/objective
mismatch, or unreadable commercial truth; those are provenance/validity
failures, not age failures.

This decision supersedes the age-authority portions of D034, D039, D041, D045,
D049, D053, and D055. It preserves action-specific anchors: Scale requires a
valid explicit target ROAS, and Cut requires a valid explicit break-even ROAS;
neither may be fabricated from the other. It also preserves source-evidence
freshness, calibration, maturity/loss-budget, recovery hold, campaign context,
active hierarchy, policy/delivery, hysteresis, lineage, and the invariant that
an effective authority blocker implies no authorized action.

The behavior ships under `v3-2026-07-15-target-age-advisory` and
`v3-ad-2026-07-15-target-age-advisory-shadow`, canonical evaluation v3,
native-Ad evaluation v5, workspace read v3, OS presentation v4, and Meta
recommendation `v1.2.0-target-age-advisory`. Prior epochs remain readable
under their original semantics.

Reason: the 30-day veto was a repository product policy, not a business
setting. It caused a mathematically clear Cut to be rewritten as Test More and
then suppressed again at serve time. Age is not evidence that the configured
economics changed. Explicit replacement/deletion and cutoff-safe provenance
are deterministic authority boundaries; elapsed time is not.

## D059 - A Held Hard Verdict Is A Blocked Resolution, Not A Soft Buyer Action

Decision: whenever a persisted decision carries non-null
`blocked_action_type`, the Meta Decisions server projection must serve
`decisionState: blocked`, `buyerAction: null`, an explicit held-action label,
and a deterministic resolution derived from structured badges/blockers. The
published `keep`, `test_more`, or other soft label remains compatibility and
audit provenance only; it cannot become the operator instruction. The UI
renders this projection and does not infer the held action from metrics, free
text, or thresholds.

The projection includes persisted `authority_blocker` in its structured
blocker set. Profile/calibration holds, source freshness, campaign context,
native metric/profile availability, and hysteresis pending transitions receive
distinct server-owned resolution copy. For a held verdict, the persisted engine
`authority_blocker` selects the resolution before secondary badges; structured
commercial-truth evidence may then refine a composite profile blocker into the
specific target-provenance repair. Otherwise a real profile hold could
misleadingly recommend campaign classification or another step that cannot
release it. A held Cut is assessed as an
underperformer, a held Scale as above-target but not action-ready, and a held
Refresh as a refresh candidate. Classification overlay advances to
`meta-decisions-classification-overlay.v3`; the uncommitted workspace read v3
and OS presentation v4 contracts carry the change.

This is presentation semantics only. It does not change the engine formula,
published snapshot label, `authorized_action`, action preflight, or provider
write eligibility. A held hard verdict remains non-executable, and
`authorized_action` stays null.

Reason: the engine may correctly preserve a hard verdict while profile,
calibration, freshness, context, or hysteresis withholds action authority.
Presenting the published compatibility label as `Continue Test` told the buyer
the opposite of the retained verdict. The server already owns both the held
action and its blocker, so it must project the honest blocked state without a
second calculator or any authority expansion.

## D060 - Commercial Stop-Loss Does Not Require A Peer Percentile

Decision: native Cut authority has two mutually exclusive canonical evidence
paths. A cell with at least the declared ROAS-ratio sample floor and a positive
account P25 uses the calibrated relative path from D049. When that percentile
is unavailable, an exact purchase cell may instead use the commercial
stop-loss path. That path requires cutoff-safe explicit target and break-even
ROAS authority, retained commercial spend-unit authority, the existing
loss-budget maturity/recovery/status/data-health gates, and a canonical cut
boundary of:

`min(account P25 ?? existing uncalibrated 0.70 fallback, break-even / target, 1.0)`

The `0.70` fallback already existed in the resolver; this decision does not
introduce a new threshold. It closes the duplicate native veto while making
the fallback safer: explicit break-even now narrows the boundary even when P25
is absent. A missing/invalid/cutoff-unsafe anchor, non-purchase or pooled cell,
untrusted spend unit, source/status/context blocker, recovery hold, or broken
lineage still fails closed. Pooled calibration remains soft-only.

The native calibration receipt records the selected authority basis. A ready
sample-backed action uses `calibrated_relative`. A ready exact-cell Cut without
a sample-backed P25 uses `commercial_stop_loss` and declares zero required peer
samples. This is provenance, not a second calculation: all label mathematics
remain in the canonical resolver. Scale retains its 30-sample winner benchmark,
purchase-depth, and recent-hold requirements. Refresh retains its calibrated
trend requirement.

D049 remains binding whenever a calibrated P25 exists: break-even can only
narrow that boundary, and the uncalibrated path cannot override it. D036 also
remains binding. A first hard Cut is published as pending and only a later-date
natural evaluation can confirm it; same-day retries do not manufacture
independent evidence. Automatic provider execution remains separately closed
by the controlled-causal and operator-enablement contracts.

The behavior ships under `v3-2026-07-15-commercial-stop-loss` and
`v3-ad-2026-07-15-commercial-stop-loss-shadow`, canonical evaluation v4 and
native-Ad evaluation v6. Because `action_readiness_json` gains the mandatory
authority-basis proof, native-Ad calibration advances from v1 to v2. Workspace
read v3, OS presentation v4, and existing Meta recommendation contracts do not
change because their shapes and ownership do not change. Prior epochs remain
readable under their original semantics and are never reinterpreted as v2.

Reason: the retained engine already separated loss-budget Cut maturity from
winner-depth Scale readiness, but the native adapter added a second global
`20 samples + P25` Cut veto. Live exact-Ad evidence exposed 33 active
commercial-truth Cut candidates with null P25; blindly deleting the veto would
also have authorized a Tiles row whose ROAS was above explicit break-even.
Applying the break-even ceiling to the existing uncalibrated fallback excludes
that counterexample while allowing the canonical stop-loss path. This is a
contract-conformance and monotonic-safety correction, not a causal lift claim
or a business-specific exception.

## D061 - Physical-Account AOV May Size Cut Loss Budget Without Owning Peer Authority

Decision: AOV is a physical Meta-account and currency economic scalar, not an
optimization-context percentile. An exact purchase cell whose own AOV sample is
thin may therefore use a separate
`physical_account_purchase_aov_90d` spend-unit proof for Cut only. The proof is
valid only when all of the following are true:

- the business, provider-account reference, provider account ID, and one
  canonical account currency match exactly;
- every candidate fact is inside the 90-day window, `FINALIZED`/`PASSED`, and
  has `created_at`, `updated_at`, and `finalized_at` at or before the repeatable-
  read calibration cutoff;
- only the current canonical metric schema contributes to AOV, conversions are
  finite non-negative integers, and at least 20 revenue-backed purchases exist;
- purchase/revenue contradictions, malformed canonical facts, or conflicting
  duplicate `(ad_id, date)` facts block the complete account-AOV proof; and
- target ROAS remains cutoff-safe commercial authority. Cut readiness still
  separately requires cutoff-safe break-even ROAS.

These strict `finalized_at` conditions define only the physical-account AOV,
currency, and timezone evidence lane. They do not retroactively narrow the
retained peer-calibration fact contract. Peer percentiles continue to admit an
Ad only when its Ad, exact same-day campaign, and exact same-day ad-set facts
are all `FINALIZED`/`PASSED`, hierarchy identity is complete, and every retained
created/updated timestamp is cutoff-safe. A legacy Ad fact with null
`finalized_at` remains eligible for that peer lane when those conditions hold,
is counted explicitly in calibration quality proof, and can never contribute
to the strict physical-account AOV numerator or its currency/timezone
authority.

The evidence manifest includes every cutoff-safe finalized candidate, including
legacy, malformed, and conflicting rows, so an excluded contradiction cannot
disappear from the hash. The receipt binds the target-authority hash, account
identity, currency, cutoff, window, purchase and row counts, revenue, mean AOV,
evidence hash, selected basis, base spend unit, and authority hash. JSON numeric
proof fields are type-strict. The spend-unit precedence remains
`target_cpa`, then `operator_aov`, then physical-account AOV.

Currency admission is an account-scoped fail-closed receipt inside the same
atomic business job. Cross-business or cross-provider source identity remains
transaction-fatal. Missing source currency, missing resolved currency,
resolved/source mismatch, or mixed retained currencies instead produce a
complete zero-cell generation for only that physical account. The anomaly
rows and counts remain in the source/account-AOV hashes, the spend-unit proof
is blocked, and no old same-day batch may leak into serving. Other healthy
account bindings in the same business still complete in the one atomic success
receipt; this is not a partial commit or a borrowed-currency fallback.

This is not a second decision calculator. The trusted account AOV is passed into
the retained account-profile resolver, which uses the existing spend-unit
resolver, preset multipliers, threshold builder, hard-action eligibility, and
canonical gates. It creates a separate Cut loss-budget threshold view only.
When this proof repairs a canonically Cut-ineligible cell, that Cut-only view is
the complete spend-depth authority. The untrusted exact-cell thresholds cannot
be reintroduced through a minimum, even when they are lower; doing so would
authorize Cut before the trusted physical-account loss budget is reached.
Exact-cell AOV, peer P25/P10, winner benchmarks, Scale eligibility, Refresh
eligibility, fatigue, lifecycle, and campaign-kind authority are not borrowed.
Kind-aware selection must preserve this account-wide Cut authority without
changing its kind-specific Scale or Refresh results. Above-break-even rows must
not receive a new Cut verdict or a new manual-Cut badge from the account-AOV
threshold.

Target age remains advisory under D058: a valid old target is not blocked or
replaced. Pooled and non-purchase cells remain soft-only. D049 still governs a
sample-backed P25, D060 still caps the uncalibrated boundary by break-even, and
D036 still requires a later-date confirmation; same-day retries cannot confirm
Cut. Provider execution remains outside this authority change.

D047 is a release gate, not optional analysis. The production functions must
pass a deterministic frozen exact replay covering thin-cell/account-AOV Cut,
above-break-even Keep, recovery hold, Scale/Refresh isolation, same-day retry,
and later-date D036 confirmation. A fixed historical opportunity cohort must
also run baseline-versus-challenger using separately labeled persisted
decision-input and cutoff-safe raw-PIT evidence before waiting for a natural
scheduler wave. The scheduler wave proves production orchestration,
persistence, and lineage only; it is not the first test of decision behavior.

A fixed-cohort lane that claims current production parity must rebuild the
challenger ready/soft profile through the scheduled job's production profile
grouping and native account resolver against the cutoff-bound recomputed
calibration generation. The rollback epoch's persisted profile remains
baseline evidence only. Reusing or selectively patching that stale profile can
preserve an obsolete low-sample veto even when the current exact cell is ready,
and therefore cannot pass the release gate. Frozen Ad metrics, campaign
context, data health, identity lineage, and epoch-scoped hysteresis remain the
paired inputs; current account currency must still match exactly.

When exact historical persisted/PIT inputs were not retained, a separate Lane
B may restate finalized/passed daily facts for formula-sensitivity review. The
immutable row timestamps, statuses, exclusions, and hashes remain audit truth;
only separate calculation copies may be availability-restated to the review
cutoff. The requested historical optimization cell must still exist exactly.
An account-wide fallback cell, mutable current SCD0 field, or non-finalized
hierarchy row cannot be invented to make a named account pass. Such a lane is
always labeled review-only and cannot open automation or release authority.

D036 replay state must use the exact physical provider-account scope installed
by the native production resolver. The retained compatibility resolver's
`account/*` scope is never a native-Ad hysteresis key: both ready and soft-only
replay days are pinned to `account/<providerAccountId>`, and gap reset, read,
advance, and confirmation must use that same key. Every reconstructable daily
decision advances that state in chronological order; the 7-day spacing
selects outcome-scored rows only and must not skip intermediate soft decisions.
Reports must separate pre-authority, raw, and published labels and report every
chronological decision. Only a final published Cut is an emitted hard action.
Recall opportunities require the fixed production commercial-maturity spend
before the outcome is observed; immature future losers are not missed-Cut
opportunities.

The unreleased candidate was versioned
`v3-2026-07-16-account-aov-authority` /
`v3-ad-2026-07-16-account-aov-authority-shadow`, with canonical evaluation v5,
native-Ad evaluation v7, and native calibration v3. It was superseded by
D063/D064 before deploy and never shipped as an independent production epoch.
The exact rollback native epoch remains
`v3-ad-2026-07-15-commercial-stop-loss-shadow`. Older receipts remain readable
only under their own epochs and are never inferred into v3.

Reason: live D060 evidence showed that exact optimization cells could contain
too few purchases to trust their AOV even when the same physical account and
currency had ample cutoff-safe purchase truth. The adapter then intersected a
correct semantic Cut with an unrelated thin-cell spend-unit veto and published
no decision. Borrowing peer percentiles would widen authority; bypassing the
retained Cut gate would create a second engine. Account/currency AOV repairs the
grain error while preserving the existing engine and fail-closed boundaries.

## D062 - Current-Epoch Native Ad Generations Are The Single Serving Authority

Decision: a complete current-epoch native-Ad generation is the only serving
authority for an exact-Ad decision or provider action. Server consumers must
read one shared validated generation bundle before projecting a decision. The
bundle is available only when the latest effective terminal run is successful
under the current native engine epoch, its account receipt is authoritative and
complete, and its immutable snapshot set exactly matches the receipt count and
identity manifest. Every snapshot must also bind the same business, provider
account reference, provider account ID, job run, as-of date, account scope,
engine epoch, exact Ad identity, evaluation/context lineage, input hash, and
decision hash. Missing, stale, cross-epoch, cross-account, malformed, duplicate,
or contradictory proof makes the bundle unavailable; consumers must not fill
the gap by recalculating a decision or borrowing a legacy row.

Canonical inventory is formed before queue ranking, section limits, or Ad
candidate caps. It contains every exact-Ad decision in the validated manifest,
including inactive or unknown-delivery Ads as review-only decisions. UI top-N
and lane caps are presentation concerns and may select from this inventory, but
they never redefine the authoritative population. Creative ID remains grouping
metadata only and cannot select a representative Ad or grant action authority.

Legacy creative snapshots remain readable during migration solely for
compatibility and diagnosis. They retain `legacy_review_only`, null authorized
action, and no provider-write authority. A missing or invalid native bundle may
therefore expose an explicitly labeled legacy review surface, but that surface
is not a serving fallback for action and cannot be converted into a native
decision by presentation code.

This decision changes read-model and presentation authority only. It does not
change the retained decision formula, thresholds, canonical evaluation, native
calibration, or native engine epoch. Existing immutable rows remain valid only
under their own recorded epochs; no data rewrite or epoch inference is allowed.

Rollout is additive: introduce the shared validated bundle and uncapped
canonical inventory, migrate server consumers to them, then quarantine legacy
serving paths. Rollback reverts a consumer to the preceding native Decisions
presentation while retaining all persisted generations and lineage. It never
reenables a legacy provider action, changes an engine epoch, writes a provider,
or mutates historical decision evidence.

Reason: the current Decisions workspace already validates native exact-Ad
lineage, but generation validation was embedded in its capped presentation
read. Other server surfaces could therefore recompute decisions, read legacy
creative snapshots, or mistake a top-N queue for the complete account
population. A single fail-closed bundle plus a cap-independent canonical
inventory removes that serving ambiguity without introducing a second engine.

## D063 - Explicit Break-Even Extends Only The Economically Losing Cut Strip

Decision: D049's break-even ceiling remains the safety boundary that prevents
any Cut at or above explicit break-even, but it no longer makes a lower account
P25 an absolute veto on an otherwise mature economic loss. The canonical
resolver owns two disjoint Cut regions. Let `L` be
`min(account P25 ?? existing uncalibrated 0.70 fallback, 1.0)` and let `B` be
`min(explicit break-even ROAS / explicit target ROAS, 1.0)`:

- `ratio < min(L, B)` is the legacy safe-loss region. Its D049/D060 recovery,
  maturity, badge, reason, confidence, Scale, and Refresh behavior is preserved
  byte-for-byte.
- only when `B > L`, `L <= ratio < B` is the expanded economic-loss strip. It
  can enter the existing Cut maturity gate only after the existing Refresh
  precedence has run.
- this strip may include ratios at or above the generic `0.85` target-band
  boundary when explicit break-even is close to target. Target-band Keep is not
  terminal for those rows; after Refresh precedence they continue into the same
  D063 Cut/recovery/recent-evidence branch.
- `ratio >= B` is never Cut-eligible. Equality with break-even is not a loss.

The expanded strip requires explicit recent evidence against break-even rather
than against target. The canonical recent-spend sample threshold is reused
without an account-AOV overlay. Sufficient recent spend with recent ROAS below
break-even confirms the loss and may produce Cut through the existing
hard/sustained/loss-budget maturity rules. Recent ROAS equal to or above
break-even is recovery and produces Keep. Missing recent ROAS/spend/threshold,
or spend below that threshold, preserves the pre-authority Cut but holds it as
`label: test_more`, `authority_blocker: recent_recovery_unverifiable`,
`blocked_action_type: cut`, and null `authorized_action`. It creates no
hysteresis pending transition. Once evidence becomes sufficient, D036 starts
from the first unblocked Cut and still requires a later-date confirmation.

The blocker is structured authority provenance, not a second verdict. Reusing
profile or native-metric blockers would falsely claim that a ready profile or
available metric family is absent; using a pending transition would conflate
evidence sufficiency with independent-date stability. Serving therefore
projects an explicit wait/refresh-recent-evidence resolution and never turns
the compatibility `test_more` label into an operator instruction.

D061 account-AOV authority remains isolated to Cut loss-budget maturity. It
cannot change `L`, `B`, the recent sample threshold, recovery, Scale, Refresh,
or confidence. Target age remains advisory under D058 and is not an economic
veto. Pooled/non-purchase cells, invalid or cutoff-unsafe commercial anchors,
and all existing source/status/context/profile blockers continue to fail
closed. For a P25-null repair that clears the trusted account-AOV maturity
floor, missing or thin recent evidence keeps the repair active only far enough
to emit D063's held-Cut provenance (`pre_authority_label: cut`,
`recent_recovery_unverifiable`); confirmed recovery restores the canonical
profile. This is not executable Cut authority and never creates a D036 pending
transition.

When the row is geometrically inside the expanded strip but its native
expanded-zone capability is explicitly unavailable, the resolver remains
fail-closed at Keep. That presentation must nevertheless state that lifetime
ROAS is below explicit break-even, attach `below_breakeven` and
`stop_loss_review`, and expose the missing authority blocker. Authority denial
must not rewrite an economic loss as "just above breakeven."

The persisted native readiness receipt makes the new authority combination
explicit. A Cut cell with a retained sample-backed P25 plus valid economic
loss-budget proof records
`calibrated_relative_with_economic_stop_loss`; a P25-null exact purchase cell
records `commercial_stop_loss`; other sample-backed actions remain
`calibrated_relative`. This is provenance for the single canonical resolver,
not a second decision path. For a P25-backed Cut, economic loss-budget proof
may come from the authenticated account/currency spend receipt or the same
canonical exact cell's CPA P50 at the retained sample floor. An unrelated
account-level AOV contradiction therefore cannot revoke the legacy P25 Cut.
If neither economic proof exists, the Cut receipt stays
`calibrated_relative`: its hash-bound profile capability closes only the D063
expanded strip while leaving the legacy region available. P25-null cells still
require the authenticated account/currency proof and fail closed without it.

The profile field is deliberately optional only at the canonical non-native
boundary. The absent field makes
`expandedEconomicCutAuthority?.eligible === undefined`, which preserves the
canonical D063 strip for that non-native profile and is not an explicit
authority denial. Native profiles always carry the hash-bound field from their
readiness receipt; `eligible: false` is the explicit native denial and
`eligible: true` is the explicit native grant. Treating `undefined` as false
would silently change the canonical non-native decision policy.

D061 and D063 ship as one not-yet-deployed release epoch:
`v3-2026-07-16-account-aov-economic-stop-loss` and
`v3-ad-2026-07-16-account-aov-economic-stop-loss-shadow`, with the exact D060
rollback epoch `v3-ad-2026-07-15-commercial-stop-loss-shadow`. Existing
immutable epochs remain readable only under their recorded contracts. The
release gate requires zero legacy-region drift, zero Scale/Refresh drift, zero
Cut at/above break-even, zero authorized missing/thin-evidence Cut, exact D036
date behavior, and migration/seam proof for the structured blocker. Historical
temporal replay may reject promotion or remain observationally inconsistent;
it is not causal proof. This bounded correction is justified by the economic
invariant and exact production counterexamples, while the natural scheduler
wave remains orchestration, persistence, and lineage proof only.

The D061 closed-window v3 report separates three authorities. `integrityGate`
owns execution errors, duplicate cohorts, source/lane/lookahead violations,
hierarchy/action-coverage gaps, target-age metamorphic drift, locked-window
identity, Scale/Refresh or above-break-even safety drift, D061-axis coverage,
current-day artifact parity, and target corroboration; only this gate controls
the replay process exit. These row-level checks cover every chronological
evaluation that can advance D036 state, not only the cooldown-selected scoring
cohort; that cohort must be an exact subset of the duplicate-free chronological
manifest. `historicalPromotionQualityGate` owns observational
sample, precision, recall, Wilson, named-account, noninferiority, and
consecutive-day limits. It may reject as `review_only_reject_promotion` without
blocking this bounded policy-contract repair. `automationPromotionGate`
remains false for Lane B regardless of either result. D036 warm-up rows advance
or reset state and stay inside integrity/safety checks, but are excluded from
the locked quality strata.

Reason: the prior `min(P25, break-even / target)` boundary correctly removed
above-break-even Cuts but also classified every mature loser between a low P25
and a higher explicit break-even as working-zone Keep. That makes peer rank
override direct unit economics. Extending only the below-break-even strip,
with explicit recent confirmation and the retained maturity gate, repairs that
contradiction without replacing the decision engine or weakening the legacy
safe-loss path.

## D064 - Decision Presentation Must Preserve Canonical Meaning And Demo Must Be Synthetic Review-Only

Decision: D061 and D063 remain owned by the retained canonical resolver. The
release may harden how their outputs are served, but no UI, demo adapter, or
recommendation route may create a second decision calculation or reinterpret a
blocked hard signal as an affirmative soft action.

A persisted held Scale, Cut, or Refresh has one presentation meaning:
`decisionState: blocked`, null executable action, the canonical held-action
buyer label, and an explicit review/resolution path. A compatibility
`test_more` label underneath a held Cut must never be rendered or forwarded as
`Fresh Test`. Launchpad mapping returns no runnable mode whenever the canonical
decision is blocked, held, review-only, or action-ineligible. Provider action
handlers require `native_exact` authority plus complete exact-Ad lineage;
`legacy_review_only` and `demo_synthetic_review_only` are never eligible.

All money copy must use the provider account currency carried by the canonical
input and persisted decision. UI and recommendation adapters may format that
ISO currency, but they must not invent USD, a dollar sign, or a TRY/EUR-only
fallback. If currency evidence is absent, copy must say account currency
without guessing the unit. This changes presentation determinism only; spend,
threshold, and action math remain unchanged.

The demo business is not allowed to query live native-decision persistence or
to calculate decisions during a request. It serves one committed fixture
generated offline by calling the production native-Ad decision job twice on a
fixed synthetic account: the first pass creates D036 memory and the later-date
pass produces the stable canonical output. The fixture binds the current
native engine epoch, demo business, physical provider account, source-row
manifest, item hashes, count, and generation manifest hash. Runtime validation
is all-or-nothing: source drift, hash drift, count drift, identity mismatch, or
epoch drift makes the whole fixture unavailable.

Every demo decision carries `demo_synthetic_review_only`, null
`authorizedAction`, `actionEligible: false`, and exact identity with
`adActionEligible: false`. An engine-derived Cut is therefore visible for
product review but cannot become a bulk Cut, launchpad action, decision-origin
request, or provider mutation. A central Meta write guard also rejects demo
businesses independently of presentation state. The committed generator must
reproduce the fixture byte-for-byte in tests.

Because account-currency evidence now participates in deterministic decision
copy and the serving contract adds a new explicit authority status, the
unreleased D061/D063 candidate advances to
`v3-2026-07-18-decision-presentation-hardening` and
`v3-ad-2026-07-18-decision-presentation-hardening-shadow`. Native calibration
v3, canonical evaluation v5, native-Ad evaluation v7, workspace read v4,
classification overlay v4, and Decisions OS presentation v5 remain unchanged.
The exact rollback native epoch remains
`v3-ad-2026-07-15-commercial-stop-loss-shadow`; the 2026-07-16 candidates were
never deployed as independent production epochs. Immutable older rows retain
their recorded semantics and are never inferred into D064.

Reason: a correct resolver is insufficient when a held Cut is shown as
`Fresh Test`, money copy silently changes currency, or the demo page is empty.
Those defects make a five-second media-buyer review misleading even though the
underlying decision math is sound. A hash-bound production-engine demo and
strict presentation authority make the product inspectable without weakening
live execution safety or introducing business-specific decision rules.

## D065 - Provider Writes Require An Explicit Origin, Exact Live Identity, And Durable Attempt Semantics

Decision: a recommendation, manual operator action, and Launchpad action are
three distinct execution origins. Every provider-write request must declare
exactly one of:

- `native_decision_v1`, with the complete immutable native decision-origin
  tuple, its durable idempotency key, and a server re-read of that exact tuple;
- `manual_operator_v1`, with explicit operator confirmation and the exact
  server-presented provider account, entity, and creative identity; or
- `launchpad_manual_v1`, with explicit operator confirmation bound into the
  immutable LaunchIntent request fingerprint.

Origin must never be inferred from optional field presence. A manual request
that contains any native decision-lineage field, including an explicitly
present null field, fails closed. Legacy campaign/ad-set recommendations and
historical `execute_*` values remain review-only; they cannot manufacture
native decision authority. Demo and synthetic discovery identities have zero
provider-write authority.

For `native_decision_v1`, the server re-read must also derive the exact provider
action from the persisted `authorized_action`: Cut authorizes only `pause` and
Scale authorizes only `resume`. A null or different derived action fails closed
even if the published decision label happens to be `cut` or `scale`.
The server reconstructs the decision-action idempotency key from business,
physical account, Ad, snapshot, evaluation, engine epoch, decision hash,
provider action, and execute/dry-run mode. A caller-selected different key is
rejected before receipt or live-provider reads, so concurrent requests cannot
split one immutable tuple across multiple action-log keys. Exact creative ID is
also mandatory in request, persisted source, and fresh provider state; nullable
legacy creative grouping remains review-only. A successful idempotent receipt
must bind and revalidate that same creative ID before it can satisfy a replay;
an older or contradictory receipt is an idempotency conflict, not authority for
the current request. When `dryRun` is present it must be a JSON boolean.
Malformed truthy/string values fail closed before receipt lookup or provider
work and may never be coerced into execute mode.

Manual-operator and native-decision Ad status claims are serialized together by
the same exact business, physical account, and Ad advisory key. The lock covers
one durable all-origin unresolved-status check and claim insert; provider
network work is never performed while the DB transaction lock is held. Pending
rows are part of that unresolved set. New manual rows persist the exact
provider account. A pre-migration manual status row with a null provider
account still blocks the same business/Ad fail-closed, and no time-to-live
makes any unresolved pending row disappear from authority.

A live manual terminal `silent_failure/provider_outcome_ambiguous` is also
classified as unresolved even though its row is no longer pending. Until exact
reconciliation, a later manual or native claim for the same
business/physical-account/Ad returns
`meta_ad_status_reconciliation_required` with
`reconciliationRequired: true` and `retryAllowed: false`; it performs no
provider POST. A dry-run silent failure proves non-mutation and does not create
this live ambiguity hold.

A concurrent native same-key loser returns the existing pending idempotency
state as typed HTTP 409 `action_in_flight` and performs no provider POST. If
that state already carries a reconciliation marker, the 409 instead exposes
the marker's common error code and forbids retry. A concurrent native
different-key loser returns HTTP 409 with
`decision_origin_pending_reconciliation_required`. Cross-origin and
manual/manual losers return typed HTTP 409 `action_in_flight` with the blocking
action-log ID and origin. Every variant returns before provider mutation and
grants no new attempt or treatment authority. Direct and bulk status routes
must not replace the shared classifier with native-only or time-window pending
shortcuts.

Warehouse and persisted rows are discovery evidence, not final execution
authority. Immediately before a write, the server must GET the requested Meta
entity and prove exact returned ID, physical account, creative identity,
configured/effective status, policy eligibility, and required parent
campaign/ad-set hierarchy. Duplicate/reuse flows must prove both the exact
source Ad/creative and the exact ACTIVE target hierarchy. New-campaign flows
must prove every source creative before the first create and verify exact
returned entity IDs, account ownership, and parent links after every create.
Bulk actions must resolve pending guards and all live target preflights as one
initial set before the first mutation; one initial failure blocks the whole
batch. Both manual and native Ad status actions then repeat the exact live
preflight after their durable claim; native ignores only that claim's own
idempotency receipt. A blocked manual post-claim preflight terminalizes the
claim as a DB-only failure and performs no provider POST. Bulk status execution
repeats this post-claim preflight immediately before each provider POST. A
later claim conflict or just-in-time failure stops that item and every
remaining item; it does not falsely claim that an already verified earlier
item was rolled back.

`rebuild_creative` remains review-only because its image, creative, and Ad
creates do not yet have a durable per-step attempt/receipt and recovery
contract. `reuse_creative` is the only executable add-to-existing mode. Create
and duplicate POSTs must not be retried automatically while the LaunchIntent
contract says retry is unsupported and Meta provider idempotency is not bound
to a durable attempt receipt. GET-only verification may retain bounded
rate-limit retry. Server-enforced request cardinality limits must bound the
total planned creates before intent preparation or provider work. The current
generic bound is 20 creatives, 10 ad sets or targets, and 20 planned provider
creates per Launchpad request; manual status batches are capped at 20 exact
Ads.

A transport exception after a provider POST is an unknown external outcome,
not an ordinary retryable failure. For `native_decision_v1`, the existing action
row remains pending with reconciliation outcome `provider_outcome_ambiguous`,
`retry_allowed: false`, and no immutable operator-action receipt; no mutation
POST is automatically replayed. Manual status actions retain their terminal
`silent_failure` action-log behavior, and Launchpad retains its separate
terminal attempt-receipt contract. A received HTTP rejection remains a definite
`failure` when terminal persistence succeeds.

Manual status terminal facts are also write-once. Generic manual completion now
uses a `status = pending` compare-and-set, accepts only an identical
JSONB-normalized terminal replay, and rejects any attempt to replace an existing
success, failure, or `silent_failure` with a different outcome. A live raw
provider adapter exception becomes non-retryable
`silent_failure/provider_outcome_ambiguous` without an inferred successful
mutation. A bounded terminal-persistence failure returns a typed `503`; verified
provider success is never converted into a fallback `failure`, and bulk
execution stops before the next provider item. The terminal status of a live
`silent_failure/provider_outcome_ambiguous` does not clear claim authority:
that exact-Ad row continues to block later manual and native provider claims
until reconciliation.

Every accepted Launchpad request binds its origin/confirmation into the
request fingerprint, validation receipt, result/error receipt, and action log.
The semantic request fingerprint excludes attempt identity such as
`idempotencyKey` and `launchIntentId`, while retaining the normalized provider
payload and manual authority. An unresolved `provider_outcome_ambiguous` intent
therefore blocks a new intent and provider mutation for the same business,
physical account, operation, and semantic fingerprint even when the caller
changes the idempotency key. The guard is serialized before intent persistence
and has no timeout; only an explicit future reconciliation record may clear it.
Every manual or native status action records its exact source class and
verify-after-write proof. A newly finalized provider-verified native
pause/resume receipt additionally persists one hash-bound verification lineage:
the immutable source creative/campaign/ad-set IDs and the fresh provider
account/creative/campaign/ad-set IDs observed after the write. Every verified
identity must equal its source/episode counterpart before the terminal row can
be successful. Altering any non-null lineage field invalidates the receipt
hash and fails closed.

Every native pending-reconciliation marker uses the common persisted
`error_code = provider_verification_persistence_failed`,
`reconciliation_required: true`, and `retry_allowed: false`; the separate
`outcome` records what is actually known:

- `provider_outcome_ambiguous`: a provider POST was attempted but its exact
  external outcome is unknown;
- `provider_response_succeeded_verification_failed`: the provider response
  proves mutation success but exact post-write verification failed;
- `provider_write_verified_receipt_persistence_failed`: mutation and complete
  post-write verification succeeded but atomic terminal row/receipt persistence
  failed;
- `provider_rejection_terminal_persistence_failed`: a definite provider
  rejection was received but its terminal failure row/receipt could not be
  persisted;
- `pre_provider_terminal_persistence_failed`: no provider POST occurred and a
  post-claim/pre-provider failure could not be terminally persisted; or
- `dry_run_terminal_persistence_failed`: dry-run performed no provider mutation
  and its terminal DB-only result could not be persisted.

The marker separately records whether mutation was attempted, succeeded, or
ambiguous and retains any provider response, mutation-attempt, and verification
evidence. Readers may claim provider mutation success only when a compatible
success outcome, attempted true, succeeded true, and ambiguous false are all
explicitly present; sparse or contradictory marker evidence remains unknown.
The marker retains this evidence for reconciliation. It does not set success,
`provider_verified`, `verified_at`, terminal-finalization authority, or create an
immutable operator-action receipt. Every such pending row is treatment
ineligible, including the two outcomes that prove provider mutation success.
Same-key replay returns the non-retryable hold without a provider POST; a new
key for the same exact Ad is also blocked. Only exact reconciliation may
terminally finalize the attempt.

The lineage column is nullable only for additive migration compatibility.
Receipts created before the field existed keep their original hash payload,
which omitted `verificationLineage`, and remain readable with
`verification_lineage = NULL`; readers must not synthesize missing parents or
reinterpret that null as new live proof. New provider-verified status
finalization writes the complete non-null lineage. These controls harden
execution only; they do not change D061/D063 resolver math or grant automatic
execution.

Reason: an exact decision can still mutate the wrong object if current provider
identity is assumed from a warehouse row, if a bulk loop begins before all
targets are checked, or if an ambiguous create POST is silently retried without
provider idempotency. Conversely, hiding all writes behind one generic
“manual” branch erases the authority boundary needed for future automation.
Explicit origins plus exact live proof preserve today’s operator safety while
leaving a verifiable path to later automatic Meta execution.

## D066 - Decision-Fact Ownership And Replay Restatements Must Be Explicit

Decision: presentation enrichment, peer calibration, strict economic evidence,
and release replay are four distinct authority lanes. Every daily-fact writer,
including authoritative insights sync, must explicitly declare
`writeMode: "authoritative_fact"`; omitted or unknown authority fails closed.
Missing
provenance may not silently turn presentation enrichment into a fact mutation
or turn projection drift into a safe-restatement classification.

`meta_ad_daily` remains decision-fact storage owned only by authoritative
insights sync. Creatives metadata sync writes dedicated creative daily,
dimension, and media presentation storage and performs zero
`meta_ad_daily` writes. The former `writeMode: "creative_enrichment"` lane
fails closed because even a presentation-looking Ad-name change alters the
canonical input hash while leaving an old row cutoff-visible. Unknown and
non-authoritative daily-fact write modes fail before mutation. The
default authoritative mode retains its existing fact, reference, dimension,
insert, and truth-version semantics, but recursively removes creative-media,
preview, and media-debug payload keys before persisting `payload_json`;
economic metrics and other decision evidence remain intact. Creative-media
retention cleanup is not a second decision-fact owner: its readiness scope
excludes `meta_ad_daily`, it never updates or deletes an Ad-day or its
timestamps, and it reports zero Ad-day updates while pruning only dedicated
media/presentation storage. A real PostgreSQL seam must prove both sides
byte-for-byte; a mocked SQL-shape test is not sufficient release proof.

Calibration keeps two explicit read lanes. Peer observation eligibility uses
the retained exact-hierarchy `FINALIZED`/`PASSED` contract plus cutoff-safe
created/updated timestamps; a null legacy Ad `finalized_at` is measured in
quality counts but does not censor that otherwise-valid peer Ad. Strict
physical-account AOV, source currency, and source timezone evidence additionally
requires a non-null cutoff-safe Ad `finalized_at`. Neither lane may borrow
authority from the other.

The current-day baseline/challenger replay is a proof tool, not a second
decision engine. Both ready and soft-only projections must be reproduced by the
production native resolver, and the projected tuple, resolved decision input,
and resolved campaign-context provenance must each match their stored proof
hash exactly. Replay accepts only three explicit safe calibration classes. Two
are `profile_availability_restatement` forward directions:

- a production-ready profile changes a collecting `Test More` to `Keep` solely
  because calibration-only profile evidence matured; or
- the precise native-calibration-missing soft profile becomes an ordinary
  non-hard Keep/Test More profile with zero hard-action eligibility on both
  profiles.

Both availability directions require unchanged exact identity/input/data
health/campaign context, production-reproduced projections, and no hard label,
`cut_candidate`, or pending-transition artifact.

The third is `calibration_restatement`: both sides remain ordinary non-hard
Keep/Test More projections with the same complete action-semantic tuple, and
only calibration-profile evidence changes. It additionally requires null
authority blocker, blocked action, and authorization, with no hysteresis. Both
its baseline and challenger projection/input/context envelopes must match their
hash-bound production reproduction exactly. Any reason or badge difference
must itself be the production resolver's deterministic output from that
calibration-only evidence change. Reverse availability loss, hybrid ready/soft
shape, arbitrary label/reason/context change, identity or data-health drift, or
any unproven hard-action opening is semantic drift and fails the release gate.

The release gate covers the four requested physical accounts and the complete
active+enabled Meta-bound scheduler population in one SELECT-only,
`REPEATABLE READ READ ONLY` snapshot. Compact retained artifacts bind the
omitted full rows, the exact repository-content manifest, the replay source
files, and an adjacent SHA-256 checksum. The replay never calls cron, writes the
database or a provider, grants provider execution, or replaces the required
post-deploy natural scheduler-wave verification.

Reason: the Creatives metadata path previously looked like a normal daily-fact
upsert and could create or overwrite rows that calibration interpreted as
economic truth. Separately, a broad replay label could hide a real projection
change as harmless availability drift. Explicit ownership plus byte-level
database and production-envelope proofs remove both ambiguity classes without
changing D061/D063 resolver math or creating a new decision core.

## D067 - Manual Meta Status Ambiguity Uses An Append-Only Attempt Journal And Exact-State Reconciliation

Decision: direct and bulk execute-mode manual pause/resume routes use one
provider-generic recovery state machine. Every new manual claim persists its
exact business, physical account, Ad, creative, campaign, and ad-set target and
declares `meta-manual-ad-status-mutation-attempt.v1`. Immediately before the
single provider POST, the write adapter completes its fresh hierarchy, status,
policy, and write-block checks, then calls the route's pre-mutation hook with
the exact business/account/Ad/creative/campaign/ad-set baseline. The hook must
equal that baseline to the durable target before it appends an immutable
`attempt_started` event under the shared exact-Ad advisory lock. The event
binds the source action log, target hierarchy, action, slashless Ad path, start
time, and two-minute lease. Baseline drift, an adapter-side precondition stop,
or failure to persist that start forbids provider mutation and uses an exact
DB-only no-attempt terminal proof.

A received provider result appends one immutable `attempt_completed` event
before the action log may become terminal. Completion binds the exact
one-attempt/no-automatic-retry receipt and classifies only verified success,
successful response with failed verification, definite provider failure, or
ambiguous provider outcome. A raw unexpected throw after start may leave the
source pending with only that start event. This is deliberate: the system
records known attempt authority without fabricating a response, completion, or
second provider call. Attempt events are append-only and evidence-hashed;
idempotence accepts only the same normalized fact. Store and database trigger
both require the start target to equal the source claim's durable
`manual_status_mutation_target`. Once a reconciliation event exists, every late
start or completion against the historical source is rejected. Event creation
time is database-canonical and cannot be caller-backdated. Completed-attempt
reconciliation evidence must be observed at or after the durable completion
event; an old provider observation cannot be rebased onto newer authority.

Journal-required live status logs also have a database-enforced terminal gate.
Success requires the exact verified-success completion; `silent_failure`
requires ambiguous or provider-success/verification-failed completion; definite
provider rejection requires its exact completion. A pre-provider failure may
terminalize without an attempt only through the closed post-claim preflight,
attempt-start persistence, adapter pre-provider abort, or bulk pre-provider
abort non-mutation proof shapes. Generic action-log completion is not an
alternate write path. Source identity, journal contract/target, terminal fact,
and attempt/reconciliation events are immutable after their allowed transition;
the database trigger protects the envelope on every update, including updates
to already-terminal rows.

The next direct or bulk live status request runs reconciliation before any new
claim or provider write. It performs no provider GET until the source-specific
provider-generic settlement floor has elapsed:

- five minutes after an immutable completion;
- the two-minute started-at lease plus five minutes for a started-only source;
- five minutes after claim creation for a new journal-contract row whose start
  could not be persisted; or
- seven days after the latest requested, updated, or verified timestamp for a
  pre-contract `silent_failure` that lacks physical-account identity.

The legacy lane additionally requires one exact database-resolved provider
account, creative, campaign, and ad-set hierarchy. It is a temporary
contract-compatibility quarantine, not a firm-specific exception.

After settlement, the route performs one bounded exact-state provider read
sequence. The observation must match business, physical account, Ad, creative,
campaign, ad set, configured/effective status, active parent statuses, and
policy eligibility. The shared advisory key is then reacquired; source
authority and lineage are revalidated, and one immutable
`meta-manual-ad-status-reconciliation.v1` event captures the unmodified provider
GET evidence and evidence hash. Only two resolutions exist:
`current_state_matches_requested` and
`current_state_matches_precondition`. Neither resolution rewrites the
historical source row or claims that the old provider mutation succeeded. A
post-append reread must prove the blocker is gone. Missing, multiple,
contradictory, stale, ineligible, or persistence-uncertain evidence fails
closed and authorizes zero provider POSTs.

If the newly requested desired state equals the reconciled exact
configured/effective state, the route returns a verified no-op and creates no
new mutation claim. Otherwise it creates a fresh exact claim and repeats the
post-claim provider preflight plus journal contract. The same algorithm applies
to every business. No manual provider mutation, mutable overwrite,
timeout-only deletion, or business-specific bypass clears ambiguity.

The initial bulk gate still claims and rechecks every target before the first
provider POST. Because a large batch can outlive the no-attempt settlement
floor, each manual item additionally performs a fresh exact-state and
unresolved-owner check immediately before its own POST. A source reconciled or
replaced while an earlier item was executing cannot append a late start or
issue another POST. Current and later items stop, while earlier completed items
retain their truthful terminal results. Once any item halts, every untouched
later prepared claim is terminalized with an exact DB-only bulk-abort proof;
failure to persist that cleanup upgrades the response to
reconciliation-required 503 instead of leaving hidden pending work.

Manual provider success is not inferred from a configured status alone. The
adapter records a complete execution-state baseline immediately before the sole
POST and a fresh complete observation afterward. The canonical
`meta-ad-status-write-verification.v1` proof requires unchanged physical
account, Ad, creative, campaign, and ad-set identity; requested configured and
effective Ad status; ACTIVE configured/effective parent statuses; policy
eligibility; null review blocker; observation time; and raw provider GET
evidence. Store validation and the database completion trigger bind the proof
to the immutable attempt target and action. Missing evidence, hierarchy drift,
effective-status drift, or policy/review state cannot become verified success.
All reads and the one POST are 30-second bounded; mutation fetches reject HTTP
redirects so a 307/308 cannot transparently replay the POST. The mutation is
never retried. Terminal retry attempts reuse one frozen duration and identical
normalized fact, so a lost commit acknowledgement cannot manufacture a
different terminal outcome.

Reason: D065 correctly made ambiguous live manual outcomes non-retryable, but an
indefinite blocker without durable attempt geometry or an executable generic
reconciliation path could permanently stop both operators and native
automation. An append-only start/completion journal distinguishes no-attempt,
started-only, completed, and legacy sources. A delayed exact-state observation
then clears only what current provider truth proves, while preserving the
historical failure fact and preventing duplicate writes. This changes provider
write recovery only; it does not alter D061/D063 decision math or create a new
decision core.

## D068 - Natural Native-Ad Waves Require A Separate Current-Epoch Operational Proof

Decision: the rollback-anchor AOV replay remains a baseline/challenger formula
proof and must not be reinterpreted as post-deploy scheduler evidence. An epoch
cutover can legitimately leave no same-day rollback anchor. The natural-wave
release gate therefore uses a separate persisted-state verifier after the
first post-deploy 03:00 UTC wave. It reproduces the scheduler's complete
active, enabled, Meta-bound population; requires the current native epoch; and
proves terminal calibration, decisions, and operator jobs, exact chronology,
dependency, counts, receipts, manifests, authority, and lineage.

Decision job `row_count` equals snapshot and evaluation counts. Evaluation
contexts remain intentionally shared by exact scope/hash, so context coverage
is `context_count = distinct referenced context_count` with no orphan rows,
not `context_count = job.row_count`. Calibration may reuse an exact complete
same-day/current-epoch batch from an earlier successful run; the selected job
still binds every batch receipt and expected cell, while `rows_written` counts
only batches owned by that selected run.

Hydration job metadata retains the full source receipt needed to recompute an
authoritative zero- or nonzero-Ad manifest: decision cutoff, source
observation/capture times, source run and payload hashes, source expected and
persisted counts, and source/hydration completeness. The verifier runs only
through the existing local tunnel in an explicit repeatable-read, read-only
transaction with a 30-second statement timeout and rollback. Its JSON and
checksum stay under `/tmp`; it never triggers cron, writes a provider or
database, changes resolver math, or advances main after deploy.

Reason: formula parity and actual scheduler execution answer different
questions. Keeping their anchors and artifacts separate prevents a missing
rollback epoch, deduplicated context, reused calibration batch, or zero-Ad
receipt from being misreported as either a release failure or proof that does
not exist.

## D069 - Unresolved Manual Duplicate Outcomes Remain Retry-Blocking

Decision: a non-dry manual duplicate for the same business, source Ad, and
physical provider account and target ad set is acquired under an exact
transaction-scoped advisory lock. The unresolved-row read and pending insert
are one database transaction; the provider call remains outside it. A live
`pending` row, a `silent_failure` without a resulting Ad, and a pre-contract
legacy `failure` that lacks the complete current journal/account authority
remain blocking without the normal deduplication-window expiry because their
provider outcome has never been reconciled. This legacy quarantine is required
because older duplicate handling could classify an ID-less or otherwise
unproven provider response as `failure`. A known resulting Ad returns the
existing duplicate conflict. An ambiguous or verification-failed outcome
without a resulting Ad returns reconciliation-required with
`retryAllowed=false`. Current-contract journaled definite rejections remain
retryable. Dry runs are excluded using both the durable flag and legacy nested
request evidence.

Terminal persistence uses a bounded identical retry. If a live adapter exits
without exact outcome proof, or a provider result cannot be terminalized, the
pending claim is preserved and must never be rewritten to a retryable generic
failure. New duplicate logs persist the exact physical provider account.

Every non-dry duplicate claim also declares
`meta-manual-ad-duplicate-attempt.v1` and writes an immutable preparation event
before the provider boundary. Immediately before the one allowed create POST,
the adapter appends one exact start event. A second start for the same attempt
is rejected rather than treated as permission to POST again. A received result
may append one byte-equivalent completion fact; a conflicting replay is
rejected. Preparation, start, completion, reconciliation, and provider-read
observation journals are append-only, evidence-hashed, and bound by database
triggers to the original business, physical account, source Ad and creative,
target ad set, canonical marker-bearing name, requested PAUSED status, and
single-POST receipt.

Duplicate-create finality is deliberately narrower than generic status
mutation handling. A network exception, HTTP 408/425/429, any 5xx, a transient
or retryable Meta error, and a successful HTTP response without an exact new Ad
identity are ambiguous external action results because none proves that Meta
did not create the Ad. They retain a retry-blocking unresolved claim. The
immutable mutation receipt still records the literal transport/HTTP fact: for
example, a received successful 2xx is
`provider_response_received` even when its missing result identity makes the
action `provider_response_succeeded_verification_failed`. Only an exact
structured, non-transient and non-retryable 4xx provider rejection may
terminalize as a definite failure. “Non-transient” means the provider payload
contains the literal JSON boolean `is_transient: false`; a missing, null, or
string value is ambiguous. For an unverified successful 2xx, a nonblank
top-level provider response id must exactly equal the durable resulting Ad id;
if the response id is absent or blank, the durable resulting id must be null.
The database enforces the corresponding layered geometry and never accepts a
429, 5xx, identity-less 2xx, response/result-id contradiction, or transport
exception as authority to release the claim. Provider payloads, verification
evidence, transport diagnostics, and reconciliation evidence are recursively
redacted before persistence. The adapter never follows a create-POST redirect
and never retries the POST.

The natural scheduler runs a provider-GET-only reconciliation sweep for
settled unresolved duplicate attempts. A preparation whose lease expires
without any durable start event has exact no-provider-attempt authority and may
terminalize as a pre-provider failure. Started-only, ambiguous, and
success-response/verification-failed attempts remain quarantined until current
provider evidence proves the exact marker, canonical name, physical account,
target ad set, source creative, and PAUSED status. A known result id uses an
exact point GET. If the result id was lost, the sweep traverses the physical
account Ads edge using a token-free opaque cursor checkpoint. Each segment is
append-only and chained to the prior durable segment with cycle, ordinal,
cursor-hash, page-count, observation-count, and cumulative exact-match
authority. A partial segment can never terminalize success: only a complete
cycle with exactly one cumulative match followed by an exact point GET can do
so. Zero matches, multiple matches, malformed/cyclic pagination, identity
drift, missing credentials, incomplete reads, or persistence uncertainty keep
the claim unresolved. In particular, even a complete zero-match scan is an
observation, not negative provider finality.

The sweep is generic across businesses, sequential, backoff-scheduled, and
fair to previously unobserved and oldest-observed candidates. It has one
bounded provider-read admission deadline, checks it before every new candidate
and point/scan GET, and propagates the positive remaining budget through actual
abort signals. Database and integration work retain their independent runtime
timeouts; no timer race leaves a provider read running in the background. Sweep
failure is reported but cannot fail unrelated scheduler work. Rollback is the
normal exact-SHA application rollback: removing the scheduler invocation stops
new automatic reads, while the append-only journal and unresolved claims
remain fail-closed. The migrated database rejects a pre-contract live manual
duplicate insert before provider work, so rolling back to an older application
disables that write surface rather than letting old code bypass the journal;
only the current canonical non-mutating dry-run envelope is exempt, and an
older pre-contract dry-run may also fail closed. The same schema guard rejects
an UPDATE that tries to create or reshape a contractless live manual duplicate
envelope, so changing an ordinary or legacy action row cannot bypass the
insert-time contract. Rollback must not delete journal rows, clear claims
manually, disable this compatibility guard, or introduce a business-specific
bypass.

Reason: an ambiguous transport result can mean Meta created the Ad even though
the response ID was lost. A client-only `retryAllowed=false` flag does not
prevent a concurrent or later request from issuing a second POST. The atomic
durable claim, exact HTTP classification, and bounded GET-only recovery close
that gap generically without claiming provider success, auto-retrying the
provider, changing native decision math, or adding a business-specific
exception.

## D070 - The Decision As-Of Date Is Scoped By Creative Account Keys

Decision: `resolveWorkspaceEndDate` in `app/api/meta/decisions-workspace/route.ts`
scopes its `engine_v3_decision_snapshots_daily` lookup by the
`creative_account_keys` → `creative_account_scope` join that
`lib/meta/history-read-model.ts` already treats as canonical, instead of by a
`provider_account_id` column that table does not declare. A creative observed
under more than one provider account is excluded by
`HAVING COUNT(DISTINCT provider_account_id) = 1` rather than attributed to one
of them arbitrarily. The `engine_v3_ad_decision_snapshots_daily` and
`engine_v3_job_runs` branches are unchanged; they already filter on columns
their tables have. The `previousUtcDate()` fallback stays for the
genuinely-absent-data case, together with the cause classification that makes a
fallback visible instead of silent.

Reason: the previous predicate raised `42703 undefined_column` on every call.
Because the broken branch sat in a `UNION ALL` with two branches that would have
worked, the error took those down with it, and a bare `catch {}` reported the
failure as a schema/capability gate. The resolver therefore always fell through
to yesterday, so whenever the newest snapshot was not exactly yesterday the
workspace asked for a day with no rows and the operator saw empty lanes with no
error — a failed read collapsing into "no data", which INVARIANTS forbids. It is
also the direct cause of the full-UI visual gate failing at baseline (G0-F2).

Scope limit: this is a date lookup, not decision content. D013 date-range replay
semantics are unchanged and `metricsRangeAffectsDecisionSnapshot` stays `false`.
No decision label, authority, risk tier or provider eligibility is affected, and
no new decision core is introduced. Where the newest snapshot already is
yesterday — the healthy case — nothing changes; elsewhere, lanes that were
silently empty populate.

Rollback: a one-line revert of the predicate. No migration, and no persisted
state changes.

Provenance: drafted 2026-08-08 as
`docs/creative-decision-center/ADR-D070-DECISION-AS-OF-SCOPE.md` (long-form
rationale, relates to D013 and findings G0-F2/G0-F3); ratified into this log
2026-08-22 under WP0 of `docs/meta-market-ready-master-plan-2026-08-22.md`. The
predicate was already implemented in the tree at HEAD `843b6e9c8`, so
ratification changes standing, not behaviour: it stops an ADR marked `Proposed`
from being cited as settled authority.
