import { beforeEach, describe, expect, it, vi } from "vitest";

const queryLog: string[] = [];
const queryCalls: Array<{ text: string; values: unknown[] }> = [];
const tableResponses = {
  targetPack: [] as unknown[],
  targetHistory: [] as Array<Record<string, unknown>>,
  countryEconomics: [] as unknown[],
  promoCalendar: [] as unknown[],
  operatingConstraints: [] as unknown[],
  calibrationProfiles: [] as unknown[],
};
let currentTargetPack: Record<string, unknown> | null = null;
let targetHistorySequence = 0;

vi.mock("@/lib/db", () => {
  const sql = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      queryLog.push(text);
      queryCalls.push({ text, values });

      if (
        text.includes("WITH write_clock AS") &&
        text.includes("INSERT INTO business_target_packs") &&
        text.includes("FROM current_write")
      ) {
        const candidate = {
          business_id: values[0],
          business_ref_id: currentTargetPack?.business_ref_id ?? values[1],
          target_cpa: values[2],
          target_roas: values[3],
          break_even_cpa: values[4],
          break_even_roas: values[5],
          contribution_margin_assumption: values[6],
          aov_assumption: values[7],
          new_customer_weight: values[8],
          default_risk_posture: values[9],
          cost_cogs_percent: values[10],
          cost_shipping_percent: values[11],
          cost_fulfillment_percent: values[12],
          cost_payment_processing_percent: values[13],
          source_label: values[14],
        };
        const semanticCurrent = currentTargetPack
          ? Object.fromEntries(
              Object.keys(candidate).map((key) => [
                key,
                currentTargetPack?.[key],
              ]),
            )
          : null;

        if (
          !semanticCurrent ||
          JSON.stringify(semanticCurrent) !== JSON.stringify(candidate)
        ) {
          const effectiveAt = new Date().toISOString();
          currentTargetPack = {
            ...candidate,
            updated_by_user_id: values[15],
            updated_at: effectiveAt,
          };
          tableResponses.targetHistory.push({
            ...currentTargetPack,
            id: `history-${++targetHistorySequence}`,
            operation: "upsert",
            effective_at: effectiveAt,
            recorded_at: effectiveAt,
          });
        }
        return [];
      }

      if (
        text.includes("WITH write_clock AS") &&
        text.includes("history_write AS") &&
        text.includes("DELETE FROM business_target_packs target")
      ) {
        if (currentTargetPack?.business_id === values[0]) {
          const effectiveAt = new Date().toISOString();
          tableResponses.targetHistory.push({
            ...currentTargetPack,
            id: `history-${++targetHistorySequence}`,
            operation: "delete",
            effective_at: effectiveAt,
            recorded_at: effectiveAt,
            updated_at: effectiveAt,
            updated_by_user_id: values[1],
          });
          currentTargetPack = null;
        }
        return [];
      }

      if (text.includes("/* target-pack-reconfirmation */")) {
        const [businessId, expectedUpdatedAt, updatedByUserId] = values;
        if (
          !currentTargetPack ||
          currentTargetPack.business_id !== businessId
        ) {
          return [
            {
              result_status: "missing",
              reason: "target_pack_missing",
              updated_at: null,
            },
          ];
        }

        if (
          Date.parse(String(currentTargetPack.updated_at)) !==
          Date.parse(String(expectedUpdatedAt))
        ) {
          return [
            {
              result_status: "conflict",
              reason: "target_pack_changed",
              updated_at: currentTargetPack.updated_at,
            },
          ];
        }

        const anchors = {
          target_cpa: currentTargetPack.target_cpa,
          target_roas: currentTargetPack.target_roas,
          break_even_cpa: currentTargetPack.break_even_cpa,
          break_even_roas: currentTargetPack.break_even_roas,
        };
        const invalidAnchor = Object.entries(anchors).find(([, value]) => {
          return (
            value !== null &&
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
          );
        });
        let invalidReason = invalidAnchor
          ? `${invalidAnchor[0]}_must_be_positive_finite`
          : null;
        if (Object.values(anchors).every((value) => value == null)) {
          invalidReason = "target_pack_has_no_economic_anchors";
        } else if (
          !invalidReason &&
          typeof anchors.target_roas === "number" &&
          typeof anchors.break_even_roas === "number" &&
          anchors.target_roas < anchors.break_even_roas
        ) {
          invalidReason = "target_roas_below_break_even_roas";
        } else if (
          !invalidReason &&
          typeof anchors.target_cpa === "number" &&
          typeof anchors.break_even_cpa === "number" &&
          anchors.target_cpa > anchors.break_even_cpa
        ) {
          invalidReason = "target_cpa_above_break_even_cpa";
        }

        if (invalidReason) {
          return [
            {
              result_status: "invalid_target_pack",
              reason: invalidReason,
              updated_at: currentTargetPack.updated_at,
            },
          ];
        }

        const currentUpdatedAtMs = Date.parse(
          String(currentTargetPack.updated_at),
        );
        const effectiveAt = new Date(
          Math.max(Date.now(), currentUpdatedAtMs + 1),
        ).toISOString();
        currentTargetPack = {
          ...currentTargetPack,
          updated_by_user_id: updatedByUserId,
          updated_at: effectiveAt,
        };
        tableResponses.targetHistory.push({
          ...currentTargetPack,
          id: `history-${++targetHistorySequence}`,
          operation: "upsert",
          effective_at: effectiveAt,
          recorded_at: effectiveAt,
        });
        return [
          {
            result_status: "reconfirmed",
            reason: "target_pack_reconfirmed",
            updated_at: effectiveAt,
          },
        ];
      }

      if (text.includes("FROM business_target_pack_history")) {
        const businessId = values[0];
        const cutoff = Date.parse(String(values[1]));
        return tableResponses.targetHistory
          .filter((row) => row.business_id === businessId)
          .filter((row) => Date.parse(String(row.effective_at)) <= cutoff)
          .filter((row) => Date.parse(String(row.recorded_at)) <= cutoff)
          .sort((left, right) => {
            const effectiveDelta =
              Date.parse(String(right.effective_at)) -
              Date.parse(String(left.effective_at));
            if (effectiveDelta !== 0) return effectiveDelta;
            const recordedDelta =
              Date.parse(String(right.recorded_at)) -
              Date.parse(String(left.recorded_at));
            if (recordedDelta !== 0) return recordedDelta;
            return String(right.id).localeCompare(String(left.id));
          })
          .slice(0, 1);
      }

      if (text.includes("FROM business_target_packs"))
        return tableResponses.targetPack;
      if (text.includes("FROM business_country_economics"))
        return tableResponses.countryEconomics;
      if (text.includes("FROM business_promo_calendar_events"))
        return tableResponses.promoCalendar;
      if (text.includes("FROM business_operating_constraints"))
        return tableResponses.operatingConstraints;
      if (text.includes("FROM business_decision_calibration_profiles")) {
        return tableResponses.calibrationProfiles;
      }
      return [];
    },
  ) as unknown as ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>) & {
    query?: ReturnType<typeof vi.fn>;
  };

  sql.query = vi.fn();

  return {
    getDb: vi.fn(() => sql),
    runDbTransaction: vi.fn(async (callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(async () => ({
    ready: true,
    missingTables: [],
    checkedAt: new Date().toISOString(),
  })),
  getDbSchemaReadiness: vi.fn(async () => ({
    ready: true,
    missingTables: [],
    checkedAt: new Date().toISOString(),
  })),
  isMissingRelationError: vi.fn(() => false),
}));

