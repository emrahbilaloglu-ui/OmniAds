import { describe, expect, it, vi, beforeEach } from "vitest";

const getIntegrationStatusByBusiness = vi.hoisted(() => vi.fn());
const getProviderAccountAssignments = vi.hoisted(() => vi.fn());
const getMetaCanonicalOverviewSummary = vi.hoisted(() => vi.fn());
const getMetaCanonicalOverviewTrends = vi.hoisted(() => vi.fn());
const getMetaBreakdownsForRange = vi.hoisted(() => vi.fn());
const getMetaCampaignsForRange = vi.hoisted(() => vi.fn());
const readMetaAnomaliesForBusiness = vi.hoisted(() => vi.fn());
const readMetaCampaignLabels = vi.hoisted(() => vi.fn());
const readMetaDecisionsWorkspaceReadModel = vi.hoisted(() => vi.fn());
const getMetaCreativesWarehousePayload = vi.hoisted(() => vi.fn());
const readMetaCreativesWarehouseObservedAt = vi.hoisted(() => vi.fn());
const getMetaAccountDailyCoverage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integration-status", () => ({ getIntegrationStatusByBusiness }));
vi.mock("@/lib/provider-account-assignments", () => ({ getProviderAccountAssignments }));
vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewSummary,
  getMetaCanonicalOverviewTrends,
}));
vi.mock("@/lib/meta/breakdowns-source", () => ({ getMetaBreakdownsForRange }));
vi.mock("@/lib/meta/campaigns-source", () => ({ getMetaCampaignsForRange }));
vi.mock("@/lib/meta/anomalies", () => ({ readMetaAnomaliesForBusiness }));
vi.mock("@/lib/meta/campaign-labels", () => ({ readMetaCampaignLabels }));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaDecisionsWorkspaceReadModel,
}));
vi.mock("@/lib/meta/creatives-warehouse", () => ({
  getMetaCreativesWarehousePayload,
  readMetaCreativesWarehouseObservedAt,
}));
vi.mock("@/lib/meta/warehouse", () => ({ getMetaAccountDailyCoverage }));
/*
 * The decision snapshot behind the two control sections. Mocked to a served
 * shape by default so the gate cases below are about the ACTOR rather than
 * about a missing snapshot; the unavailable path has its own case.
 */
const readLatestMetaDecisionSnapshot = vi.hoisted(() => vi.fn(async () => ({
  status: "ok" as const,
  summary: {},
  recommendations: [{ id: "rec_1" }],
  snapshotDate: "2026-08-11",
  snapshotCreatedAt: "2026-08-11T05:00:00.000Z",
})));
vi.mock("@/lib/meta/snapshot", () => ({ readLatestMetaDecisionSnapshot }));

import { readMetaIntelligence } from "@/lib/zero-base/meta/intelligence-server";

const WINDOW = { startDate: "2026-07-15", endDate: "2026-08-11" };

/** The actor most cases use: an admin who may act on the control sections. */
const ADMIN_ACTOR = { role: "admin" as const, reviewerReadOnly: false, demo: false };

/**
 * Shaped like the labels authority actually serves them.
 *
 * `providerAccountId` is part of that shape and is not optional here: every
 * `meta_campaign_labels` row records the account the label was written against,
 * and this surface filters on it. A fixture without the field describes a row
 * that does not exist, and would let a scope test pass while the scope was
 * never applied.
 */
const LABELS = [
  {
    campaignId: "c1",
    campaignName: "Prospecting — broad",
    kind: "main",
    providerAccountId: "act_1",
  },
  { campaignId: "c2", campaignName: null, kind: "test", providerAccountId: "act_1" },
];

/** Shaped like the decisions workspace read model actually serves it. */
function availableWorkspace() {
  return {
    status: "available",
    unavailable: null,
    queue: {
      deduplicationGrain: "ad",
      sourcePreCapCount: 41,
      queuedPreCapCount: 9,
      sections: {
        integrity_fires: { key: "integrity_fires", label: "Integrity fires", preCapCount: 2 },
        money_moves: { key: "money_moves", label: "Money moves", preCapCount: 5 },
        creative_rotation: { key: "creative_rotation", label: "Creative rotation", preCapCount: 2 },
      },
    },
  };
}

function read(
  overrides: {
    providerAccountId?: string | null;
    actor?: { role: "admin" | "collaborator" | "guest"; reviewerReadOnly: boolean; demo: boolean };
  } = {},
) {
  return readMetaIntelligence({
    businessId: "biz-1",
    ...WINDOW,
    // An admin who may act, unless a case overrides it. The composer takes the
    // actor as a required input because the two control sections cannot be
    // composed without knowing who is asking.
    actor: ADMIN_ACTOR,
    ...overrides,
  });
}

