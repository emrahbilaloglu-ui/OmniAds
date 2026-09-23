import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));

import {
  effectiveDatedConfigFieldScope,
  normalizeDatedRawConfig,
  readDatedRawConfigReceipts,
  splitMetaConfigFieldScope,
} from "@/lib/meta/raw-config-receipts";

beforeEach(() => query.mockReset());

describe("dated raw Meta configuration", () => {
  it("does not authorize a field omitted by a degraded request", () => {
    expect(effectiveDatedConfigFieldScope("id,objective,updated_time", {
      recovered: true, droppedFields: "objective",
    })).toEqual(["id", "updated_time"]);
    expect(effectiveDatedConfigFieldScope("id,objective,updated_time", {
      recovered: true,
    })).toEqual([]);
    expect(normalizeDatedRawConfig({
      level: "campaign",
      row: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "2500" },
      fields: "id,objective,daily_budget", droppedFields: "objective",
    })).toMatchObject({ objective: null, dailyBudget: 2500 });
  });

  it("preserves nested field selectors and retains a budget when objective is absent", () => {
    expect(splitMetaConfigFieldScope(
      "id,objective,promoted_object{pixel_id,custom_event_type},bid_constraints{roas_average_floor}",
    )).toEqual([
      "id", "objective", "promoted_object{pixel_id,custom_event_type}",
      "bid_constraints{roas_average_floor}",
    ]);
    expect(normalizeDatedRawConfig({
      level: "campaign", row: { id: "c1" }, fields: "id,objective",
    })).toBeNull();
    expect(normalizeDatedRawConfig({
      level: "campaign", row: { id: "c1", daily_budget: "2500" },
      fields: "id,objective,daily_budget",
    })).toMatchObject({ objective: null, dailyBudget: 2500 });
    expect(normalizeDatedRawConfig({
      level: "campaign", row: { id: "c1", objective: "OUTCOME_LEADS", daily_budget: "2500" },
      fields: "id,objective,daily_budget",
    })).toMatchObject({ objective: "OUTCOME_LEADS", dailyBudget: 2500 });
  });

  it("keeps VALUE distinct from a purchase event and reads an adset ROAS bid", () => {
    const result = normalizeDatedRawConfig({
      level: "adset",
      row: {
        id: "a1", campaign_id: "c1", optimization_goal: "VALUE",
        bid_strategy: "LOWEST_COST_WITH_MIN_ROAS",
        bid_constraints: { roas_average_floor: "150" },
      },
      fields: "id,campaign_id,optimization_goal,bid_strategy,bid_constraints{roas_average_floor}",
    });
    expect(result).toMatchObject({
      optimizationGoal: "Value",
      customEventType: null,
      bidStrategyType: "target_roas",
      bidValueFormat: "roas",
    });
    expect(normalizeDatedRawConfig({
      level: "adset",
      row: { id: "a1", campaign_id: "unrequested-parent", optimization_goal: "VALUE" },
      fields: "id,optimization_goal",
    })).toMatchObject({ campaignId: null, optimizationGoal: "Value" });
  });

  it("bounds the source by the provider day and retains raw identity", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "America/Los_Angeles" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00-0700" },
      snapshot_id: "source-1",
      observed_at: "2026-09-20T22:30:00Z",
      request_context: {
        fields: "id,objective,updated_time,start_time,stop_time",
        pagination: { complete: true, termination: "natural_end",
          fieldDegradation: { recovered: true, droppedFields: ["start_time", "stop_time"] } },
      },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00-0700" },
      snapshot_id: "confirm-1",
      observed_at: "2026-09-21T08:00:00Z",
      request_context: {
        fields: "id,objective,updated_time,start_time,stop_time",
        pagination: { complete: true, termination: "natural_end" },
      },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    const queryText = String(query.mock.calls[1]![0]);
    expect(queryText).toContain("request_context->'pagination'->>'complete' = 'true'");
    expect(queryText).toContain("request_context->'pagination'->>'termination' = 'natural_end'");
    expect(queryText).toContain("observation.provider_http_status = 200");
    expect(queryText).toContain("snapshot.provider_http_status = 200");
    expect(queryText).toContain("observation.entity_scope = $7");
    expect(queryText).toContain("snapshot.entity_scope = $7");
    expect(queryText).toContain("rowObservedAtByEntityId");
    expect(queryText).toContain("pg_input_is_valid(");
    expect(queryText).toContain("[.][0-9]{3}Z$");
    expect(queryText).toContain("pageCount' = '1'");
    expect(queryText).not.toContain("start_date");
    expect(query.mock.calls[1]![1]).toEqual([
      "biz-1", "act_1", "campaign_configs",
      "2026-09-20T07:00:00.000Z", "2026-09-21T07:00:00.000Z", ["c1"], "campaign",
    ]);
    expect(query.mock.calls[2]![1]).toEqual([
      "biz-1", "act_1", "campaign_configs", "2026-09-21T07:00:00.000Z", ["c1"], "campaign",
    ]);
    expect(String(query.mock.calls[2]![0])).toContain("pg_input_is_valid(");
    expect(rows.get("c1")).toMatchObject({
      payload: { objective: "OUTCOME_SALES" },
      source: { id: "source-1", observedAt: "2026-09-20T22:30:00.000Z",
        corroboratingSourceSnapshotId: "confirm-1",
        corroboratingObservedAt: "2026-09-21T08:00:00.000Z",
        accountTimezone: "America/Los_Angeles",
        fieldScope: ["id", "objective", "updated_time"],
        observedFieldScope: ["id", "objective", "updated_time"] },
    });
  });

  it("does not treat one in-day response as whole-day history without a later unchanged receipt", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "source-1", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    query.mockResolvedValueOnce([]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
  });

  it("refuses a provider update clock with no timezone instead of using the machine timezone", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "America/Los_Angeles" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00" },
      snapshot_id: "source-1", observed_at: "2026-09-20T22:30:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end", pageCount: 1,
      } },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("accepts a zoned provider clock with microseconds, as the decision source does", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const entity_json = {
      id: "c1", objective: "OUTCOME_SALES",
      updated_time: "2026-09-19T20:00:00.123456+0000",
    };
    const request_context = {
      fields: "id,objective,updated_time",
      pagination: { complete: true, termination: "natural_end", pageCount: 1 },
    };
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json, snapshot_id: "source-1",
      observed_at: "2026-09-20T18:00:00Z", request_context,
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json, snapshot_id: "confirm-1",
      observed_at: "2026-09-21T12:00:00Z", request_context,
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    expect(rows.get("c1")?.payload.objective).toBe("OUTCOME_SALES");
    expect(rows.get("c1")?.source.entityUpdatedAt).toBe(entity_json.updated_time);
  });

  it("refuses a calendar-invalid provider clock that JavaScript would roll forward", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: {
        id: "c1", objective: "OUTCOME_SALES",
        updated_time: "2026-02-31T20:00:00Z",
      },
      snapshot_id: "source-1", observed_at: "2026-03-01T18:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end", pageCount: 1,
      } },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-03-01",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("corroborates the objective without inventing an omitted later budget", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "2500",
        updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "source-1", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES",
        updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "confirm-1", observed_at: "2026-09-21T12:00:00Z",
      request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    expect(rows.get("c1")?.payload).toMatchObject({
      objective: "OUTCOME_SALES", dailyBudget: null,
    });
    expect(rows.get("c1")?.source.observedFieldScope).not.toContain("daily_budget");
  });

  it("keeps a corroborated objective when the later budget changed", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "2500",
        updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "source-1", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "3000",
        updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "confirm-1", observed_at: "2026-09-21T12:00:00Z",
      request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    expect(rows.get("c1")?.payload).toMatchObject({
      objective: "OUTCOME_SALES", dailyBudget: null,
    });
    expect(rows.get("c1")?.source.observedFieldScope).not.toContain("daily_budget");
  });

  it("recovers an earlier objective when a newer same-day response dropped only that field", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const updated_time = "2026-09-19T20:00:00Z";
    query.mockResolvedValueOnce([
      {
        entity_id: "c1",
        entity_json: { id: "c1", daily_budget: "3000", updated_time },
        snapshot_id: "source-b", observed_at: "2026-09-20T19:00:00Z",
        receipt_observed_at: "2026-09-20T19:00:01Z",
        request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
          complete: true, termination: "natural_end",
          fieldDegradation: { recovered: true, droppedFields: ["objective"] },
        } },
      },
      {
        entity_id: "c1",
        entity_json: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "2500", updated_time },
        snapshot_id: "source-a", observed_at: "2026-09-20T18:00:00Z",
        receipt_observed_at: "2026-09-20T18:00:01Z",
        request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
          complete: true, termination: "natural_end",
        } },
      },
    ]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time },
      snapshot_id: "confirm-c", observed_at: "2026-09-21T08:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end",
      } },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    expect(rows.get("c1")?.payload).toMatchObject({ objective: "OUTCOME_SALES", dailyBudget: null });
    expect(rows.get("c1")?.source).toMatchObject({
      id: "source-a", corroboratingSourceSnapshotId: "confirm-c",
      observedFieldScope: ["id", "objective", "updated_time"],
    });
  });

  it.each([
    {
      label: "the newer response requested objective but omitted it",
      fields: "id,objective,updated_time",
      updated_time: "2026-09-19T20:00:00Z",
      observed_at: "2026-09-20T19:00:00Z",
    },
    {
      label: "the provider update clock changed",
      fields: "id,updated_time",
      updated_time: "2026-09-20T18:30:00Z",
      observed_at: "2026-09-20T19:00:00Z",
    },
    {
      label: "the provider update clock is absent",
      fields: "id,updated_time",
      updated_time: undefined,
      observed_at: "2026-09-20T19:00:00Z",
    },
    {
      label: "the newer page has no per-entity clock",
      fields: "id,updated_time",
      updated_time: "2026-09-19T20:00:00Z",
      observed_at: null,
    },
  ])("does not carry an earlier objective past $label", async (newer) => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([
      {
        entity_id: "c1",
        entity_json: { id: "c1", ...(newer.updated_time ? { updated_time: newer.updated_time } : {}) },
        snapshot_id: "source-b", observed_at: newer.observed_at,
        receipt_observed_at: "2026-09-20T19:00:01Z",
        request_context: { fields: newer.fields, pagination: {
          complete: true, termination: "natural_end", pageCount: 2,
        } },
      },
      {
        entity_id: "c1",
        entity_json: { id: "c1", objective: "OUTCOME_SALES",
          updated_time: "2026-09-19T20:00:00Z" },
        snapshot_id: "source-a", observed_at: "2026-09-20T18:00:00Z",
        receipt_observed_at: "2026-09-20T18:00:01Z",
        request_context: { fields: "id,objective,updated_time", pagination: {
          complete: true, termination: "natural_end", pageCount: 1,
        } },
      },
    ]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
    expect(String(query.mock.calls[1]![0])).toContain("OR entity_observation.observed_at IS NULL");
  });

  it("recovers a dropped ad-set promoted object without borrowing the newer goal", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const updated_time = "2026-09-19T20:00:00Z";
    query.mockResolvedValueOnce([
      {
        entity_id: "a1", entity_json: { id: "a1", optimization_goal: "VALUE", updated_time },
        snapshot_id: "source-b", observed_at: "2026-09-20T19:00:00Z",
        receipt_observed_at: "2026-09-20T19:00:01Z",
        request_context: { fields: "id,optimization_goal,promoted_object{custom_event_type},updated_time",
          pagination: { complete: true, termination: "natural_end",
            fieldDegradation: { recovered: true, droppedFields: ["promoted_object"] } } },
      },
      {
        entity_id: "a1", entity_json: { id: "a1", optimization_goal: "VALUE",
          promoted_object: { custom_event_type: "PURCHASE" }, updated_time },
        snapshot_id: "source-a", observed_at: "2026-09-20T18:00:00Z",
        receipt_observed_at: "2026-09-20T18:00:01Z",
        request_context: { fields: "id,optimization_goal,promoted_object{custom_event_type},updated_time",
          pagination: { complete: true, termination: "natural_end" } },
      },
    ]);
    query.mockResolvedValueOnce([{
      entity_id: "a1", entity_json: { id: "a1",
        promoted_object: { custom_event_type: "PURCHASE" }, updated_time },
      snapshot_id: "confirm-c", observed_at: "2026-09-21T08:00:00Z",
      request_context: { fields: "id,promoted_object{custom_event_type},updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "adset", entityIds: ["a1"],
    });
    expect(rows.get("a1")?.payload).toMatchObject({
      customEventType: "PURCHASE", optimizationGoal: null,
    });
    expect(rows.get("a1")?.source.id).toBe("source-a");
  });

  it("finds the first later objective observation past a response that dropped only objective", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const updated_time = "2026-09-19T20:00:00Z";
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "2500", updated_time },
      snapshot_id: "source-a", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
        complete: true, termination: "natural_end", pageCount: 1,
      } },
    }]);
    query.mockResolvedValueOnce([
      {
        entity_id: "c1",
        entity_json: { id: "c1", daily_budget: "3000", updated_time },
        snapshot_id: "confirm-b", observed_at: "2026-09-21T07:30:00Z",
        request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
          complete: true, termination: "natural_end", pageCount: 1,
          fieldDegradation: { recovered: true, droppedFields: ["objective"] },
        } },
      },
      {
        entity_id: "c1",
        entity_json: { id: "c1", objective: "OUTCOME_SALES", daily_budget: "3000", updated_time },
        snapshot_id: "confirm-c", observed_at: "2026-09-21T08:00:00Z",
        request_context: { fields: "id,objective,daily_budget,updated_time", pagination: {
          complete: true, termination: "natural_end", pageCount: 1,
        } },
      },
    ]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    expect(String(query.mock.calls[2]![0])).not.toContain("DISTINCT ON");
    // B's budget is independently corroborated by C, but this return type has
    // one raw source identity. A's objective and B's budget cannot be merged.
    expect(rows.get("c1")?.payload).toMatchObject({
      objective: "OUTCOME_SALES", dailyBudget: null,
    });
    expect(rows.get("c1")?.source).toMatchObject({
      id: "source-a", corroboratingSourceSnapshotId: "confirm-c",
      observedFieldScope: ["id", "objective", "updated_time"],
    });
  });

  it.each([
    {
      label: "requested objective was absent",
      fields: "id,objective,updated_time",
      entity: { id: "c1", updated_time: "2026-09-19T20:00:00Z" },
      observed_at: "2026-09-21T07:30:00Z",
    },
    {
      label: "objective changed and then reverted",
      fields: "id,objective,updated_time",
      entity: { id: "c1", objective: "OUTCOME_LEADS", updated_time: "2026-09-19T20:00:00Z" },
      observed_at: "2026-09-21T07:30:00Z",
    },
    {
      label: "provider clock changed and then reverted",
      fields: "id,updated_time",
      entity: { id: "c1", updated_time: "2026-09-20T22:00:00Z" },
      observed_at: "2026-09-21T07:30:00Z",
    },
    {
      label: "provider clock was absent",
      fields: "id,updated_time",
      entity: { id: "c1" },
      observed_at: "2026-09-21T07:30:00Z",
    },
    {
      label: "page clock was absent",
      fields: "id,updated_time",
      entity: { id: "c1", updated_time: "2026-09-19T20:00:00Z" },
      observed_at: null,
    },
  ])("does not pass a later $label on the way to a corroborator", async (barrier) => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const updated_time = "2026-09-19T20:00:00Z";
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time },
      snapshot_id: "source-a", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end", pageCount: 1,
      } },
    }]);
    query.mockResolvedValueOnce([
      {
        entity_id: "c1", entity_json: barrier.entity,
        snapshot_id: "confirm-b", observed_at: barrier.observed_at,
        receipt_observed_at: "2026-09-21T07:31:00Z",
        request_context: { fields: barrier.fields, pagination: {
          complete: true, termination: "natural_end", pageCount: 2,
        } },
      },
      {
        entity_id: "c1",
        entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time },
        snapshot_id: "confirm-c", observed_at: "2026-09-21T08:00:00Z",
        receipt_observed_at: "2026-09-21T08:01:00Z",
        request_context: { fields: "id,objective,updated_time", pagination: {
          complete: true, termination: "natural_end", pageCount: 1,
        } },
      },
    ]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
    expect(String(query.mock.calls[2]![0])).toContain("OR entity_observation.observed_at IS NULL");
  });

  it("does not reinterpret an old bid amount under a changed bid strategy", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES",
        bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: "1200",
        updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "source-1", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,bid_strategy,bid_amount,updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_amount: "1200",
        updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "confirm-1", observed_at: "2026-09-21T12:00:00Z",
      request_context: { fields: "id,objective,bid_strategy,bid_amount,updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    expect(rows.get("c1")?.payload.objective).toBe("OUTCOME_SALES");
    expect(rows.get("c1")?.payload.bidValue).toBeNull();
    expect(rows.get("c1")?.source.observedFieldScope).not.toContain("bid_amount");
  });

  /*
    ── THE DAY-CLOSING WITNESS IS A RECEIPT, NOT A PAYLOAD ─────────────────────

    `meta_raw_snapshots` deduplicates payloads, so two genuine GETs of unchanged
    configuration SHARE a snapshot id. Receipt identity lives in
    `meta_raw_snapshot_observations`, whose unique key includes `observed_at`,
    so each distinct observation instant is its own row.

    An earlier guard here compared snapshot ids and was wrong: it discarded real
    second witnesses. Verified read-only on production for the case that
    prompted it — Silveristic ad set 120251869715690343, 2026-09-11: source
    e5511bab (2026-09-12T04:53:37.979Z) and witness c86e1e4b (T05:00:07.888Z)
    are separate fetched/HTTP 200/natural_end rows, each created_at equal to its
    own observed_at, same partition, on one canonical snapshot 0d629df6 that
    carries 211 observations over 24 hours.
  */
  it("accepts a second OBSERVATION of the same canonical snapshot", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const entity = { id: "c1", objective: "OUTCOME_SALES",
      updated_time: "2026-09-19T20:00:00Z" };
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity,
      snapshot_id: "shared-content-1", observation_id: "e5511bab",
      observed_at: "2026-09-20T23:53:37Z",
      request_context: { fields: "id,objective,updated_time",
        pagination: { complete: true, termination: "natural_end", pageCount: "1" } },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity,
      snapshot_id: "shared-content-1", observation_id: "c86e1e4b",
      observed_at: "2026-09-21T00:00:07Z",
      request_context: { fields: "id,objective,updated_time",
        pagination: { complete: true, termination: "natural_end", pageCount: "1" } },
    }]);
    const receipt = (await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).get("c1");
    expect(receipt?.payload.objective).toBe("OUTCOME_SALES");
    /* Content id is shared, and that is fine; the RECEIPTS differ. */
    expect(receipt?.source.id).toBe("shared-content-1");
    expect(receipt?.source.corroboratingSourceSnapshotId).toBe("shared-content-1");
    expect(receipt?.source.observationId).toBe("e5511bab");
    expect(receipt?.source.corroboratingObservationId).toBe("c86e1e4b");
  });

  it("refuses a day-closing witness that is the SAME observation", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const entity = { id: "c1", objective: "OUTCOME_SALES",
      updated_time: "2026-09-19T20:00:00Z" };
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity,
      snapshot_id: "shared-content-1", observation_id: "only-receipt-1",
      observed_at: "2026-09-20T23:53:00Z",
      request_context: { fields: "id,objective,updated_time",
        pagination: { complete: true, termination: "natural_end", pageCount: "1" } },
    }]);
    /* The same receipt row, returned again by the later query. */
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity,
      snapshot_id: "shared-content-1", observation_id: "only-receipt-1",
      observed_at: "2026-09-21T00:06:00Z",
      request_context: { fields: "id,objective,updated_time",
        pagination: { complete: true, termination: "natural_end", pageCount: "1" } },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
  });

  it("refuses same-snapshot legacy rows that carry no receipt identity", async () => {
    /* A snapshot-only receipt has no observation row, so two of them on one
       canonical snapshot cannot be shown to be different GETs. Unknown identity
       falls back to the content id and is refused. */
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const entity = { id: "c1", objective: "OUTCOME_SALES",
      updated_time: "2026-09-19T20:00:00Z" };
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity,
      snapshot_id: "legacy-1", observation_id: null,
      observed_at: "2026-09-20T23:53:00Z",
      request_context: { fields: "id,objective,updated_time",
        pagination: { complete: true, termination: "natural_end", pageCount: "1" } },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity,
      snapshot_id: "legacy-1", observation_id: null,
      observed_at: "2026-09-21T00:06:00Z",
      request_context: { fields: "id,objective,updated_time",
        pagination: { complete: true, termination: "natural_end", pageCount: "1" } },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
  });

  it("skips the same receipt and takes a genuinely later one", async () => {
    /* Skipping is `continue`, not `break`: one receipt seen twice cannot itself
       be an intervening config change. */
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const entity = { id: "c1", objective: "OUTCOME_SALES",
      updated_time: "2026-09-19T20:00:00Z" };
    const ctx = { fields: "id,objective,updated_time",
      pagination: { complete: true, termination: "natural_end", pageCount: "1" } };
    query.mockResolvedValueOnce([{
      entity_id: "c1", entity_json: entity, snapshot_id: "content-1",
      observation_id: "receipt-1", observed_at: "2026-09-20T23:53:00Z",
      request_context: ctx,
    }]);
    query.mockResolvedValueOnce([
      { entity_id: "c1", entity_json: entity, snapshot_id: "content-1",
        observation_id: "receipt-1", observed_at: "2026-09-21T00:06:00Z",
        request_context: ctx },
      { entity_id: "c1", entity_json: entity, snapshot_id: "content-2",
        observation_id: "receipt-2", observed_at: "2026-09-21T04:00:00Z",
        request_context: ctx },
    ]);
    const receipt = (await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).get("c1");
    expect(receipt?.source.corroboratingObservationId).toBe("receipt-2");
    expect(receipt?.source.corroboratingSourceSnapshotId).toBe("content-2");
  });

  it("selects the observation id in both receipt queries", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([]);
    await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    });
    const candidateSql = String(query.mock.calls[1]![0]);
    expect(candidateSql).toContain("observation.id AS observation_id");
    expect(candidateSql).toContain("NULL::uuid AS observation_id");
    expect(candidateSql).toContain("valid.observation_id::text AS observation_id");
  });

  /*
    ── A BID STRATEGY IS READ, NEVER INFERRED, IN HISTORY ──────────────────────
    `normalizeBidStrategy` turns an absent strategy beside a bid amount into
    "manual_bid". That is right for a live entity and wrong for history, where
    "absent" also covers "never requested". Live example: ColorFull bc0c6178,
    ad set 120243489401810340, 2026-07-25 — a receipt carrying bid_amount but no
    bid_strategy produced bidStrategyType "manual_bid", while the same account's
    parent campaign was read as cost_cap from a receipt that did request it.
  */
  it("drops the whole bid triple when the provider never stated a bid strategy", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const adset = { id: "a1", campaign_id: "c1", optimization_goal: "OFFSITE_CONVERSIONS",
      promoted_object: { pixel_id: "px1", custom_event_type: "PURCHASE" },
      bid_amount: "2000", updated_time: "2026-07-23T09:34:54Z" };
    query.mockResolvedValueOnce([{
      entity_id: "a1", entity_json: adset,
      snapshot_id: "source-1", observed_at: "2026-07-25T17:42:14Z",
      request_context: {
        fields: "id,campaign_id,optimization_goal,promoted_object{pixel_id,custom_event_type},bid_amount,updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "a1", entity_json: adset,
      snapshot_id: "confirm-1", observed_at: "2026-07-28T04:08:19Z",
      request_context: {
        fields: "id,campaign_id,optimization_goal,promoted_object{pixel_id,custom_event_type},bid_amount,updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    const rows = await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-07-25",
      level: "adset", entityIds: ["a1"],
    });
    const receipt = rows.get("a1");
    /* The inference is gone... */
    expect(receipt?.payload.bidStrategyType).toBeNull();
    expect(receipt?.payload.bidStrategyType).not.toBe("manual_bid");
    expect(receipt?.payload.bidValue).toBeNull();
    expect(receipt?.payload.bidValueFormat).toBeNull();
    expect(receipt?.source.observedFieldScope).not.toContain("bid_amount");
    /* ...and the fields the receipt really did state survive. */
    expect(receipt?.payload.optimizationGoal).toBe("Offsite Conversions");
    expect(receipt?.payload.customEventType).toBe("PURCHASE");
    expect(receipt?.payload.pixelId).toBe("px1");
  });

  it("keeps a bid strategy the provider did state, with its amount", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    const adset = { id: "a1", campaign_id: "c1", optimization_goal: "OFFSITE_CONVERSIONS",
      bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: "12000",
      updated_time: "2026-09-18T09:00:00Z" };
    query.mockResolvedValueOnce([{
      entity_id: "a1", entity_json: adset,
      snapshot_id: "source-1", observed_at: "2026-09-20T23:56:00Z",
      request_context: { fields: "id,campaign_id,optimization_goal,bid_strategy,bid_amount,updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "a1", entity_json: adset,
      snapshot_id: "confirm-1", observed_at: "2026-09-21T00:05:00Z",
      request_context: { fields: "id,campaign_id,optimization_goal,bid_strategy,bid_amount,updated_time",
        pagination: { complete: true, termination: "natural_end" } },
    }]);
    const receipt = (await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "adset", entityIds: ["a1"],
    })).get("a1");
    expect(receipt?.payload.bidStrategyType).toBe("bid_cap");
    expect(receipt?.payload.bidValue).toBe(12000);
    expect(receipt?.source.observedFieldScope).toContain("bid_strategy");
  });

  it("rejects a later matching objective when the provider update clock changed", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "source-1", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-20T22:00:00Z" },
      snapshot_id: "later-1", observed_at: "2026-09-21T06:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
  });

  it("does not bridge a multi-day observation gap beyond the shared corroboration horizon", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "source-1", observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end", pageCount: 1,
      } },
    }]);
    // A broken or mocked SQL result cannot bypass the application guard.
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-19T20:00:00Z" },
      snapshot_id: "late-1", observed_at: "2026-09-24T12:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end", pageCount: 1,
      } },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
    expect(String(query.mock.calls[2]![0])).toContain("interval '3 days'");
  });

  it("withholds a same-day observation whose entity changed during that day", async () => {
    query.mockResolvedValueOnce([{ provider_account_id: "act_1", timezone: "UTC" }]);
    query.mockResolvedValueOnce([{
      entity_id: "c1",
      entity_json: { id: "c1", objective: "OUTCOME_SALES", updated_time: "2026-09-20T12:00:00Z" },
      snapshot_id: "source-1",
      observed_at: "2026-09-20T18:00:00Z",
      request_context: { fields: "id,objective,updated_time", pagination: {
        complete: true, termination: "natural_end" },
      },
    }]);
    expect(await readDatedRawConfigReceipts({
      businessId: "biz-1", providerAccountId: "act_1", day: "2026-09-20",
      level: "campaign", entityIds: ["c1"],
    })).toEqual(new Map());
  });
});
