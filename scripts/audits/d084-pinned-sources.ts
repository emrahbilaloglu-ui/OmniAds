/**
 * D084 r3 — the ONLY way this package reads evidence.
 *
 * WHY THIS FILE EXISTS. Correction 1 asserted that the pinned D080B artifact
 * did not retain the daily series and therefore opened a fresh repeatable-read
 * transaction for it. That premise was false and the assertion was never
 * checked against D080A: `d080.series` retains 165,042 UNFILTERED daily rows —
 * zero-spend rows included — across all six charter businesses and all seven
 * bindings, with `parent_campaign_id`, per-row budgets and status. The live
 * read produced 1,634 rows that D080A already supplied with identical values,
 * and 7 rows on 2026-04-22 that lie one day before D080A's retained floor for
 * that scope. Those 7 rows are missing retained evidence, not a reason to
 * re-read a warehouse.
 *
 * So r3 imports no database client, opens no transaction, and takes no wall
 * clock. Every fact is extracted deterministically from a pinned file whose
 * bytes are hashed before it is parsed. Time outside the pinned retention is
 * unsupported and says so.
 *
 * IMPORT SAFETY: no top-level side effects and no `@/lib/db` anywhere in this
 * module or its callers. A test asserts that statically.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Row = Record<string, unknown>;

export const D084_PINNED_SOURCES = [
  {
    key: "d079",
    path: "docs/audits/generated/commercial-anchor-counterfactual-2026-08-31.json",
    sha256: "33aad581fc578c863880cc2710428ed1c0500957ed986ba2b99c1cf0ab03f8f8",
    supplies: "persisted decision census and per-business currency (DESCRIPTIVE ONLY)",
  },
  {
    key: "d080a",
    path: "docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json",
    sha256: "d4a1898aba14bcb2a37ae60a335f207eb668df13d37619bdffb44330da4d7a69",
    supplies: "the complete unfiltered daily series, with parent lineage and budgets",
  },
  {
    key: "d080b",
    path: "docs/audits/generated/d080b-meta-budget-policy-simulation-2026-09-01.json",
    sha256: "b46e6aa80c75aec0ebc724f2b8fcc288cda611353e9924a85504d3e498d155df",
    supplies: "raw config states with both clocks, owner states, source clocks, transitions, blocker census, origins",
  },
  {
    key: "d081",
    path: "docs/audits/generated/d081-meta-budget-capability-foundations-2026-09-01.json",
    sha256: "5514023bbad12923651b1a59810bf1ce2684f4361cac8bfcb0148033bbb402b3",
    supplies: "provider write-capability findings",
  },
  {
    key: "d082",
    path: "docs/audits/generated/d082-meta-role-provenance-replay-2026-09-01.json",
    sha256: "bc4d06d0ea2b2e1ef22d8016e7f4a5191ad633657140564b21c3adb48480868e",
    supplies: "automatic role provenance",
  },
  {
    key: "d083",
    path: "docs/audits/generated/d083-meta-budget-fact-observation-2026-09-01.json",
    sha256: "0c437aed77ca47148c7af27b59e850a32561d9dc6e8d934e507de7491cf5e747",
    supplies: "budget-fact observation headline",
  },
  {
    key: "d084v1",
    path: "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.json",
    sha256: "af8f8a9e1ea7e609af067f42b51a2a7950ffede7b4479ed49ce77769af214584",
    supplies: "the already-frozen target-pack history, including the operation column",
  },
] as const;

export type PinnedSourceKey = (typeof D084_PINNED_SOURCES)[number]["key"];

export interface PinnedSourceCheck {
  key: string;
  path: string;
  expectedSha256: string;
  observedSha256: string;
  matches: boolean;
}

/** Hash every pinned source from disk. `readBytes` exists only for tests. */
export function checkPinnedSources(
  readBytes: (path: string) => Buffer = (p) => readFileSync(resolve(p)),
): PinnedSourceCheck[] {
  return D084_PINNED_SOURCES.map((source) => {
    const observed = createHash("sha256").update(readBytes(source.path)).digest("hex");
    return {
      key: source.key,
      path: source.path,
      expectedSha256: source.sha256,
      observedSha256: observed,
      matches: observed === source.sha256,
    };
  });
}