// `now` is deliberately gone from the input. It existed only to make the
// page-wide "observed" stamp injectable, and a clock this module accepts but
// never reads would advertise a freshness control it does not have. Each
// section's observation time now comes from its own authority.

describe("account intelligence composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [{}, {}] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "warehouse_published",
      isPartial: false,
    });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [{}, {}, {}], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [{}] });
    readMetaCampaignLabels.mockResolvedValue(LABELS);
    // The three sections WP9 adds, each backed by a read model that already
    // existed rather than by its route handler.
    getMetaCreativesWarehousePayload.mockResolvedValue({
      status: "ok",
      rows: [{ metricsAvailability: "available" }, { metricsAvailability: "unavailable" }],
    });
    readMetaCreativesWarehouseObservedAt.mockResolvedValue(
      "2026-08-11T03:00:00.000Z",
    );
    getMetaAccountDailyCoverage.mockResolvedValue({
      completed_days: 28,
      ready_through_date: "2026-08-11",
      latest_updated_at: "2026-08-11T04:00:00.000Z",
      total_rows: 28,
    });
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(availableWorkspace());
  });

  it("composes every named authority as its own section", async () => {
    const result = await read();
    /**
     * Eight became eleven, and eleven became thirteen. WP9 names nine
     * sections; three were never composed — Top creatives, Page status and Lane
     * classify — and two more, Recommendations/respond and Snapshot/run-now,
     * existed nowhere at all: the view took an `onRespond` prop the page never
     * passed, and run-now was a hard-coded disabled button with its refusal
     * written in the route file. Both are composed now, each carrying a
     * server-authored control state.
     *
     * Each is built from a read model that already exists rather than from its
     * route handler: the creatives warehouse reader Creative Studio serves
     * from, the coverage reader page-status is presentation over, and the same
     * `readMetaDecisionsWorkspaceReadModel` the structure section reads. None
     * of the three route handlers is duplicated, so there is no second
     * readiness authority to drift.
     */
    expect(result.sections.map((item) => item.key)).toEqual([
      "status",
      "pulse",
      "summary",
      "trends",
      "breakdowns",
      "anomalies",
      "labels",
      "structure",
      "top-creatives",
      "page-status",
      "lane-classify",
      "recommendations",
      "snapshot",
    ]);
    expect(result.providerAccountId).toBe("act_1");
  });

  it("actually calls each read model, scoped to the same window", async () => {
    await read();
    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
    ]) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject(WINDOW);
    }
    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledTimes(1);
    expect(readMetaCampaignLabels).toHaveBeenCalledTimes(1);
    // ONE decision read, shared by Structure and Lane classify. Reading it
    // twice per page load doubled the most expensive query on this surface for
    // no new information.
    expect(readMetaDecisionsWorkspaceReadModel).toHaveBeenCalledTimes(1);
  });

  it("carries the window's own end date into the anomalies read", async () => {
    // This authority takes `MAX(snapshot_date)` over all time unless bounded.
    // Unbounded, a historical window showed today's anomaly snapshot beside
    // sources scoped to that window — while the page printed one line saying
    // every windowed source covered the same range.
    await read();
    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: WINDOW.endDate }),
    );
  });

  it("scopes every account-scoped read to the one resolved account", async () => {
    await read();
    expect(getMetaCampaignsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "act_1" }),
    );
    expect(getMetaCanonicalOverviewTrends).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_1" }),
    );
    // The breakdowns authority has always accepted the filter; not passing it
    // read every assigned account into a row sitting beside account-scoped ones.
    expect(getMetaBreakdownsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_1" }),
    );
    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_1" }),
    );
    expect(readMetaDecisionsWorkspaceReadModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_1" }),
    );
  });

  it("carries served counts rather than inventing metrics", async () => {
    const result = await read();
    expect(result.sections.find((s) => s.key === "trends")?.facts).toEqual([
      { label: "Trend points", value: "3" },
    ]);
    expect(result.sections.find((s) => s.key === "anomalies")?.facts).toEqual([
      { label: "Active anomalies", value: "1" },
    ]);
  });

  it("binds the campaign array the source actually serves", async () => {
    // The result key is `rows`. Reading `campaigns` left the pulse tile blank
    // for every account, forever.
    const pulse = (await read()).sections.find((s) => s.key === "pulse")!;
    expect(pulse.facts).toEqual([{ label: "Campaigns in window", value: "2" }]);
  });

  it("carries the decisions queue's own counts on the structure row", async () => {
    const structure = (await read()).sections.find((s) => s.key === "structure")!;
    expect(structure.state).toBe("serving");
    expect(structure.facts).toEqual([
      { label: "Decision rows read", value: "41" },
      { label: "Queued for review", value: "9" },
      { label: "Integrity fires", value: "2" },
      { label: "Money moves", value: "5" },
      { label: "Creative rotation", value: "2" },
    ]);
  });

  it("serves the labels themselves, not only how many there are", async () => {
    const labels = (await read()).sections.find((s) => s.key === "labels")!;
    expect(labels.facts).toEqual([
      { label: "Labelled campaigns", value: "2" },
      { label: "Prospecting — broad", value: "Main" },
      // No stored name falls back to the campaign id rather than to a guess.
      { label: "c2", value: "Test" },
    ]);
  });

  it("says a count was not reported rather than printing zero", async () => {
    getMetaCanonicalOverviewTrends.mockResolvedValue({ isPartial: false });
    const result = await read();
    // A missing collection is unknown, and 0 would be a measurement nobody took.
    expect(result.sections.find((s) => s.key === "trends")?.facts[0].value).toBe("Not reported");
  });

  /**
   * Labels are stored per business, but written per account.
   *
   * One live business holds 18 labels on one Meta account and 3 on another.
   * Listing all 21 in a row beside account-scoped neighbours attributed one
   * account's campaigns to the other. The shared authority keys only on the
   * business, so the scope is applied at this composition — and the labels it
   * drops are named, because a silently shorter list misleads as surely as a
   * silently longer one.
   */
  it("counts only the selected account's labels, and says how many it withheld", async () => {
    readMetaCampaignLabels.mockResolvedValue([
      ...LABELS,
      { campaignId: "c9", campaignName: "Other account", kind: "main", providerAccountId: "act_2" },
      // No recorded account is not "this account": it cannot be attributed here.
      { campaignId: "c8", campaignName: "Unattributed", kind: "main", providerAccountId: null },
    ]);
    const labels = (await read()).sections.find((s) => s.key === "labels")!;
    expect(labels.facts).toEqual([
      { label: "Labelled campaigns", value: "2" },
      { label: "Prospecting — broad", value: "Main" },
      { label: "c2", value: "Test" },
    ]);
    expect(labels.state).toBe("partial");
    expect(labels.reason).toMatch(/2 labelled campaigns .* are not counted here/);
  });

  it("says a label count was not reported rather than showing zero", async () => {
    readMetaCampaignLabels.mockResolvedValue(null);
    const labels = (await read()).sections.find((s) => s.key === "labels")!;
    expect(labels.facts).toEqual([{ label: "Labelled campaigns", value: "Not reported" }]);
  });
});