vi.mock("@/lib/business-cost-model", () => ({
  getBusinessCostModel: vi.fn(async () => null),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map(
        (businessId) => [businessId, `business-ref-${businessId}`] as const,
      ),
    );
  }),
}));

const businessCommercial = await import("@/lib/business-commercial");
const db = await import("@/lib/db");

describe("commercial target freshness", () => {
  it("uses the shared 30-day rule and fails unknown timestamps closed", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");

    expect(
      businessCommercial.resolveBusinessTargetPackFreshness(
        "2026-06-11T00:00:00.000Z",
        now,
      ),
    ).toBe("fresh");
    expect(
      businessCommercial.resolveBusinessTargetPackFreshness(
        "2026-06-09T23:59:59.000Z",
        now,
      ),
    ).toBe("stale");
    expect(
      businessCommercial.resolveBusinessTargetPackFreshness(null, now),
    ).toBe("unknown");
  });

  it("uses the supplied reference time and rejects future target updates", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
      const historicalAsOf = new Date("2026-07-10T23:59:59.999Z");

      expect(
        businessCommercial.resolveBusinessTargetPackFreshness(
          "2026-06-20T12:00:00.000Z",
          historicalAsOf,
        ),
      ).toBe("fresh");
      expect(
        businessCommercial.resolveBusinessTargetPackFreshness(
          "2026-07-11T00:00:00.000Z",
          historicalAsOf,
        ),
      ).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("upsertBusinessCommercialTruthSnapshot", () => {
  beforeEach(() => {
    queryLog.length = 0;
    queryCalls.length = 0;
    tableResponses.targetPack = [];
    tableResponses.targetHistory = [];
    tableResponses.countryEconomics = [];
    tableResponses.promoCalendar = [];
    tableResponses.operatingConstraints = [];
    tableResponses.calibrationProfiles = [];
    currentTargetPack = null;
    targetHistorySequence = 0;
    vi.clearAllMocks();
  });

  it.each([
    ["boolean", true],
    ["numeric array", [40]],
    ["numeric string", "2.5"],
  ])(
    "rejects a type-confused %s economic anchor before writing",
    async (_label, value) => {
      await expect(
        businessCommercial.upsertBusinessCommercialTruthSnapshot({
          businessId: "11111111-1111-4111-8111-111111111111",
          updatedByUserId: "22222222-2222-4222-8222-222222222222",
          snapshot: {
            targetPack: {
              targetRoas: value,
            } as never,
          },
        }),
      ).rejects.toMatchObject({
        name: "BusinessCommercialInputValidationError",
        field: "targetPack.targetRoas",
      });
      expect(queryLog).toEqual([]);
    },
  );

  it("produces a stable revision and changes it with persisted state", () => {
    const snapshot = {
      businessId: "11111111-1111-4111-8111-111111111111",
      targetPack: null,
      countryEconomics: [],
      promoCalendar: [],
      operatingConstraints: null,
      costModelContext: null,
      calibrationProfiles: [],
      sectionMeta: {
        targetPack: {} as never,
        countryEconomics: {} as never,
        promoCalendar: {} as never,
        operatingConstraints: {} as never,
      },
    } as Parameters<
      typeof businessCommercial.businessCommercialSnapshotRevision
    >[0];
    const revision =
      businessCommercial.businessCommercialSnapshotRevision(snapshot);
    const changed = businessCommercial.businessCommercialSnapshotRevision({
      ...snapshot,
      targetPack: { targetRoas: 2.5 },
    } as Parameters<
      typeof businessCommercial.businessCommercialSnapshotRevision
    >[0]);

    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(
      businessCommercial.businessCommercialSnapshotRevision(snapshot),
    ).toBe(revision);
    expect(changed).not.toBe(revision);
  });

  it("uses idempotent keyed upserts for country economics and promo events", async () => {
    await businessCommercial.upsertBusinessCommercialTruthSnapshot({
      businessId: "11111111-1111-4111-8111-111111111111",
      updatedByUserId: "22222222-2222-4222-8222-222222222222",
      snapshot: {
        countryEconomics: [
          {
            countryCode: "US",
            economicsMultiplier: 1.12,
            marginModifier: 0,
            serviceability: "full",
            priorityTier: "tier_1",
            scaleOverride: "default",
            notes: "Retry-safe GEO row",
            sourceLabel: "test",
            updatedAt: null,
            updatedByUserId: null,
          },
        ],
        promoCalendar: [
          {
            eventId: "promo_test",
            title: "Spring Sale",
            promoType: "sale",
            severity: "medium",
            startDate: "2026-04-10",
            endDate: "2026-04-12",
            affectedScope: "all",
            notes: "Retry-safe promo row",
            sourceLabel: "test",
            updatedAt: null,
            updatedByUserId: null,
          },
        ],
        calibrationProfiles: [
          {
            channel: "meta",
            objectiveFamily: "sales",
            bidRegime: "cost_cap",
            archetype: "winner_scale",
            targetRoasMultiplier: 1.1,
            breakEvenRoasMultiplier: 1.02,
            targetCpaMultiplier: 0.92,
            breakEvenCpaMultiplier: 0.97,
            confidenceCap: 0.78,
            actionCeiling: "review_hold",
            notes: "Retry-safe calibration row",
            sourceLabel: "test",
            updatedAt: null,
            updatedByUserId: null,
          },
        ],
      },
    });

    expect(
      queryLog.some(
        (query) =>
          query.includes("INSERT INTO business_country_economics") &&
          query.includes("ON CONFLICT (business_id, country_code)") &&
          query.includes("DO UPDATE SET"),
      ),
    ).toBe(true);

    expect(
      queryLog.some(
        (query) =>
          query.includes("INSERT INTO business_promo_calendar_events") &&
          query.includes("ON CONFLICT (business_id, event_id)") &&
          query.includes("DO UPDATE SET"),
      ),
    ).toBe(true);

    expect(
      queryLog.some(
        (query) =>
          query.includes(
            "INSERT INTO business_decision_calibration_profiles",
          ) &&
          query.includes(
            "ON CONFLICT (business_id, channel, objective_family, bid_regime, archetype)",
          ) &&
          query.includes("DO UPDATE SET"),
      ),
    ).toBe(true);
    expect(queryLog.some((query) => query.includes("business_ref_id"))).toBe(
      true,
    );
    expect(db.runDbTransaction).toHaveBeenCalledTimes(1);
    const sql = db.getDb() as ReturnType<typeof db.getDb> & {
      query: ReturnType<typeof vi.fn>;
    };
    expect(sql.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      ["business-commercial:11111111-1111-4111-8111-111111111111"],
    );
  });

  it("persists cost structure on the target pack without changing the target ROAS path", async () => {
    await businessCommercial.upsertBusinessCommercialTruthSnapshot({
      businessId: "11111111-1111-4111-8111-111111111111",
      updatedByUserId: "22222222-2222-4222-8222-222222222222",
      snapshot: {
        targetPack: {
          targetCpa: null,
          targetRoas: 2.8,
          breakEvenCpa: null,
          breakEvenRoas: 1.9,
          contributionMarginAssumption: null,
          aovAssumption: null,
          newCustomerWeight: null,
          defaultRiskPosture: "aggressive",
          costStructure: {
            cogsPercent: 0.3,
            shippingPercent: 0.08,
            fulfillmentPercent: 0.05,
            paymentProcessingPercent: 0.03,
          },
          sourceLabel: "test",
          updatedAt: null,
          updatedByUserId: null,
        },
      },
    });

    const joinedQueries = queryLog.join("\n");
    expect(joinedQueries).toContain("target_roas");
    expect(joinedQueries).toContain("cost_cogs_percent");
    expect(joinedQueries).toContain("cost_shipping_percent");
    expect(joinedQueries).toContain("cost_fulfillment_percent");
    expect(joinedQueries).toContain("cost_payment_processing_percent");

    const sanitized = businessCommercial.sanitizeBusinessCommercialTruthInput(
      "11111111-1111-4111-8111-111111111111",
      {
        targetPack: {
          targetCpa: null,
          targetRoas: 2.8,
          breakEvenCpa: null,
          breakEvenRoas: 1.9,
          contributionMarginAssumption: null,
          aovAssumption: null,
          newCustomerWeight: null,
          defaultRiskPosture: "aggressive",
          costStructure: {
            cogsPercent: 0.3,
            shippingPercent: 0.08,
            fulfillmentPercent: 0.05,
            paymentProcessingPercent: 0.03,
          },
          sourceLabel: "test",
          updatedAt: null,
          updatedByUserId: null,
        },
      },
    );
    expect(sanitized.targetPack?.targetRoas).toBe(2.8);
    expect(sanitized.targetPack?.costStructure).toEqual({
      cogsPercent: 0.3,
      shippingPercent: 0.08,
      fulfillmentPercent: 0.05,
      paymentProcessingPercent: 0.03,
    });
  });

  it("keeps changed target versions, skips retry duplicates, and resolves them point in time", async () => {
    vi.useFakeTimers();
    try {
      const saveTarget = (targetRoas: number) =>
        businessCommercial.upsertBusinessCommercialTruthSnapshot({
          businessId: "11111111-1111-4111-8111-111111111111",
          updatedByUserId: "22222222-2222-4222-8222-222222222222",
          snapshot: {
            targetPack: {
              targetCpa: 40,
              targetRoas,
              breakEvenCpa: 55,
              breakEvenRoas: 1.8,
              contributionMarginAssumption: 0.4,
              aovAssumption: 100,
              newCustomerWeight: 0.25,
              defaultRiskPosture: "balanced",
              costStructure: {
                cogsPercent: 0.3,
                shippingPercent: 0.08,
                fulfillmentPercent: 0.05,
                paymentProcessingPercent: 0.03,
              },
              sourceLabel: "settings_manual_entry",
              updatedAt: null,
              updatedByUserId: null,
            },
          },
        });

      vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
      await saveTarget(2.5);
      vi.setSystemTime(new Date("2026-06-01T10:05:00.000Z"));
      await saveTarget(2.5);
      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
      await saveTarget(3.1);

      expect(tableResponses.targetHistory).toHaveLength(2);
      expect(
        tableResponses.targetHistory.map((row) => row.target_roas),
      ).toEqual([2.5, 3.1]);

      const first = await businessCommercial.getBusinessTargetPackHistoryAsOf({
        businessId: "11111111-1111-4111-8111-111111111111",
        asOf: "2026-06-01T10:00:00.000Z",
      });
      const second = await businessCommercial.getBusinessTargetPackHistoryAsOf({
        businessId: "11111111-1111-4111-8111-111111111111",
        asOf: "2026-06-02T10:00:00.000Z",
      });

      expect(first?.targetRoas).toBe(2.5);
      expect(second?.targetRoas).toBe(3.1);

      const upsertQuery = queryCalls.find((call) =>
        call.text.includes("FROM current_write"),
      );
      expect(upsertQuery?.text).toContain("IS DISTINCT FROM");
      expect(upsertQuery?.text).toContain(
        "INSERT INTO business_target_pack_history",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconfirms server-owned values, writes one identical history version, and rejects a retry", async () => {
    vi.useFakeTimers();
    try {
      const businessId = "11111111-1111-4111-8111-111111111111";
      vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
      await businessCommercial.upsertBusinessCommercialTruthSnapshot({
        businessId,
        updatedByUserId: "22222222-2222-4222-8222-222222222222",
        snapshot: {
          targetPack: {
            targetCpa: 40,
            targetRoas: 2.8,
            breakEvenCpa: 55,
            breakEvenRoas: 1.9,
            contributionMarginAssumption: 0.4,
            aovAssumption: 100,
            newCustomerWeight: 0.25,
            defaultRiskPosture: "balanced",
            costStructure: {
              cogsPercent: 0.3,
              shippingPercent: 0.08,
              fulfillmentPercent: 0.05,
              paymentProcessingPercent: 0.03,
            },
            sourceLabel: "settings_manual_entry",
            updatedAt: null,
            updatedByUserId: null,
          },
        },
      });
      const expectedUpdatedAt = String(currentTargetPack?.updated_at);
      const economicValuesBefore = {
        target_cpa: currentTargetPack?.target_cpa,
        target_roas: currentTargetPack?.target_roas,
        break_even_cpa: currentTargetPack?.break_even_cpa,
        break_even_roas: currentTargetPack?.break_even_roas,
        contribution_margin_assumption:
          currentTargetPack?.contribution_margin_assumption,
        aov_assumption: currentTargetPack?.aov_assumption,
        new_customer_weight: currentTargetPack?.new_customer_weight,
        default_risk_posture: currentTargetPack?.default_risk_posture,
        cost_cogs_percent: currentTargetPack?.cost_cogs_percent,
        cost_shipping_percent: currentTargetPack?.cost_shipping_percent,
        cost_fulfillment_percent: currentTargetPack?.cost_fulfillment_percent,
        cost_payment_processing_percent:
          currentTargetPack?.cost_payment_processing_percent,
        source_label: currentTargetPack?.source_label,
      };

      vi.setSystemTime(new Date("2026-07-02T11:00:00.000Z"));
      const result = await businessCommercial.reconfirmBusinessTargetPack({
        businessId,
        updatedByUserId: "33333333-3333-4333-8333-333333333333",
        expectedUpdatedAt,
      });

      expect(result).toEqual({
        status: "reconfirmed",
        reason: "target_pack_reconfirmed",
        updatedAt: "2026-07-02T11:00:00.000Z",
      });
      expect(currentTargetPack).toMatchObject({
        ...economicValuesBefore,
        updated_by_user_id: "33333333-3333-4333-8333-333333333333",
        updated_at: "2026-07-02T11:00:00.000Z",
      });
      expect(tableResponses.targetHistory).toHaveLength(2);
      expect(tableResponses.targetHistory[1]).toMatchObject({
        ...economicValuesBefore,
        operation: "upsert",
        effective_at: "2026-07-02T11:00:00.000Z",
        recorded_at: "2026-07-02T11:00:00.000Z",
        updated_by_user_id: "33333333-3333-4333-8333-333333333333",
      });

      await expect(
        businessCommercial.reconfirmBusinessTargetPack({
          businessId,
          updatedByUserId: "33333333-3333-4333-8333-333333333333",
          expectedUpdatedAt,
        }),
      ).resolves.toEqual({
        status: "conflict",
        reason: "target_pack_changed",
        currentUpdatedAt: "2026-07-02T11:00:00.000Z",
      });
      expect(tableResponses.targetHistory).toHaveLength(2);

      const reconfirmQuery = queryCalls.find((call) =>
        call.text.includes("/* target-pack-reconfirmation */"),
      );
      expect(reconfirmQuery?.text).toContain("FOR UPDATE OF target");
      expect(reconfirmQuery?.text).toContain(
        "target.updated_at = params.expected_updated_at",
      );
      expect(reconfirmQuery?.text).toContain(
        "updated_at = write_clock.effective_at",
      );
      expect(reconfirmQuery?.text).toContain(
        "updated_by_user_id = params.updated_by_user_id",
      );
      expect(reconfirmQuery?.text).toContain("THEN 'write_failed'");
      const sql = db.getDb() as ReturnType<typeof db.getDb> & {
        query: ReturnType<typeof vi.fn>;
      };
      expect(sql.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        ["business-commercial:11111111-1111-4111-8111-111111111111"],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns missing without history when no target pack exists", async () => {
    await expect(
      businessCommercial.reconfirmBusinessTargetPack({
        businessId: "11111111-1111-4111-8111-111111111111",
        updatedByUserId: "33333333-3333-4333-8333-333333333333",
        expectedUpdatedAt: "2026-07-01T10:00:00.000Z",
      }),
    ).resolves.toEqual({
      status: "missing",
      reason: "target_pack_missing",
    });
    expect(tableResponses.targetHistory).toHaveLength(0);
  });

  it.each([
    {
      overrides: { target_roas: 1.5, break_even_roas: 1.8 },
      reason: "target_roas_below_break_even_roas",
    },
    {
      overrides: { target_cpa: 60, break_even_cpa: 55 },
      reason: "target_cpa_above_break_even_cpa",
    },
    {
      overrides: { target_roas: 0 },
      reason: "target_roas_must_be_positive_finite",
    },
  ])(
    "does not reconfirm invalid stored economics: $reason",
    async ({ overrides, reason }) => {
      currentTargetPack = {
        business_id: "11111111-1111-4111-8111-111111111111",
        business_ref_id: "business-ref-1",
        target_cpa: 40,
        target_roas: 2.8,
        break_even_cpa: 55,
        break_even_roas: 1.9,
        contribution_margin_assumption: 0.4,
        aov_assumption: 100,
        new_customer_weight: 0.25,
        default_risk_posture: "balanced",
        cost_cogs_percent: 0.3,
        cost_shipping_percent: 0.08,
        cost_fulfillment_percent: 0.05,
        cost_payment_processing_percent: 0.03,
        source_label: "legacy",
        updated_by_user_id: null,
        updated_at: "2026-07-01T10:00:00.000Z",
        ...overrides,
      };

      await expect(
        businessCommercial.reconfirmBusinessTargetPack({
          businessId: "11111111-1111-4111-8111-111111111111",
          updatedByUserId: "33333333-3333-4333-8333-333333333333",
          expectedUpdatedAt: "2026-07-01T10:00:00.000Z",
        }),
      ).resolves.toEqual({
        status: "invalid_target_pack",
        reason,
        currentUpdatedAt: "2026-07-01T10:00:00.000Z",
      });
      expect(tableResponses.targetHistory).toHaveLength(0);
    },
  );

  it("rejects non-positive PUT anchors while preserving explicit nulls", () => {
    const businessId = "11111111-1111-4111-8111-111111111111";
    expect(() =>
      businessCommercial.sanitizeBusinessCommercialTruthInput(businessId, {
        targetPack: { targetRoas: 0 } as never,
      }),
    ).toThrowError(
      "targetPack.targetRoas must be a finite number greater than zero or null.",
    );
    expect(() =>
      businessCommercial.sanitizeBusinessCommercialTruthInput(businessId, {
        targetPack: { targetCpa: -1 } as never,
      }),
    ).toThrowError(
      "targetPack.targetCpa must be a finite number greater than zero or null.",
    );

    const sanitized = businessCommercial.sanitizeBusinessCommercialTruthInput(
      businessId,
      {
        targetPack: {
          targetCpa: null,
          targetRoas: 2.5,
          breakEvenCpa: null,
          breakEvenRoas: 1.8,
        } as never,
      },
    );
    expect(sanitized.targetPack).toMatchObject({
      targetCpa: null,
      targetRoas: 2.5,
      breakEvenCpa: null,
      breakEvenRoas: 1.8,
    });
  });

  it("rejects target-pack metadata without an economic anchor", () => {
    const businessId = "11111111-1111-4111-8111-111111111111";

    expect(() =>
      businessCommercial.sanitizeBusinessCommercialTruthInput(businessId, {
        targetPack: {
          aovAssumption: 100,
          defaultRiskPosture: "balanced",
        } as never,
      }),
    ).toThrowError(
      "targetPack must contain at least one CPA or ROAS economic anchor.",
    );

    expect(
      businessCommercial.sanitizeBusinessCommercialTruthInput(businessId, {
        targetPack: {} as never,
      }).targetPack,
    ).toBeNull();
  });

  it.each([
    [
      "targetPack.aovAssumption",
      { targetPack: { targetRoas: 2.5, aovAssumption: true } },
    ],
    [
      "targetPack.costStructure.cogsPercent",
      {
        targetPack: { targetRoas: 2.5, costStructure: { cogsPercent: [0.3] } },
      },
    ],
    [
      "countryEconomics.economicsMultiplier",
      { countryEconomics: [{ countryCode: "US", economicsMultiplier: "1.2" }] },
    ],
    [
      "calibrationProfiles.targetRoasMultiplier",
      { calibrationProfiles: [{ targetRoasMultiplier: false }] },
    ],
  ])("rejects type-confused secondary numeric field %s", (field, snapshot) => {
    expect(() =>
      businessCommercial.sanitizeBusinessCommercialTruthInput(
        "11111111-1111-4111-8111-111111111111",
        snapshot as never,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "BusinessCommercialInputValidationError",
        field,
      }),
    );
  });

  it("rejects economically inverted ROAS and CPA target pairs", () => {
    const businessId = "11111111-1111-4111-8111-111111111111";

    expect(() =>
      businessCommercial.sanitizeBusinessCommercialTruthInput(businessId, {
        targetPack: {
          targetRoas: 1.7,
          breakEvenRoas: 1.8,
        } as never,
      }),
    ).toThrowError(
      "targetPack.targetRoas must be greater than or equal to targetPack.breakEvenRoas.",
    );

    expect(() =>
      businessCommercial.sanitizeBusinessCommercialTruthInput(businessId, {
        targetPack: {
          targetCpa: 56,
          breakEvenCpa: 55,
        } as never,
      }),
    ).toThrowError(
      "targetPack.targetCpa must be less than or equal to targetPack.breakEvenCpa.",
    );
  });

  it("does not fabricate missing configured anchor values in coverage", async () => {
    tableResponses.targetPack = [
      {
        target_cpa: null,
        target_roas: 2.8,
        break_even_cpa: null,
        break_even_roas: 1.9,
        contribution_margin_assumption: null,
        aov_assumption: null,
        new_customer_weight: null,
        default_risk_posture: "balanced",
        cost_cogs_percent: null,
        cost_shipping_percent: null,
        cost_fulfillment_percent: null,
        cost_payment_processing_percent: null,
        source_label: "settings_manual_entry",
        updated_at: "2026-07-01T10:00:00.123456Z",
        updated_by_user_id: null,
      },
    ];

    const snapshot =
      await businessCommercial.getBusinessCommercialTruthSnapshot(
        "11111111-1111-4111-8111-111111111111",
      );

    expect(snapshot.coverage?.thresholds).toEqual({
      source: "configured_targets",
      targetRoas: 2.8,
      breakEvenRoas: 1.9,
      targetCpa: null,
      breakEvenCpa: null,
      defaultRiskPosture: "balanced",
    });
  });

  it("excludes future versions and treats a delete snapshot as a tombstone", async () => {
    const businessId = "11111111-1111-4111-8111-111111111111";
    tableResponses.targetHistory = [
      {
        id: "history-1",
        business_id: businessId,
        target_cpa: 40,
        target_roas: 2.4,
        break_even_cpa: 55,
        break_even_roas: 1.8,
        contribution_margin_assumption: 0.4,
        aov_assumption: 100,
        new_customer_weight: 0.25,
        default_risk_posture: "balanced",
        cost_cogs_percent: 0.3,
        cost_shipping_percent: 0.08,
        cost_fulfillment_percent: 0.05,
        cost_payment_processing_percent: 0.03,
        source_label: "test",
        updated_by_user_id: null,
        updated_at: "2026-06-01T10:00:00.000Z",
        operation: "upsert",
        effective_at: "2026-06-01T10:00:00.000Z",
        recorded_at: "2026-06-01T10:00:00.000Z",
      },
      {
        id: "history-2",
        business_id: businessId,
        target_cpa: 40,
        target_roas: 3.5,
        break_even_cpa: 55,
        break_even_roas: 1.8,
        contribution_margin_assumption: 0.4,
        aov_assumption: 100,
        new_customer_weight: 0.25,
        default_risk_posture: "balanced",
        cost_cogs_percent: 0.3,
        cost_shipping_percent: 0.08,
        cost_fulfillment_percent: 0.05,
        cost_payment_processing_percent: 0.03,
        source_label: "future",
        updated_by_user_id: null,
        updated_at: "2026-06-05T10:00:00.000Z",
        operation: "upsert",
        effective_at: "2026-06-05T10:00:00.000Z",
        recorded_at: "2026-06-05T10:00:00.000Z",
      },
    ];

    expect(
      (
        await businessCommercial.getBusinessTargetPackHistoryAsOf({
          businessId,
          asOf: "2026-06-02T12:00:00.000Z",
        })
      )?.targetRoas,
    ).toBe(2.4);

    tableResponses.targetHistory.push({
      ...tableResponses.targetHistory[0],
      id: "history-3",
      operation: "delete",
      effective_at: "2026-06-03T09:00:00.000Z",
      recorded_at: "2026-06-03T09:00:00.000Z",
      updated_at: "2026-06-03T09:00:00.000Z",
    });
    expect(
      await businessCommercial.getBusinessTargetPackHistoryAsOf({
        businessId,
        asOf: "2026-06-03T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("uses the scheduled 03:00Z producer cutoff for a date-only asOf", async () => {
    const businessId = "11111111-1111-4111-8111-111111111111";
    tableResponses.targetHistory = [
      {
        id: "before-cutoff",
        business_id: businessId,
        target_roas: 2.4,
        default_risk_posture: "balanced",
        operation: "upsert",
        effective_at: "2026-06-05T02:59:59.000Z",
        recorded_at: "2026-06-05T02:59:59.000Z",
      },
      {
        id: "after-cutoff",
        business_id: businessId,
        target_roas: 9.9,
        default_risk_posture: "balanced",
        operation: "upsert",
        effective_at: "2026-06-05T03:00:01.000Z",
        recorded_at: "2026-06-05T03:00:01.000Z",
      },
    ];

    await expect(
      businessCommercial.getBusinessTargetPackHistoryAsOf({
        businessId,
        asOf: "2026-06-05",
      }),
    ).resolves.toMatchObject({ targetRoas: 2.4 });
  });

  it("writes a delete tombstone before removing current state and makes delete retries inert", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
      await businessCommercial.upsertBusinessCommercialTruthSnapshot({
        businessId: "11111111-1111-4111-8111-111111111111",
        updatedByUserId: "22222222-2222-4222-8222-222222222222",
        snapshot: {
          targetPack: {
            targetCpa: null,
            targetRoas: 2.5,
            breakEvenCpa: null,
            breakEvenRoas: 1.8,
            contributionMarginAssumption: null,
            aovAssumption: null,
            newCustomerWeight: null,
            defaultRiskPosture: "balanced",
            costStructure: null,
            sourceLabel: "test",
            updatedAt: null,
            updatedByUserId: null,
          },
        },
      });

      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
      const deleteInput = {
        businessId: "11111111-1111-4111-8111-111111111111",
        updatedByUserId: "33333333-3333-4333-8333-333333333333",
        snapshot: { targetPack: null },
      };
      await businessCommercial.upsertBusinessCommercialTruthSnapshot(
        deleteInput,
      );
      await businessCommercial.upsertBusinessCommercialTruthSnapshot(
        deleteInput,
      );

      expect(tableResponses.targetHistory.map((row) => row.operation)).toEqual([
        "upsert",
        "delete",
      ]);
      const deleteQuery = queryCalls.find((call) =>
        call.text.includes("DELETE FROM business_target_packs target"),
      );
      expect(deleteQuery?.text.indexOf("history_write AS")).toBeLessThan(
        deleteQuery?.text.indexOf("DELETE FROM business_target_packs target") ??
          -1,
      );
      expect(deleteQuery?.text).toContain("FOR UPDATE OF target");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invent pre-history state from the mutable current target row", async () => {
    tableResponses.targetPack = [
      {
        target_roas: 9.9,
        default_risk_posture: "balanced",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ];

    await expect(
      businessCommercial.getBusinessTargetPackHistoryAsOf({
        businessId: "11111111-1111-4111-8111-111111111111",
        asOf: "2026-05-01",
      }),
    ).resolves.toBeNull();
  });

  it("normalizes database timestamps before building coverage summaries", async () => {
    const updatedAt = new Date("2026-04-10T09:00:00.000Z");
    tableResponses.targetPack = [
      {
        target_cpa: 42,
        target_roas: 2.8,
        break_even_cpa: 55,
        break_even_roas: 1.9,
        contribution_margin_assumption: 0.42,
        aov_assumption: 110,
        new_customer_weight: 0.35,
        default_risk_posture: "balanced",
        cost_cogs_percent: 0.31,
        cost_shipping_percent: 0.09,
        cost_fulfillment_percent: 0.06,
        cost_payment_processing_percent: 0.03,
        source_label: "seed",
        updated_at: updatedAt,
        updated_by_user_id: "22222222-2222-4222-8222-222222222222",
      },
    ];
    tableResponses.countryEconomics = [
      {
        country_code: "US",
        economics_multiplier: 1.1,
        margin_modifier: 0,
        serviceability: "full",
        priority_tier: "tier_1",
        scale_override: "default",
        notes: null,
        source_label: "seed",
        updated_at: updatedAt,
        updated_by_user_id: "22222222-2222-4222-8222-222222222222",
      },
    ];
    tableResponses.operatingConstraints = [
      {
        site_issue_status: "none",
        checkout_issue_status: "none",
        conversion_tracking_issue_status: "none",
        feed_issue_status: "none",
        stock_pressure_status: "healthy",
        landing_page_concern: null,
        merchandising_concern: null,
        manual_do_not_scale_reason: null,
        source_label: "seed",
        updated_at: updatedAt,
        updated_by_user_id: "22222222-2222-4222-8222-222222222222",
      },
    ];
    tableResponses.calibrationProfiles = [
      {
        channel: "meta",
        objective_family: "sales",
        bid_regime: "cost_cap",
        archetype: "winner_scale",
        target_roas_multiplier: 1.08,
        break_even_roas_multiplier: 1.01,
        target_cpa_multiplier: 0.95,
        break_even_cpa_multiplier: 0.99,
        confidence_cap: 0.8,
        action_ceiling: "review_hold",
        notes: null,
        source_label: "seed",
        updated_at: updatedAt,
        updated_by_user_id: "22222222-2222-4222-8222-222222222222",
      },
    ];

    const snapshot =
      await businessCommercial.getBusinessCommercialTruthSnapshot(
        "11111111-1111-4111-8111-111111111111",
      );

    expect(snapshot?.sectionMeta.targetPack.updatedAt).toBe(
      updatedAt.toISOString(),
    );
    expect(snapshot?.coverage?.freshness.updatedAt).toBe(
      updatedAt.toISOString(),
    );
    expect(snapshot?.coverage?.calibration.updatedAt).toBe(
      updatedAt.toISOString(),
    );
    expect(snapshot?.targetPack?.costStructure).toEqual({
      cogsPercent: 0.31,
      shippingPercent: 0.09,
      fulfillmentPercent: 0.06,
      paymentProcessingPercent: 0.03,
    });
  });

  it("treats missing country economics as non-blocking global economics context", async () => {
    const updatedAt = new Date("2026-04-10T09:00:00.000Z");
    tableResponses.targetPack = [
      {
        target_cpa: null,
        target_roas: 2.8,
        break_even_cpa: null,
        break_even_roas: 1.9,
        contribution_margin_assumption: null,
        aov_assumption: null,
        new_customer_weight: null,
        default_risk_posture: "balanced",
        cost_cogs_percent: null,
        cost_shipping_percent: null,
        cost_fulfillment_percent: null,
        cost_payment_processing_percent: null,
        source_label: "seed",
        updated_at: updatedAt,
        updated_by_user_id: "22222222-2222-4222-8222-222222222222",
      },
    ];
    tableResponses.countryEconomics = [];
    tableResponses.operatingConstraints = [
      {
        site_issue_status: "none",
        checkout_issue_status: "none",
        conversion_tracking_issue_status: "none",
        feed_issue_status: "none",
        stock_pressure_status: "healthy",
        landing_page_concern: null,
        merchandising_concern: null,
        manual_do_not_scale_reason: null,
        source_label: "seed",
        updated_at: updatedAt,
        updated_by_user_id: "22222222-2222-4222-8222-222222222222",
      },
    ];

    const snapshot =
      await businessCommercial.getBusinessCommercialTruthSnapshot(
        "11111111-1111-4111-8111-111111111111",
      );

    const countryRequirement = snapshot.coverage?.requiredInputs.find(
      (input) => input.section === "countryEconomics",
    );
    expect(countryRequirement?.blocking).toBe(false);
    expect(countryRequirement?.actionCeiling).toBeNull();
    expect(snapshot.coverage?.blockingReasons.join(" ")).not.toContain(
      "Country economics",
    );
    expect(snapshot.coverage?.nonBlockingReasons.join(" ")).toContain(
      "global cost structure",
    );
    expect(snapshot.coverage?.actionCeilings).not.toContain(
      "monitor_low_truth",
    );
  });

  it("keeps target age in review metadata without creating a blocking coverage gap", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      const oldTargetAt = new Date("2026-05-01T00:00:00.000Z");
      const currentConstraintsAt = new Date("2026-07-14T00:00:00.000Z");
      tableResponses.targetPack = [
        {
          target_cpa: null,
          target_roas: 2.8,
          break_even_cpa: null,
          break_even_roas: 1.9,
          contribution_margin_assumption: null,
          aov_assumption: null,
          new_customer_weight: null,
          default_risk_posture: "balanced",
          cost_cogs_percent: null,
          cost_shipping_percent: null,
          cost_fulfillment_percent: null,
          cost_payment_processing_percent: null,
          source_label: "seed",
          updated_at: oldTargetAt,
          updated_by_user_id: "22222222-2222-4222-8222-222222222222",
        },
      ];
      tableResponses.operatingConstraints = [
        {
          site_issue_status: "none",
          checkout_issue_status: "none",
          conversion_tracking_issue_status: "none",
          feed_issue_status: "none",
          stock_pressure_status: "healthy",
          landing_page_concern: null,
          merchandising_concern: null,
          manual_do_not_scale_reason: null,
          source_label: "seed",
          updated_at: currentConstraintsAt,
          updated_by_user_id: "22222222-2222-4222-8222-222222222222",
        },
      ];

      const snapshot =
        await businessCommercial.getBusinessCommercialTruthSnapshot(
          "11111111-1111-4111-8111-111111111111",
        );
      const targetRequirement = snapshot.coverage?.requiredInputs.find(
        (input) => input.section === "targetPack",
      );

      expect(targetRequirement?.freshness.status).toBe("stale");
      expect(snapshot.coverage).toMatchObject({
        completeness: "complete",
        freshness: { status: "fresh" },
        blockingReasons: [],
      });
      expect(snapshot.coverage?.nonBlockingReasons.join(" ")).toContain(
        "older than 30 days",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a future target confirmation timestamp in blocking provenance", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      tableResponses.targetPack = [
        {
          target_cpa: null,
          target_roas: 2.8,
          break_even_cpa: null,
          break_even_roas: 1.9,
          contribution_margin_assumption: null,
          aov_assumption: null,
          new_customer_weight: null,
          default_risk_posture: "balanced",
          cost_cogs_percent: null,
          cost_shipping_percent: null,
          cost_fulfillment_percent: null,
          cost_payment_processing_percent: null,
          source_label: "seed",
          updated_at: new Date("2099-01-01T00:00:00.000Z"),
          updated_by_user_id: "22222222-2222-4222-8222-222222222222",
        },
      ];
      tableResponses.operatingConstraints = [
        {
          site_issue_status: "none",
          checkout_issue_status: "none",
          conversion_tracking_issue_status: "none",
          feed_issue_status: "none",
          stock_pressure_status: "healthy",
          landing_page_concern: null,
          merchandising_concern: null,
          manual_do_not_scale_reason: null,
          source_label: "seed",
          updated_at: new Date("2026-07-14T00:00:00.000Z"),
          updated_by_user_id: "22222222-2222-4222-8222-222222222222",
        },
      ];

      const snapshot =
        await businessCommercial.getBusinessCommercialTruthSnapshot(
          "11111111-1111-4111-8111-111111111111",
        );
      const targetRequirement = snapshot.coverage?.requiredInputs.find(
        (input) => input.section === "targetPack",
      );

      expect(targetRequirement).toMatchObject({
        freshness: { status: "stale", ageHours: null },
        actionCeiling: "review_hold",
      });
      expect(snapshot.coverage?.freshness.status).toBe("stale");
      expect(snapshot.coverage?.blockingReasons.join(" ")).toContain(
        "cutoff-unsafe",
      );
      expect(snapshot.coverage?.nonBlockingReasons.join(" ")).not.toContain(
        "older than 30 days",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