export type PinnedBundle = Record<PinnedSourceKey, Record<string, unknown>>;

/**
 * Parsed sources, keyed by the OBSERVED byte hashes of the whole set.
 *
 * The bytes are still read and hashed on every call — that is what makes the
 * file on disk root trust — but parsing ~68 MB of JSON for each of a suite's
 * verifications is pure waste. Any change to any byte changes the key and
 * misses the cache, so drift detection is exactly as strong as before.
 */
const parsedByFingerprint = new Map<string, PinnedBundle>();

/**
 * Load every pinned source, refusing to continue if a single byte drifted.
 * Root trust is the file on disk, never anything the artifact carries.
 */
export function loadPinnedSources(
  readBytes: (path: string) => Buffer = (p) => readFileSync(resolve(p)),
): PinnedBundle {
  const checks = checkPinnedSources(readBytes);
  const drifted = checks.filter((c) => !c.matches);
  if (drifted.length > 0) {
    throw new Error(
      `D084 refuses to assemble: pinned source drifted (${drifted.map((d) => d.key).join(", ")})`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(checks.map((c) => `${c.key}:${c.observedSha256}`).join("|"))
    .digest("hex");
  const cached = parsedByFingerprint.get(fingerprint);
  if (cached) return cached;
  const bundle = {} as PinnedBundle;
  for (const source of D084_PINNED_SOURCES) {
    bundle[source.key] = JSON.parse(readBytes(source.path).toString("utf8")) as Record<string, unknown>;
  }
  parsedByFingerprint.set(fingerprint, bundle);
  return bundle;
}

// ---------------------------------------------------------------------------
// Small coercions, shared so every extractor reads a value the same way
// ---------------------------------------------------------------------------

export function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function day(value: unknown): string | null {
  const raw = text(value);
  return raw === null ? null : raw.slice(0, 10);
}

// ---------------------------------------------------------------------------
// D080A — the complete daily series
// ---------------------------------------------------------------------------

export interface DailyRow {
  businessId: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
  /** Retained owner lineage. The only statement of which campaign owns a row. */
  parentCampaignId: string | null;
  date: string;
  status: string | null;
  accountCurrency: string | null;
  /** Provider RAW amount. Its currency exponent is NOT captured. */
  dailyBudgetRaw: number | null;
  lifetimeBudgetRaw: number | null;
  isBudgetMixed: boolean;
  spend: number;
  conversions: number;
  revenue: number;
  truthState: string | null;
}

export function extractDailySeries(bundle: PinnedBundle): DailyRow[] {
  const series = (bundle.d080a.series ?? {}) as Row;
  const columns = (series.columns ?? []) as string[];
  const rows = (series.rows ?? []) as unknown[][];
  const at = Object.fromEntries(columns.map((c, i) => [c, i])) as Record<string, number>;
  const required = [
    "business_id", "provider_account_id", "grain", "entity_id", "parent_campaign_id",
    "effective_date", "status", "account_currency", "daily_budget", "lifetime_budget",
    "is_budget_mixed", "spend", "conversions", "revenue", "truth_state",
  ];
  for (const column of required) {
    if (!(column in at)) throw new Error(`D080A series is missing the ${column} column`);
  }
  const out: DailyRow[] = [];
  for (const row of rows) {
    const date = day(row[at.effective_date!]);
    const businessId = text(row[at.business_id!]);
    const providerAccountId = text(row[at.provider_account_id!]);
    const grain = text(row[at.grain!]);
    const entityId = text(row[at.entity_id!]);
    if (date === null || businessId === null || providerAccountId === null || grain === null || entityId === null) {
      continue;
    }
    out.push({
      businessId,
      providerAccountId,
      grain,
      entityId,
      parentCampaignId: text(row[at.parent_campaign_id!]),
      date,
      status: text(row[at.status!]),
      accountCurrency: text(row[at.account_currency!]),
      dailyBudgetRaw: num(row[at.daily_budget!]),
      lifetimeBudgetRaw: num(row[at.lifetime_budget!]),
      isBudgetMixed: row[at.is_budget_mixed!] === true,
      spend: num(row[at.spend!]) ?? 0,
      conversions: num(row[at.conversions!]) ?? 0,
      revenue: num(row[at.revenue!]) ?? 0,
      truthState: text(row[at.truth_state!]),
    });
  }
  out.sort((a, b) =>
    [a.businessId, a.providerAccountId, a.grain, a.entityId, a.date]
      .join("|")
      .localeCompare([b.businessId, b.providerAccountId, b.grain, b.entityId, b.date].join("|")),
  );
  return out;
}

/**
 * Actual retained coverage per entity, from the pinned rows themselves.
 *
 * Support is decided against THIS, never against a requested extraction range.
 * r2 declared `deliveryWindow.to = 2026-09-03` from a 2026-09-01 extraction, so
 * two future days could be reported as supported.
 */
export interface RetentionBounds {
  firstRetainedDate: string;
  lastRetainedDate: string;
  retainedDays: number;
}

export function retentionByEntity(rows: readonly DailyRow[]): Map<string, RetentionBounds> {
  const out = new Map<string, RetentionBounds>();
  for (const row of rows) {
    const key = entityKey(row);
    const found = out.get(key);
    if (!found) {
      out.set(key, { firstRetainedDate: row.date, lastRetainedDate: row.date, retainedDays: 1 });
      continue;
    }
    if (row.date < found.firstRetainedDate) found.firstRetainedDate = row.date;
    if (row.date > found.lastRetainedDate) found.lastRetainedDate = row.date;
    found.retainedDays += 1;
  }
  return out;
}

export function entityKey(row: {
  businessId: string; providerAccountId: string; grain: string; entityId: string;
}): string {
  return [row.businessId, row.providerAccountId, row.grain, row.entityId].join("|");
}

// ---------------------------------------------------------------------------
// D080B — raw reads: config with BOTH clocks, owner states, source clocks
// ---------------------------------------------------------------------------

interface RawRead {
  planKey: string | null;
  source: string | null;
  lane: string | null;
  businessId: string | null;
  providerAccountId: string | null;
  grain: string | null;
  knowledgeTo: string | null;
  rows: Row[];
}

function rawReads(bundle: PinnedBundle): RawRead[] {
  const snapshot = (bundle.d080b.snapshot ?? {}) as Row;
  const reads = (snapshot.reads ?? {}) as Record<string, Row>;
  return Object.values(reads).map((r) => ({
    planKey: text(r.planKey),
    source: text(r.source),
    lane: text(r.lane),
    businessId: text(r.businessId),
    providerAccountId: text(r.providerAccountId),
    grain: text(r.grain),
    knowledgeTo: text(r.knowledgeTo),
    rows: ((r.rows ?? []) as Row[]),
  }));
}

export interface ConfigStateRow {
  businessId: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
  /** The effective clock. */
  effectiveFrom: string;
  /** The recorded clock. A PIT read needs BOTH. */
  capturedAt: string | null;
  configFingerprint: string | null;
  dailyBudgetRaw: number | null;
  lifetimeBudgetRaw: number | null;
  anyMixed: boolean;
  rawCaptures: number | null;
  distinctFingerprints: number | null;
  /** The read lane this row came from, preserved rather than flattened away. */
  lane: string | null;
  knowledgeTo: string | null;
}

export function extractConfigStates(bundle: PinnedBundle): ConfigStateRow[] {
  const out: ConfigStateRow[] = [];
  for (const read of rawReads(bundle)) {
    if (read.planKey !== "configStates") continue;
    if (read.businessId === null || read.providerAccountId === null || read.grain === null) continue;
    for (const row of read.rows) {
      const entityId = text(row.entity_id);
      const effectiveFrom = day(row.effective_from);
      if (entityId === null || effectiveFrom === null) continue;
      out.push({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        grain: read.grain,
        entityId,
        effectiveFrom,
        capturedAt: text(row.captured_at),
        configFingerprint: text(row.config_fingerprint),
        dailyBudgetRaw: num(row.daily_budget),
        lifetimeBudgetRaw: num(row.lifetime_budget),
        anyMixed: row.any_mixed === true,
        rawCaptures: num(row.raw_captures),
        distinctFingerprints: num(row.distinct_fingerprints),
        lane: read.lane,
        knowledgeTo: read.knowledgeTo,
      });
    }
  }
  out.sort((a, b) =>
    [a.businessId, a.providerAccountId, a.grain, a.entityId, a.effectiveFrom, a.capturedAt ?? ""]
      .join("|")
      .localeCompare(
        [b.businessId, b.providerAccountId, b.grain, b.entityId, b.effectiveFrom, b.capturedAt ?? ""].join("|"),
      ),
  );
  return out;
}

export interface OwnerStateRow {
  businessId: string;
  providerAccountId: string;
  entityType: string;
  entityId: string;
  campaignId: string | null;
  observedOn: string;
  capturedAt: string | null;
  /** The only retained statement of WHICH NODE owns the money. */
  budgetOrigin: string | null;
  budgetCurrency: string | null;
}

export function extractOwnerStates(bundle: PinnedBundle): OwnerStateRow[] {
  const out: OwnerStateRow[] = [];
  for (const read of rawReads(bundle)) {
    if (read.planKey !== "ownerStates") continue;
    if (read.businessId === null || read.providerAccountId === null) continue;
    for (const row of read.rows) {
      const entityType = text(row.entity_type);
      const entityId = text(row.entity_id);
      const observedOn = day(row.observed_on);
      if (entityType === null || entityId === null || observedOn === null) continue;
      out.push({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        entityType,
        entityId,
        campaignId: text(row.campaign_id),
        observedOn,
        capturedAt: text(row.captured_at),
        budgetOrigin: text(row.budget_origin),
        budgetCurrency: text(row.budget_currency),
      });
    }
  }
  out.sort((a, b) =>
    [a.businessId, a.providerAccountId, a.entityType, a.entityId, a.observedOn]
      .join("|")
      .localeCompare([b.businessId, b.providerAccountId, b.entityType, b.entityId, b.observedOn].join("|")),
  );
  return out;
}

/** Per-source retention, straight from D080B's own clock probes. */
export interface SourceClock {
  source: string;
  businessId: string | null;
  providerAccountId: string | null;
  earliestEffective: string | null;
  latestEffective: string | null;
  rows: number | null;
}

export function extractSourceClocks(bundle: PinnedBundle): SourceClock[] {
  const out: SourceClock[] = [];
  for (const read of rawReads(bundle)) {
    if (read.planKey !== "sourceClock") continue;
    for (const row of read.rows) {
      out.push({
        source: read.source ?? "unknown",
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        earliestEffective: day(row.earliest_effective),
        latestEffective: day(row.latest_effective),
        rows: num(row.rows),
      });
    }
  }
  out.sort((a, b) =>
    [a.source, a.businessId ?? "", a.providerAccountId ?? ""]
      .join("|")
      .localeCompare([b.source, b.businessId ?? "", b.providerAccountId ?? ""].join("|")),
  );
  return out;
}

export interface Binding {
  businessId: string;
  providerAccountId: string;
  isSelected: boolean;
}

export function extractBindings(bundle: PinnedBundle): Binding[] {
  const scope = (bundle.d080b.scope ?? {}) as Row;
  const pinned = (scope.pinnedBindings ?? []) as Row[];
  return pinned
    .map((b) => ({
      businessId: text(b.business_id) ?? "",
      providerAccountId: text(b.provider_account_id) ?? "",
      isSelected: b.is_selected === true,
    }))
    .filter((b) => b.businessId !== "" && b.providerAccountId !== "")
    .sort((a, b) =>
      [a.businessId, a.providerAccountId].join("|").localeCompare([b.businessId, b.providerAccountId].join("|")),
    );
}

export function extractAccountCurrency(bundle: PinnedBundle): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const read of rawReads(bundle)) {
    if (read.planKey !== "accountCurrency" || read.providerAccountId === null) continue;
    const currencies = read.rows.map((r) => text(r.account_currency)).filter((c): c is string => c !== null);
    const distinct = [...new Set(currencies)].sort((a, b) => a.localeCompare(b));
    // More than one currency for one account is not a currency; it is a gap.
    out[read.providerAccountId] = distinct.length === 1 ? distinct[0]! : null;
  }
  return out;
}