describe("one failing authority degrades one row, not the page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockRejectedValue(new Error("summary source is down"));
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(availableWorkspace());
  });

  it("marks the failed source degraded with a classified reason, not the raw error", async () => {
    /**
     * Was: `expect(summary.reason).toBe("summary source is down")` — the thrown
     * error's own text, rendered onto the operator's screen.
     *
     * That leaks and it does not help. A driver error carries the failing SQL,
     * table and column names and sometimes bound parameters; a fetch error
     * carries the URL, which for a provider call can carry an access token. And
     * `relation "meta_page_status" does not exist` tells a media buyer nothing
     * they can act on. The raw text is still kept — logged server-side, where
     * only an operator of the system reads it — and stops being the sentence on
     * the screen. WP9: "Ham Error.message basılmaz."
     */
    const result = await read();
    const summary = result.sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("degraded");
    // Degraded, not unavailable: a failed read is not the same as nothing to give.
    expect(summary.state).not.toBe("unavailable");
    expect(summary.reason).not.toBe("summary source is down");
    expect(summary.reason).not.toContain("summary source is down");
    expect(summary.failureCode).toBe("source_read_failed");
    // Still says the read failed and the gap is unknown rather than zero.
    expect(summary.reason).toContain("incomplete");
  });

  it("classifies a missing relation as a migration, not as a mystery", async () => {
    // The remedy differs, so the code has to: a schema gap is not something the
    // operator can fix by retrying, and telling them it is wastes their time.
    const missingRelation = Object.assign(
      new Error('relation "meta_page_status" does not exist'),
      { code: "42P01" },
    );
    getMetaCanonicalOverviewSummary.mockRejectedValue(missingRelation);
    const result = await read();
    const summary = result.sections.find((s) => s.key === "summary")!;
    expect(summary.failureCode).toBe("schema_not_ready");
    expect(summary.reason).not.toContain("meta_page_status");
  });

  it("classifies an expired provider token as a reconnect", async () => {
    getMetaCanonicalOverviewSummary.mockRejectedValue(
      new Error("Meta access token has expired. Please reconnect Meta integration."),
    );
    const result = await read();
    const summary = result.sections.find((s) => s.key === "summary")!;
    expect(summary.failureCode).toBe("provider_auth_expired");
    expect(summary.reason).toContain("Reconnect");
  });

  it("never puts the raw error text into the served payload", async () => {
    /**
     * The leak, closed at the boundary rather than at each render site.
     *
     * `classifySourceFailure` keeps the raw text in `detail` for the server log
     * and returns only the contracted sentence. This walks the whole served
     * payload — every section, every fact, every reason — and asserts the
     * thrown text appears nowhere in it, so a future field that forwards it
     * fails here rather than on an operator's screen.
     */
    getMetaCanonicalOverviewSummary.mockRejectedValue(
      new Error(
        "request to https://graph.facebook.com/v20.0/act_1?access_token=EAAsecret123 failed",
      ),
    );
    const result = await read();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("EAAsecret123");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("graph.facebook.com");
  });

  it("leaves every other section serving", async () => {
    const result = await read();
    expect(result.sections.filter((s) => s.state === "degraded")).toHaveLength(1);
    expect(result.unavailableReason).toBeNull();
  });
});

