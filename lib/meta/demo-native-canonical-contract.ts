import { createHash } from "node:crypto";
import type { DecisionLabel, TruthSource } from "@/lib/creative-decision-engine/types";
import type {
  MetaDecisionCreativeAssessment,
  MetaDecisionAuthorityBlocker,
  MetaDecisionExecutionAction,
  MetaDecisionLifecycleRole,
  MetaDecisionServedBuyerAction,
  MetaDecisionState,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";

export const DEMO_NATIVE_CANONICAL_FIXTURE_CONTRACT_VERSION =
  "adsecute.demo-native-canonical-fixture.v1" as const;

export interface DemoNativeCanonicalFixtureItem {
  adId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
  sourceLabel: DecisionLabel;
  preAuthorityLabel: DecisionLabel;
  authorityBlocker: MetaDecisionAuthorityBlocker | null;
  rawLabel: DecisionLabel;
  reason: string;
  confidence: number;
  truthSource: TruthSource;
  badges: string[];
  effectiveTargetRoas: number;
  ratioToTarget: number | null;
  spend: number;
  purchases: number;
  roas: number | null;
  recent7dRoas: number | null;
  currency: string;
  lifecycleRole: MetaDecisionLifecycleRole;
  assessment: MetaDecisionCreativeAssessment;
  decisionState: MetaDecisionState;
  heldAction: "scale" | "cut" | "refresh" | null;
  buyerAction: MetaDecisionServedBuyerAction | null;
  buyerLabel: string;
  executionAction: MetaDecisionExecutionAction | null;
  blockerCodes: string[];
  decisionHash: string;
}

export interface DemoNativeCanonicalFixture {
  contractVersion: typeof DEMO_NATIVE_CANONICAL_FIXTURE_CONTRACT_VERSION;
  businessId: string;
  providerAccountId: string;
  providerAccountRefId: string;
  asOfDate: string;
  computedAt: string;
  engineVersion: string;
  jobRunId: string;
  sourceInputHash: string;
  manifestHash: string;
  expectedAdCount: number;
  items: DemoNativeCanonicalFixtureItem[];
}

export type DemoNativeCanonicalFixtureDraftItem = Omit<
  DemoNativeCanonicalFixtureItem,
  "decisionHash"
>;

const DECISION_LABELS = new Set<DecisionLabel>([
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
]);

const TRUTH_SOURCES = new Set<TruthSource>([
  "commercial_truth",
  "commercial_truth_stale",
  "account_baseline",
  "account_baseline_thin",
  "global_default",
]);

const AUTHORITY_BLOCKERS = new Set<MetaDecisionAuthorityBlocker>([
  "profile_hard_action_ineligible",
  "source_freshness",
  "campaign_context",
  "native_metrics_unavailable",
  "native_profile_unavailable",
  "recent_recovery_unverifiable",
]);

const LIFECYCLE_ROLES = new Set<MetaDecisionLifecycleRole>([
  "test",
  "main",
  "mixed",
  "label_needed",
]);

const ASSESSMENTS = new Set<MetaDecisionCreativeAssessment>([
  "proven_winner",
  "above_target_not_scale_ready",
  "fatigued_former_winner",
  "below_target",
  "learning",
  "stable",
  "refresh_candidate",
  "funnel_bottleneck",
  "decision_blocked",
  "evidence_incomplete",
  "out_of_scope",
  "cant_assess",
]);

const DECISION_STATES = new Set<MetaDecisionState>([
  "act",
  "monitor",
  "blocked",
  "not_applicable",
]);

const HELD_ACTIONS = new Set(["scale", "cut", "refresh"] as const);

const BUYER_ACTIONS = new Set<MetaDecisionServedBuyerAction>([
  "scale",
  "cut",
  "refresh",
  "protect",
  "test_more",
  "watch_launch",
  "fix_delivery",
  "fix_policy",
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableDemoFixtureJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function scalar(value: unknown) {
  return value === undefined ? null : value;
}

export function demoNativeFixtureInputManifest(
  providerAccountId: string,
  rows: readonly MetaCreativeApiRow[],
) {
  return {
    providerAccountId,
    rows: [...rows]
      .map((row) => ({
        adId: scalar(row.real_ad_id),
        creativeId: scalar(row.creative_id),
        accountId: scalar(row.account_id),
        accountName: scalar(row.account_name),
        campaignId: scalar(row.campaign_id),
        campaignName: scalar(row.campaign_name),
        adsetId: scalar(row.adset_id),
        adsetName: scalar(row.adset_name),
        name: scalar(row.name),
        effectiveStatus: scalar(row.effective_status),
        objective: scalar(row.objective),
        optimizationGoal: scalar(row.optimization_goal),
        currency: scalar(row.currency),
        launchDate: scalar(row.launch_date),
        spend: scalar(row.spend),
        purchaseValue: scalar(row.purchase_value),
        purchases: scalar(row.purchases),
        roas: scalar(row.roas),
        cpa: scalar(row.cpa),
        cpm: scalar(row.cpm),
        impressions: scalar(row.impressions),
        linkClicks: scalar(row.link_clicks),
        landingPageViews: scalar(row.landing_page_views),
        addToCart: scalar(row.add_to_cart),
        initiateCheckout: scalar(row.initiate_checkout),
        ctrAll: scalar(row.ctr_all),
        frequency: scalar(row.frequency),
        thumbstop: scalar(row.thumbstop),
        video25: scalar(row.video25),
        video50: scalar(row.video50),
        video75: scalar(row.video75),
        video100: scalar(row.video100),
        format: scalar(row.format),
        thumbnailUrl: scalar(row.thumbnail_url),
        imageUrl: scalar(row.image_url),
        cardPreviewUrl: scalar(row.card_preview_url),
      }))
      .sort((left, right) =>
        String(left.adId ?? "").localeCompare(String(right.adId ?? "")),
      ),
  };
}

export function demoNativeFixtureInputHash(
  providerAccountId: string,
  rows: readonly MetaCreativeApiRow[],
) {
  return sha256(
    stableDemoFixtureJson(
      demoNativeFixtureInputManifest(providerAccountId, rows),
    ),
  );
}

function canonicalDemoFixtureRatioToTarget(value: number | null) {
  if (value === null || !Number.isFinite(value)) return value;
  if (Object.is(value, -0)) return 0;
  // This is a derived demo-only ratio. Canonicalizing it at the fixture/hash
  // boundary avoids platform-specific JSON-loader rounding without weakening
  // the exact source-input hash or changing production decision math.
  return Number(value.toPrecision(15));
}

export function demoNativeFixtureItemHash(
  item:
    | DemoNativeCanonicalFixtureDraftItem
    | DemoNativeCanonicalFixtureItem,
) {
  const { decisionHash: _decisionHash, ...payload } =
    item as DemoNativeCanonicalFixtureItem;
  return sha256(
    stableDemoFixtureJson({
      ...payload,
      ratioToTarget: canonicalDemoFixtureRatioToTarget(
        payload.ratioToTarget,
      ),
    }),
  );
}

export function demoNativeFixtureManifestHash(
  fixture: Omit<DemoNativeCanonicalFixture, "manifestHash"> | DemoNativeCanonicalFixture,
) {
  const { manifestHash: _manifestHash, ...payload } =
    fixture as DemoNativeCanonicalFixture;
  return sha256(stableDemoFixtureJson(payload));
}

export function finalizeDemoNativeCanonicalFixture(input: {
  businessId: string;
  providerAccountId: string;
  providerAccountRefId: string;
  asOfDate: string;
  computedAt: string;
  engineVersion: string;
  jobRunId: string;
  rows: readonly MetaCreativeApiRow[];
  items: readonly DemoNativeCanonicalFixtureDraftItem[];
}): DemoNativeCanonicalFixture {
  const items = [...input.items]
    .map((item) => {
      const canonicalItem = {
        ...item,
        ratioToTarget: canonicalDemoFixtureRatioToTarget(
          item.ratioToTarget,
        ),
      };
      return {
        ...canonicalItem,
        decisionHash: demoNativeFixtureItemHash(canonicalItem),
      };
    })
    .sort((left, right) => left.adId.localeCompare(right.adId));
  const withoutManifest: Omit<DemoNativeCanonicalFixture, "manifestHash"> = {
    contractVersion: DEMO_NATIVE_CANONICAL_FIXTURE_CONTRACT_VERSION,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    providerAccountRefId: input.providerAccountRefId,
    asOfDate: input.asOfDate,
    computedAt: input.computedAt,
    engineVersion: input.engineVersion,
    jobRunId: input.jobRunId,
    sourceInputHash: demoNativeFixtureInputHash(
      input.providerAccountId,
      input.rows,
    ),
    expectedAdCount: items.length,
    items,
  };
  return {
    ...withoutManifest,
    manifestHash: demoNativeFixtureManifestHash(withoutManifest),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableFiniteNumber(value: unknown) {
  return value === null || finiteNumber(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validDateOnly(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function sha256Text(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validDemoItemSemantics(item: DemoNativeCanonicalFixtureItem) {
  // Demo inventory is review evidence. It never carries an execution CTA,
  // even when the underlying canonical verdict is Scale, Cut, or Refresh.
  if (item.executionAction !== null) return false;

  if (item.heldAction !== null) {
    const expectedAssessment =
      item.heldAction === "cut"
        ? "below_target"
        : item.heldAction === "scale"
          ? "above_target_not_scale_ready"
          : "refresh_candidate";
    return (
      item.decisionState === "blocked" &&
      item.buyerAction === null &&
      item.assessment === expectedAssessment &&
      (item.preAuthorityLabel === item.heldAction ||
        item.rawLabel === item.heldAction)
    );
  }

  switch (item.sourceLabel) {
    case "scale":
      /*
        Mirrors `projectMetaDecisionSemantics` in lib/meta/decision-semantics.ts,
        which now serves a Scale as `act` for every RESOLVED campaign role —
        `main` included — and keeps only an unresolved role on `monitor`. This
        clause used to hard-code test/mixed and would have rejected the demo
        fixture's own Main-campaign Scale rows as invalid.
      */
      return (
        item.decisionState ===
          (item.lifecycleRole === "test" ||
          item.lifecycleRole === "main" ||
          item.lifecycleRole === "mixed"
            ? "act"
            : "monitor") &&
        item.buyerAction === "scale" &&
        item.assessment === "proven_winner"
      );
    case "cut":
      return (
        item.decisionState === "act" &&
        item.buyerAction === "cut" &&
        item.assessment === "below_target"
      );
    case "refresh":
      return (
        item.decisionState === "act" &&
        item.buyerAction === "refresh" &&
        (item.assessment === "refresh_candidate" ||
          item.assessment === "fatigued_former_winner")
      );
    case "keep":
      return (
        item.decisionState === "monitor" &&
        item.buyerAction === "protect" &&
        (item.assessment === "stable" ||
          item.assessment === "above_target_not_scale_ready" ||
          item.assessment === "funnel_bottleneck")
      );
    case "test_more":
      return (
        item.decisionState === "monitor" &&
        item.buyerAction === "test_more" &&
        item.assessment === "learning"
      );
    case "diagnose":
      return (
        item.decisionState === "blocked" &&
        item.buyerAction === null &&
        (item.assessment === "decision_blocked" ||
          item.assessment === "evidence_incomplete" ||
          item.assessment === "funnel_bottleneck")
      );
    case "out_of_scope":
      return (
        item.decisionState === "not_applicable" &&
        item.buyerAction === null &&
        item.assessment === "out_of_scope"
      );
  }
  return false;
}

type DemoNativeCanonicalFixtureValidation =
  | { ok: true; fixture: DemoNativeCanonicalFixture }
  | { ok: false; reason: string };

function validateDemoNativeCanonicalFixtureUnsafe(input: {
  fixture: unknown;
  businessId: string;
  providerAccountId: string;
  engineVersion: string;
  rows: readonly MetaCreativeApiRow[];
}): DemoNativeCanonicalFixtureValidation {
  if (!record(input.fixture)) {
    return { ok: false, reason: "demo_fixture_not_an_object" };
  }
  const fixture = input.fixture as unknown as DemoNativeCanonicalFixture;
  if (
    fixture.contractVersion !==
      DEMO_NATIVE_CANONICAL_FIXTURE_CONTRACT_VERSION ||
    fixture.businessId !== input.businessId ||
    fixture.providerAccountId !== input.providerAccountId ||
    fixture.engineVersion !== input.engineVersion ||
    !nonEmptyString(fixture.providerAccountRefId) ||
    !nonEmptyString(fixture.jobRunId) ||
    !validDateOnly(fixture.asOfDate) ||
    typeof fixture.computedAt !== "string" ||
    !Number.isFinite(Date.parse(fixture.computedAt))
  ) {
    return { ok: false, reason: "demo_fixture_scope_or_epoch_mismatch" };
  }
  if (
    !Array.isArray(input.rows) ||
    !Array.isArray(fixture.items) ||
    !Number.isSafeInteger(fixture.expectedAdCount) ||
    fixture.expectedAdCount < 0 ||
    fixture.expectedAdCount !== fixture.items.length ||
    fixture.items.length !== input.rows.length
  ) {
    return { ok: false, reason: "demo_fixture_count_mismatch" };
  }
  const rowsByAdId = new Map<string, MetaCreativeApiRow>();
  for (const candidate of input.rows) {
    if (!record(candidate)) {
      return { ok: false, reason: "demo_fixture_input_hash_mismatch" };
    }
    const adId = candidate.real_ad_id;
    if (!nonEmptyString(adId)) {
      return { ok: false, reason: "demo_fixture_input_hash_mismatch" };
    }
    const row = candidate as unknown as MetaCreativeApiRow;
    if (rowsByAdId.has(adId)) {
      return { ok: false, reason: "demo_fixture_item_invalid" };
    }
    rowsByAdId.set(adId, row);
  }
  const expectedInputHash = demoNativeFixtureInputHash(
    input.providerAccountId,
    input.rows,
  );
  if (
    !sha256Text(fixture.sourceInputHash) ||
    fixture.sourceInputHash !== expectedInputHash
  ) {
    return { ok: false, reason: "demo_fixture_input_hash_mismatch" };
  }
  const seen = new Set<string>();
  for (const candidate of fixture.items) {
    if (!record(candidate)) {
      return { ok: false, reason: "demo_fixture_item_invalid" };
    }
    const item = candidate as unknown as DemoNativeCanonicalFixtureItem;
    const row = rowsByAdId.get(item.adId);
    if (
      !row ||
      seen.has(item.adId) ||
      !nonEmptyString(item.adId) ||
      !nonEmptyString(item.creativeId) ||
      !nonEmptyString(item.campaignId) ||
      !nonEmptyString(item.adsetId) ||
      item.creativeId !== row.creative_id ||
      item.campaignId !== row.campaign_id ||
      item.adsetId !== row.adset_id ||
      item.currency !== row.currency ||
      !nonEmptyString(item.reason) ||
      !nonEmptyString(item.currency) ||
      !nonEmptyString(item.buyerLabel) ||
      !DECISION_LABELS.has(item.sourceLabel) ||
      !DECISION_LABELS.has(item.preAuthorityLabel) ||
      !DECISION_LABELS.has(item.rawLabel) ||
      !TRUTH_SOURCES.has(item.truthSource) ||
      (item.authorityBlocker !== null &&
        !AUTHORITY_BLOCKERS.has(item.authorityBlocker)) ||
      !LIFECYCLE_ROLES.has(item.lifecycleRole) ||
      !ASSESSMENTS.has(item.assessment) ||
      !DECISION_STATES.has(item.decisionState) ||
      (item.heldAction !== null && !HELD_ACTIONS.has(item.heldAction)) ||
      (item.buyerAction !== null && !BUYER_ACTIONS.has(item.buyerAction)) ||
      !stringArray(item.badges) ||
      !stringArray(item.blockerCodes) ||
      !finiteNumber(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 100 ||
      !finiteNumber(item.effectiveTargetRoas) ||
      item.effectiveTargetRoas <= 0 ||
      !finiteNumber(item.spend) ||
      item.spend < 0 ||
      !finiteNumber(item.purchases) ||
      !Number.isSafeInteger(item.purchases) ||
      item.purchases < 0 ||
      !nullableFiniteNumber(item.ratioToTarget) ||
      !Object.is(
        item.ratioToTarget,
        canonicalDemoFixtureRatioToTarget(item.ratioToTarget),
      ) ||
      !nullableFiniteNumber(item.roas) ||
      !nullableFiniteNumber(item.recent7dRoas) ||
      !validDemoItemSemantics(item) ||
      !sha256Text(item.decisionHash) ||
      item.decisionHash !== demoNativeFixtureItemHash(item)
    ) {
      return { ok: false, reason: "demo_fixture_item_invalid" };
    }
    seen.add(item.adId);
  }
  if (
    !sha256Text(fixture.manifestHash) ||
    fixture.manifestHash !== demoNativeFixtureManifestHash(fixture)
  ) {
    return { ok: false, reason: "demo_fixture_manifest_hash_mismatch" };
  }
  return { ok: true, fixture };
}

export function validateDemoNativeCanonicalFixture(input: {
  fixture: unknown;
  businessId: string;
  providerAccountId: string;
  engineVersion: string;
  rows: readonly MetaCreativeApiRow[];
}): DemoNativeCanonicalFixtureValidation {
  try {
    return validateDemoNativeCanonicalFixtureUnsafe(input);
  } catch {
    return { ok: false, reason: "demo_fixture_invalid" };
  }
}