/** Resolved budget transitions — the candidate economic-event members. */
export interface TransitionRow {
  /**
   * The exact source ROW identity.
   *
   * D080B's own `key` is `account|grain|entity_id` — an ENTITY key. Two
   * transitions on one entity share it, so using it as a row identity silently
   * merges them: entity 120248078458330626 carries both a 2026-06-03 increase
   * and a 2026-08-04 decrease under one `key`. The row identity therefore
   * includes the transition's own clocks, and D080B's key is preserved beside
   * it rather than overloaded.
   */
  sourceRowKey: string;
  sourceEntityKey: string;
  businessId: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
  prevEffectiveFrom: string | null;
  effectiveFrom: string;
  direction: string;
  percent: number | null;
  semantics: string;
}

export function extractResolvedTransitions(bundle: PinnedBundle): TransitionRow[] {
  const rows = (bundle.d080b.observedTransitions ?? []) as Row[];
  return rows
    .filter((r) => text(r.semantics) === "resolved")
    .map((r) => ({
      sourceRowKey: [
        text(r.business_id) ?? "",
        text(r.provider_account_id) ?? "",
        text(r.grain) ?? "",
        text(r.entity_id) ?? "",
        day(r.prev_effective_from) ?? "",
        day(r.effective_from) ?? "",
      ].join("|"),
      sourceEntityKey: text(r.key) ?? "",
      businessId: text(r.business_id) ?? "",
      providerAccountId: text(r.provider_account_id) ?? "",
      grain: text(r.grain) ?? "",
      entityId: text(r.entity_id) ?? "",
      prevEffectiveFrom: day(r.prev_effective_from),
      effectiveFrom: day(r.effective_from) ?? "",
      direction: text(r.direction) ?? "",
      percent: num(r.percent),
      semantics: "resolved",
    }))
    .filter((r) => r.businessId !== "" && r.entityId !== "" && r.effectiveFrom !== "")
    .sort((a, b) => a.sourceRowKey.localeCompare(b.sourceRowKey));
}