describe("partial states keep the source's own words", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "current_day_live",
      isPartial: true,
      notReadyReason: "Current-day live Meta totals are still being prepared.",
    });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(availableWorkspace());
  });

  it("reports partial with the read model's reason, not a rewritten one", async () => {
    const summary = (await read()).sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("partial");
    expect(summary.reason).toBe("Current-day live Meta totals are still being prepared.");
  });

  it("does not collapse a partial source into a single page-wide message", async () => {
    const result = await read();
    // Exactly one source is partial; the rest keep their own states.
    expect(result.sections.filter((s) => s.state === "partial")).toHaveLength(1);
  });
});

describe("the decisions authority's own health is not overwritten", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({ readSource: "warehouse_published" });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [] });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready" });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
  });

  it("does not print Serving over a read model that reported itself unavailable", async () => {
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
      status: "unavailable",
      unavailable: {
        code: "snapshot_unavailable",
        message: "No verified native decision generation exists for this account.",
      },
      queue: null,
    });
    const structure = (await read()).sections.find((s) => s.key === "structure")!;
    // Green "Serving" here was a false statement about the system's own health.
    expect(structure.state).toBe("unavailable");
    expect(structure.reason).toBe(
      "No verified native decision generation exists for this account.",
    );
    expect(structure.facts).toEqual([]);
  });

  it("still refuses when the model gives no reason for refusing", async () => {
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
      status: "unavailable",
      unavailable: null,
      queue: null,
    });
    const structure = (await read()).sections.find((s) => s.key === "structure")!;
    expect(structure.state).toBe("unavailable");
    expect(structure.reason).toMatch(/without a reason/);
  });

  it("says a missing queue count was not reported rather than showing zero", async () => {
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
      status: "available",
      unavailable: null,
      queue: { sections: {} },
    });
    const structure = (await read()).sections.find((s) => s.key === "structure")!;
    expect(structure.facts).toEqual([
      { label: "Decision rows read", value: "Not reported" },
      { label: "Queued for review", value: "Not reported" },
    ]);
  });
});

describe("account scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({ readSource: "warehouse_published" });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [] });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready" });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(availableWorkspace());
  });

  it("refuses to pick one of several assigned accounts", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    const result = await read();
    // Choosing would scope every section to an account nobody selected.
    expect(result.providerAccountId).toBeNull();
    expect(result.sections.find((s) => s.key === "status")?.state).toBe("partial");
    expect(readMetaDecisionsWorkspaceReadModel).not.toHaveBeenCalled();
  });

  it("marks account-scoped sources unavailable when no account resolves", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: [] });
    const structure = (await read()).sections.find((s) => s.key === "structure")!;
    expect(structure.state).toBe("unavailable");
    // The remedy is to select an account, so the row says that rather than
    // the generic "not configured for this business".
    expect(structure.reason).toMatch(/No single Meta account is selected/);
  });

  /**
   * No account resolved means no account-scoped read happened.
   *
   * Every one of these authorities treats a null account as "every account
   * assigned to the business" and returns a business-wide answer. On a surface
   * whose own status row names the selected account, that answer is not a
   * partial one — it is a different account's number wearing this account's
   * label, and nothing on screen distinguishes it from a correct one. The row
   * must say it was not read, and the operator selects an account.
   */
  it("never falls back to a business-wide read when no account resolves", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    const result = await read();

    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
      readMetaAnomaliesForBusiness,
      readMetaCampaignLabels,
      readMetaDecisionsWorkspaceReadModel,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }

    for (const key of [
      "pulse",
      "summary",
      "trends",
      "breakdowns",
      "anomalies",
      "labels",
      "structure",
    ]) {
      const row = result.sections.find((s) => s.key === key)!;
      expect(row.state, key).toBe("unavailable");
      expect(row.reason, key).toMatch(/No single Meta account is selected/);
      // Nothing is served, and in particular no count: "0 campaigns" would be
      // a measurement of an account nobody chose.
      expect(row.facts, key).toEqual([]);
    }

    // The connection row still reports, because it is the one row that is about
    // the business rather than about an account — and it is what names the
    // missing selection.
    expect(result.sections.find((s) => s.key === "status")?.state).toBe("partial");
  });

  /**
   * The law changed because the authority did, so this restates it rather than
   * being deleted.
   *
   * It used to say: `getMetaCanonicalOverviewSummary` accepts no account
   * filter, so with two accounts assigned and one selected its totals are A+B
   * under a heading that means B, and withholding is the only honest answer.
   * The authority now takes an optional `providerAccountId` and narrows to it
   * fail-closed, so the premise is gone — a permanently blank Summary on every
   * multi-account business was a hole, not a safeguard.
   *
   * What survives is the part that was always the point: the figure under this
   * heading must describe THIS account. So the assertion moved from "it
   * refuses to call" to "it calls with the selected account".
   */
  it("scopes the summary to the selected account instead of withholding it", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    const result = await readMetaIntelligence({
      actor: ADMIN_ACTOR,
      businessId: "biz-1",
      ...WINDOW,
      providerAccountId: "act_2",
    });
    const summary = result.sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("serving");
    expect(getMetaCanonicalOverviewSummary).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", providerAccountId: "act_2" }),
    );
  });

  it("serves the summary when the one assigned account is the selected one", async () => {
    // Here "every assigned account" and "this account" name the same set, so
    // the wider authority is not wider and withholding would hide a true figure.
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    const summary = (await read()).sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("serving");
    expect(getMetaCanonicalOverviewSummary).toHaveBeenCalledTimes(1);
  });

  it("withholds the summary when the assignment cannot be read at all", async () => {
    // An unreadable assignment cannot prove the business holds exactly one
    // account, and "could not check" must not resolve to "safe to widen".
    getProviderAccountAssignments.mockRejectedValue(new Error("assignment read failed"));
    const result = await readMetaIntelligence({
      actor: ADMIN_ACTOR,
      businessId: "biz-1",
      ...WINDOW,
      providerAccountId: "act_1",
    });
    const summary = result.sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("unavailable");
    expect(getMetaCanonicalOverviewSummary).not.toHaveBeenCalled();
  });

});

/**
 * Freshness must be measured, not stamped.
 *
 * Every section used to carry one `new Date()` computed before any authority was
 * read, rendered verbatim as "Observed: <the moment the page was opened>" on all
 * eight rows — including sources whose warehouse last synced days ago and ones
 * that had never synced at all. That is a timestamp nobody measured standing in
 * for an unknown one, and reloading the page appeared to refresh data that had
 * not moved. Each row now carries its own authority's instant, or null.
 */