export function extractBlockerRanking(bundle: PinnedBundle): Row[] {
  const measurements = (bundle.d080b.measurements ?? {}) as Row;
  return ((measurements.blockerRanking ?? []) as Row[]);
}

export function extractDenominators(bundle: PinnedBundle): Row {
  const measurements = (bundle.d080b.measurements ?? {}) as Row;
  return ((measurements.denominators ?? {}) as Row);
}

export interface OriginRow {
  origin: string;
  fold: number | null;
  supportedHorizons: number[];
  unsupportedHorizons: number[];
}

export function extractOrigins(bundle: PinnedBundle): OriginRow[] {
  return ((bundle.d080b.origins ?? []) as Row[])
    .map((o) => ({
      origin: day(o.origin) ?? "",
      fold: num(o.fold),
      supportedHorizons: ((o.supportedHorizons ?? []) as unknown[]).map((h) => num(h) ?? 0),
      unsupportedHorizons: ((o.unsupportedHorizons ?? []) as unknown[]).map((h) => num(h) ?? 0),
    }))
    .filter((o) => o.origin !== "")
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

// ---------------------------------------------------------------------------
// D084 v1 — the already-frozen target-pack history
// ---------------------------------------------------------------------------

export function extractTargetPackHistory(bundle: PinnedBundle): Row[] {
  const snapshot = (bundle.d084v1.snapshot ?? {}) as Row;
  const rows = ((snapshot.targetPackHistory ?? []) as Row[]);
  return [...rows].sort((a, b) =>
    [text(a.business_id) ?? "", text(a.effective_at) ?? "", text(a.recorded_at) ?? "", text(a.id) ?? ""]
      .join("|")
      .localeCompare(
        [text(b.business_id) ?? "", text(b.effective_at) ?? "", text(b.recorded_at) ?? "", text(b.id) ?? ""].join("|"),
      ),
  );
}

// ---------------------------------------------------------------------------
// D079 — DESCRIPTIVE persisted-decision census. NEVER a profile authority.
// ---------------------------------------------------------------------------

/**
 * What D079 actually retains per business: counts of persisted decision rows by
 * withheld family, and the account currency.
 *
 * Correction 1 turned these counts into a business-wide
 * `hardActionEligible: false` and labelled it with the D079 counterfactual
 * contract. That is an inference, not a canonical profile: it collapses the
 * scale/cut/refresh booleans, drops every per-action code, reason and anchor
 * explanation, and attributes a verdict to a contract that never produced one.
 * The census is retained here as evidence and is never read as eligibility.
 */
export interface PersistedDecisionCensus {
  businessId: string;
  businessName: string | null;
  currency: string | null;
  byAction: Array<{
    action: string;
    heldBefore: number;
    eligibleBefore: number;
    profileFamilyTransitions: number;
  }>;
  sourceContract: string;
}

export function extractPersistedDecisionCensus(bundle: PinnedBundle): PersistedDecisionCensus[] {
  const sourceContract = text(bundle.d079.contract) ?? "unknown";
  const scenarios = (bundle.d079.scenarios ?? []) as Row[];
  const baseline = scenarios.find((s) => text(s.scenarioId) === "no_anchor_baseline");
  return ((baseline?.byBusiness ?? []) as Row[])
    .map((business) => ({
      businessId: text(business.businessId) ?? "",
      businessName: text(business.businessName),
      currency: text(business.currency),
      byAction: ((business.byAction ?? []) as Row[]).map((action) => {
        let family = 0;
        for (const [transition, count] of Object.entries((action.codeTransitions ?? {}) as Row)) {
          if (transition.startsWith("profile_hard_action_ineligible->")) family += num(count) ?? 0;
        }
        return {
          action: text(action.action) ?? "unknown",
          heldBefore: num(action.heldBefore) ?? 0,
          eligibleBefore: num(action.eligibleBefore) ?? 0,
          profileFamilyTransitions: family,
        };
      }),
      sourceContract,
    }))
    .filter((b) => b.businessId !== "")
    .sort((a, b) => a.businessId.localeCompare(b.businessId));
}

export function extractD083Headline(bundle: PinnedBundle): Row {
  const window = (bundle.d083.window ?? {}) as Row;
  const origins = ((window.origins ?? []) as unknown[]).length;
  const lanes = (bundle.d083.lanes ?? []) as Row[];
  return {
    originCount: origins,
    intentReadyFacts: lanes.reduce((sum, l) => sum + (num(l.intentReadyFacts) ?? 0), 0),
    artifactHash: text(bundle.d083.artifactHash),
  };
}