describe("each source reports its own observation time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "warehouse_published",
      isPartial: false,
      freshness: { lastSyncedAt: "2026-08-09T04:00:00.000Z", liveRefreshedAt: null },
    });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({
      status: "ready",
      isPartial: false,
      freshness: { lastSyncedAt: "2026-08-08T01:00:00.000Z", liveRefreshedAt: null },
    });
    readMetaAnomaliesForBusiness.mockResolvedValue({
      anomalies: [],
      snapshotDate: "2026-08-10",
    });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
      ...availableWorkspace(),
      generatedAt: "2026-08-11T12:00:00.000Z",
      source: { computedAt: "2026-08-10T03:15:00.000Z" },
    });
  });

  function observed(sections: Awaited<ReturnType<typeof read>>["sections"], key: string) {
    return sections.find((item) => item.key === key)?.observedAt ?? null;
  }

  it("uses the warehouse's own last-observed instant, not the request clock", async () => {
    const { sections } = await read();
    expect(observed(sections, "summary")).toBe("2026-08-09T04:00:00.000Z");
    expect(observed(sections, "breakdowns")).toBe("2026-08-08T01:00:00.000Z");
  });

  it("uses the decision snapshot's computedAt, never the read model's generatedAt", async () => {
    // `generatedAt` is that read model's own request clock; reusing it here
    // would restate the bug in a second place.
    const { sections } = await read();
    expect(observed(sections, "structure")).toBe("2026-08-10T03:15:00.000Z");
    expect(observed(sections, "structure")).not.toBe("2026-08-11T12:00:00.000Z");
  });

  it("reports the snapshot the anomalies were actually read from", async () => {
    const { sections } = await read();
    expect(observed(sections, "anomalies")).toBe("2026-08-10");
  });

  it("says not-recorded rather than now for an authority that measures no instant", async () => {
    const { sections } = await read();
    // The view renders null as "Not recorded" — the honest answer. Trends is
    // deliberately null even though it carries a `freshness`, because that
    // freshness is built from the points' dates (coverage), not from an
    // observation.
    for (const key of ["status", "pulse", "trends", "labels"]) {
      expect(observed(sections, key), key).toBeNull();
    }
  });

  it("never stamps one clock across the sections", async () => {
    /**
     * The rule is "no single clock across every source", not "every stamp is
     * unique". Two sections served by the SAME authority legitimately share its
     * observation instant — Structure and Lane classify both describe one
     * decision snapshot, and giving them different times would be the lie, not
     * the truth.
     *
     * What must never happen is the whole page carrying one value, which is how
     * a never-synced source reads as observed just now. So: several distinct
     * instants, and no stamp equal to this test's own clock.
     */
    const { sections } = await read();
    const stamps = sections
      .map((item) => item.observedAt)
      .filter((value): value is string => Boolean(value));
    expect(stamps.length).toBeGreaterThan(3);
    expect(new Set(stamps).size).toBeGreaterThan(1);

    const sharedAuthority = sections
      .filter((item) => item.key === "structure" || item.key === "lane-classify")
      .map((item) => item.observedAt);
    // One authority, one instant — stated rather than incidental.
    expect(new Set(sharedAuthority).size).toBe(1);

    const now = Date.now();
    for (const stamp of stamps) {
      expect(Math.abs(now - Date.parse(stamp)), stamp).toBeGreaterThan(1000);
    }
  });

  /**
   * The section contract is `string | null`, and it is enforced, not assumed.
   *
   * These values cross `pg`, which returns a live `Date` for every timestamp
   * column it is not told to read as text — so `freshness.lastSyncedAt`, typed
   * `string`, arrived as a `Date`. TypeScript could not see it, the RSC payload
   * carried it faithfully across to the client component as a `Date`, and React
   * threw on `{row.observedAt}`: "Objects are not valid as a React child (found:
   * [object Date])". The whole Intelligence route rendered as "Application
   * error: a client-side exception has occurred" — every section lost to one
   * mistyped field.
   */
  it("renders a driver's Date as its instant instead of an unrenderable object", async () => {
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "warehouse_published",
      isPartial: false,
      freshness: {
        lastSyncedAt: new Date("2026-08-18T04:39:45.798Z"),
        liveRefreshedAt: null,
      },
    });
    const { sections } = await read();
    expect(observed(sections, "summary")).toBe("2026-08-18T04:39:45.798Z");
    expect(typeof observed(sections, "summary")).toBe("string");
  });

  it("refuses an unusable timestamp rather than printing Invalid Date", async () => {
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "warehouse_published",
      isPartial: false,
      freshness: { lastSyncedAt: new Date("not a date"), liveRefreshedAt: null },
    });
    const { sections } = await read();
    // The view prints null as "Not recorded". "Invalid Date" would be this
    // surface reporting an observation it cannot name.
    expect(observed(sections, "summary")).toBeNull();
  });

  it("gives a never-synced source no observation time at all", async () => {
    getMetaBreakdownsForRange.mockResolvedValue({
      status: "syncing",
      isPartial: false,
      freshness: { dataState: "syncing", lastSyncedAt: null, liveRefreshedAt: null },
    });
    const { sections } = await read();
    // "Observed just now" over a source that has never synced is the exact
    // substitution the honesty law forbids.
    expect(observed(sections, "breakdowns")).toBeNull();
  });
});

describe("the caller's resolved account is honoured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({ readSource: "warehouse_published" });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [] });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready" });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(availableWorkspace());
  });

  it("scopes to the account the route resolved, even with several assigned", async () => {
    // The route resolves it through `resolveProviderAccountId`, which refuses an
    // unassigned id and refuses to pick one of several — so accepting it here
    // cannot widen scope. Ignoring it made a surface the operator had scoped
    // report itself as unscoped.
    const result = await readMetaIntelligence({
      actor: ADMIN_ACTOR,
      businessId: "biz-1",
      ...WINDOW,
      providerAccountId: "act_2",
    });
    expect(result.providerAccountId).toBe("act_2");
    expect(readMetaDecisionsWorkspaceReadModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_2" }),
    );
    expect(result.sections.find((s) => s.key === "structure")?.state).toBe("serving");
  });

  it("still refuses when the caller resolved nothing", async () => {
    const result = await readMetaIntelligence({
      actor: ADMIN_ACTOR,
      businessId: "biz-1",
      ...WINDOW,
      providerAccountId: null,
    });
    expect(result.providerAccountId).toBeNull();
    expect(readMetaDecisionsWorkspaceReadModel).not.toHaveBeenCalled();
  });
});

describe("the surface refuses rather than guessing", () => {
  it("says integration status could not be read", async () => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockRejectedValue(new Error("db down"));
    const result = await read();
    expect(result.unavailableReason).toMatch(/could not be read/);
    expect(result.sections).toEqual([]);
  });

  it("says Meta is not connected instead of composing empty sections", async () => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: false, google: true });
    const result = await read();
    expect(result.unavailableReason).toMatch(/not connected/);
    expect(getMetaCanonicalOverviewSummary).not.toHaveBeenCalled();
  });
});

describe("WP9 — the three sections that were never composed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({ readSource: "warehouse_published", isPartial: false });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    getMetaCreativesWarehousePayload.mockResolvedValue({ status: "ok", rows: [] });
    readMetaCreativesWarehouseObservedAt.mockResolvedValue("2026-08-11T03:00:00.000Z");
    getMetaAccountDailyCoverage.mockResolvedValue({
      completed_days: 28,
      ready_through_date: "2026-08-11",
      latest_updated_at: "2026-08-11T04:00:00.000Z",
      total_rows: 28,
    });
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(availableWorkspace());
  });

  function sectionOf(sections: Array<{ key: string }>, key: string) {
    const found = sections.find((item) => item.key === key);
    expect(found, `${key} section missing`).toBeDefined();
    return found as never as {
      key: string;
      state: string;
      reason: string | null;
      failureCode?: string;
      observedAt: string | null;
      facts: Array<{ label: string; value: string }>;
    };
  }

  it("serves all three when their authorities answer", async () => {
    const { sections } = await read();
    for (const key of ["top-creatives", "page-status", "lane-classify"]) {
      expect(sectionOf(sections, key).state, key).toBe("serving");
    }
  });

  it("reports a proven-empty creative window as zero, not as unavailable", async () => {
    // The read succeeded and the account genuinely has no creatives in this
    // window. That is a fact, and it is different from a failed read.
    const section = sectionOf((await read()).sections, "top-creatives");
    expect(section.state).toBe("serving");
    expect(section.facts.find((fact) => fact.label === "Creatives in window")?.value).toBe("0");
  });

  it("withholds all three when no single account is selected", async () => {
    // D6: account-scoped data is never served without an account, and the
    // reason names the authority rather than showing zeros.
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    const { sections } = await read({ providerAccountId: null });
    for (const key of ["top-creatives", "page-status", "lane-classify"]) {
      const section = sectionOf(sections, key);
      expect(section.state, key).toBe("unavailable");
      expect(section.reason, key).toMatch(/No single Meta account is selected/);
      expect(section.facts, key).toEqual([]);
    }
  });

  it("degrades a failed creative read with a classified reason, never the raw error", async () => {
    getMetaCreativesWarehousePayload.mockRejectedValue(
      new Error("request to https://graph.facebook.com/v20.0?access_token=EAAsecret failed"),
    );
    const section = sectionOf((await read()).sections, "top-creatives");
    expect(section.state).toBe("degraded");
    expect(section.failureCode).toBe("source_read_failed");
    expect(section.reason).not.toContain("EAAsecret");
    expect(section.reason).not.toContain("access_token");
  });

  it("marks a short-covered window partial rather than serving it whole", async () => {
    // 12 of 28 days synced is not the period the operator asked for, and
    // presenting it as one is how a total silently becomes wrong.
    getMetaAccountDailyCoverage.mockResolvedValue({
      completed_days: 12,
      ready_through_date: "2026-07-26",
      latest_updated_at: "2026-07-26T04:00:00.000Z",
      total_rows: 12,
    });
    const section = sectionOf((await read()).sections, "page-status");
    expect(section.state).toBe("partial");
    expect(section.facts.find((fact) => fact.label === "Days covered")?.value).toBe("12 of 28");
  });

  it("says 'not reported' rather than zero when coverage is unreadable", async () => {
    getMetaAccountDailyCoverage.mockResolvedValue(null);
    const section = sectionOf((await read()).sections, "page-status");
    expect(section.facts.find((fact) => fact.label === "Days covered")?.value).toBe("Not reported");
    expect(section.observedAt).toBeNull();
  });

  it("reports the lane classifier's own refusal in its own words", async () => {
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
      status: "unavailable",
      unavailable: { code: "snapshot_unavailable", message: "No complete native generation." },
      source: { computedAt: "2026-08-10T03:00:00.000Z" },
    });
    const section = sectionOf((await read()).sections, "lane-classify");
    expect(section.state).toBe("unavailable");
    expect(section.reason).toBe("No complete native generation.");
    // A model that cannot serve still names when its snapshot was computed.
    expect(section.observedAt).toBe("2026-08-10T03:00:00.000Z");
  });

  it("reads ad candidates as 'not reported' on a payload that omits them", async () => {
    // `adCandidates` is optional for v1 payload compatibility. Absent is not 0.
    const model = availableWorkspace();
    delete (model as { queue?: { adCandidates?: unknown } }).queue?.adCandidates;
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue(model);
    const section = sectionOf((await read()).sections, "lane-classify");
    const eligible = section.facts.find((fact) => fact.label === "Ad candidates eligible");
    expect(eligible?.value).toBe("Not reported");
  });
});

/**
 * WP9's role and capability gate, on the two sections that have controls.
 *
 * "Respond ve run-now role/capability gate kullanır" had nothing to gate: the
 * view accepted an `onRespond` prop the page never passed, and run-now was a
 * hard-coded disabled button whose refusal was written in the route file. Both
 * are composed sections now, and the gate is the server's — these cases prove
 * the composer authors it rather than the browser.
 */
describe("the two control sections carry a server-authored gate", () => {
  const CONTROLLED = ["recommendations", "snapshot"] as const;

  async function controlsFor(actor: {
    role: "admin" | "collaborator" | "guest";
    reviewerReadOnly: boolean;
    demo: boolean;
  }) {
    const result = await read({ actor });
    return CONTROLLED.map((key) => {
      const section = result.sections.find((item) => item.key === key);
      return { key, section };
    });
  }

  it("offers both controls to an actor who may act", async () => {
    for (const { key, section } of await controlsFor(ADMIN_ACTOR)) {
      expect(section, `${key} was not composed`).toBeDefined();
      expect(section!.control?.enabled, key).toBe(true);
      expect(section!.control?.refusalCode, key).toBeNull();
      // A section whose control is available is not `refused`.
      expect(section!.readState, key).not.toBe("refused");
    }
  });

  for (const [label, actor, code] of [
    ["a reviewer", { role: "admin" as const, reviewerReadOnly: true, demo: false }, "reviewer_read_only"],
    ["a demo workspace", { role: "admin" as const, reviewerReadOnly: false, demo: true }, "demo_business_read_only"],
    ["a guest", { role: "guest" as const, reviewerReadOnly: false, demo: false }, "insufficient_role"],
  ] as const) {
    it(`refuses both controls for ${label}, with the code the route would return`, async () => {
      for (const { key, section } of await controlsFor(actor)) {
        expect(section!.control?.enabled, key).toBe(false);
        expect(section!.control?.refusalCode, key).toBe(code);
        /*
         * `refused`, and the facts still served. A reviewer may READ what the
         * respond control would act on — withholding the counts as well would
         * be refusing a read nobody refused.
         */
        expect(section!.readState, key).toBe("refused");
        expect(section!.readFailureCode, key).toBe(code);
      }
    });
  }

  it("precedence is the routes' own: reviewer before demo before role", async () => {
    /*
     * A reviewer in a demo workspace with a guest role is refused as a
     * reviewer, because that is the first check `rejectIfReviewerReadOnly`
     * makes and the sentence an operator can act on is the outermost one.
     */
    const [{ section }] = await controlsFor({
      role: "guest",
      reviewerReadOnly: true,
      demo: true,
    });
    expect(section!.control?.refusalCode).toBe("reviewer_read_only");
  });

  it("never leaks a refusal into a reading section", async () => {
    // The gate belongs to the two sections that own controls. A reading
    // section that reported `refused` would be claiming the actor may not read
    // what they just read.
    const result = await read({ actor: { role: "guest", reviewerReadOnly: false, demo: false } });
    const leaked = result.sections
      .filter((item) => !CONTROLLED.includes(item.key as (typeof CONTROLLED)[number]))
      .filter((item) => item.readState === "refused" || item.control);
    expect(leaked.map((item) => item.key)).toEqual([]);
  });
});
