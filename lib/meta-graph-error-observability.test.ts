import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchMetaAdAccounts, getMetaApiErrorMessage } from "@/lib/meta-ad-accounts";

/*
  The only stub in this file that is not `fetch`.

  `buildMetaStatusConfigObservation` reads previously observed schedules back
  through `readMetaEntityStatesAsOf` so a degraded response cannot destroy them,
  and that read is the one thing in the decision path that needs a database.
  Everything else in the module — the mappers, the hash inputs, the observed-at
  resolution — stays the real implementation via `importOriginal`.
*/
const priorObservedStates = vi.hoisted(() => ({
  rows: [] as unknown[],
  throws: false,
  calls: 0,
}));
vi.mock("@/lib/meta/entity-state-history", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/entity-state-history")>();
  return {
    ...actual,
    readMetaEntityStatesAsOf: vi.fn(async () => {
      priorObservedStates.calls += 1;
      if (priorObservedStates.throws) throw new Error("state read unavailable");
      return priorObservedStates.rows;
    }),
  };
});

import {
  buildMetaStatusConfigObservation,
  fetchMetaAdSetConfigs,
  fetchMetaAdSetConfigsReceipt,
  fetchMetaCampaignConfigsReceipt,
  mapCampaignObservationState,
  type MetaCredentials,
} from "@/lib/api/meta";
import { classifyMetaSyncFailure } from "@/lib/sync/meta-error-classification";

/*
  Area 2a — Meta Graph error observability and pagination safety.

  These drive the real production fetchers (the ones the bulk core sync and the
  ad-account refresh call) against a stubbed global fetch that answers with the
  exact body shapes Meta returns. Nothing here hand-builds a receipt: the point
  is what the fetch loop records and how many times it calls the provider.

  The failure this pins down is live. Read on 2026-09-07, `meta_raw_snapshots`
  held 1,553 `adset_configs` and 68 `campaign_configs` HTTP 400s whose entire
  stored cause was the string "Meta collection request failed with status
  400." — no code, no subcode, no fbtrace_id, because the failure path never
  read the error body at all.
*/

const ACCESS_TOKEN = "test-access-token";

/** The body Meta returns when a field is not readable on the addressed node. */
function permanentGraphErrorBody() {
  return {
    error: {
      message:
        "(#100) Tried accessing nonexisting field (example_field) on node type (Campaign)",
      type: "OAuthException",
      code: 100,
      error_subcode: 33,
      is_transient: false,
      fbtrace_id: "AbCdEfGhIjKlMnOp",
    },
  };
}

/**
 * A permanent HTTP 400 that has nothing to do with the schedule fields.
 *
 * Code 294 is Meta's "managing advertisements requires an extended access
 * token" — a permissions refusal of the whole request. Narrowing the field list
 * cannot fix it, and it carries no `is_transient`, so the loop classifies it
 * permanent off the code alone.
 */
function unrelatedPermanentGraphErrorBody() {
  return {
    error: {
      message:
        "(#294) Managing advertisements requires an extended access token.",
      type: "OAuthException",
      code: 294,
      error_subcode: 1487390,
      fbtrace_id: "PeRmIsSiOnErR001",
    },
  };
}

/** The body Meta returns when it sheds load: an HTTP 400 marked retryable. */
function transientGraphErrorBody() {
  return {
    error: {
      message:
        "Please reduce the amount of data you're asking for, then retry your request",
      type: "OAuthException",
      code: 1,
      error_subcode: 99,
      is_transient: true,
      fbtrace_id: "TrAnSiEnTtRaCe01",
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const warnCalls: unknown[][] = [];
let restoreWarn = () => {};

beforeEach(() => {
  vi.unstubAllGlobals();
  priorObservedStates.rows = [];
  priorObservedStates.throws = false;
  priorObservedStates.calls = 0;
  // The loop now warns on every rejected page. Capture it rather than letting
  // it print, and assert on what it carries.
  warnCalls.length = 0;
  const spy = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      warnCalls.push(args);
    });
  restoreWarn = () => spy.mockRestore();
});

afterEach(() => {
  restoreWarn();
  vi.unstubAllGlobals();
});

describe("Meta Graph non-OK response observability", () => {
  it("records the Graph code, subcode, is_transient and fbtrace_id of a rejected page", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(permanentGraphErrorBody(), 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaAdSetConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(false);
    expect(receipt.failure).toMatchObject({
      kind: "http_failure",
      httpStatus: 400,
      errorCode: 100,
      errorSubcode: 33,
      isTransient: false,
      fbtraceId: "AbCdEfGhIjKlMnOp",
    });

    // The identifiers travel; the credential and the body do not. The whole
    // receipt is persisted into meta_raw_snapshots.request_context, so this is
    // the shape that reaches the database.
    const persisted = JSON.stringify(receipt);
    expect(persisted).not.toContain(ACCESS_TOKEN);
    expect(persisted).not.toContain("Tried accessing nonexisting field");
    expect(receipt.failure?.pageUrl).toContain("access_token=%5Bredacted%5D");
  });

  it("logs the named fields for a rejected page without the token or the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(permanentGraphErrorBody(), 400)),
    );

    await fetchMetaAdSetConfigsReceipt("act_1", ACCESS_TOKEN);

    const rejection = warnCalls.find((call) =>
      String(call[0]).includes("collection_page_rejected"),
    );
    expect(rejection).toBeDefined();
    expect(rejection?.[1]).toMatchObject({
      httpStatus: 400,
      errorCode: 100,
      errorSubcode: 33,
      isTransient: false,
      fbtraceId: "AbCdEfGhIjKlMnOp",
    });
    const logged = JSON.stringify(rejection);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain("Tried accessing nonexisting field");
  });
});

describe("Meta Graph retry bounds", () => {
  it("retries a provider-marked transient rejection and completes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(transientGraphErrorBody(), 400))
      .mockResolvedValueOnce(jsonResponse(transientGraphErrorBody(), 400))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "adset-1" }] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaAdSetConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(true);
    expect(receipt.rows).toEqual([{ id: "adset-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops on a permanent rejection instead of spending the retry budget", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(permanentGraphErrorBody(), 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaAdSetConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(false);
    expect(receipt.failure?.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of transient attempts", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(transientGraphErrorBody(), 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaAdSetConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(false);
    expect(receipt.failure).toMatchObject({
      httpStatus: 400,
      errorCode: 1,
      errorSubcode: 99,
      isTransient: true,
      attempts: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Meta Graph pagination bounds", () => {
  it("stops the first time a cursor points back at a page already fetched", async () => {
    let firstUrl: string | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (firstUrl === null) firstUrl = String(input);
      // A cursor that hands back the page we just asked for. Before the cycle
      // guard this burned the entire 20-page budget re-reading one page and
      // then reported a page cap, which reads as "too much data".
      return jsonResponse({
        data: [{ id: "adset-1" }],
        paging: { next: firstUrl },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaAdSetConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.termination).toBe("cursor_cycle");
    expect(receipt.complete).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("campaign config schedule fields", () => {
  function campaignFieldsOf(input: RequestInfo | URL) {
    return new URL(String(input)).searchParams.get("fields") ?? "";
  }

  it("recovers the campaign inventory when the campaigns edge refuses the schedule fields", async () => {
    // The live failure: since 2026-09-04 every `campaign_configs` request has
    // come back 400 on page 0 and meta_entity_state_history has received no
    // campaign row at all. The two fields added on 2026-09-03 are the only
    // difference from the request shape that succeeded 34,496 times.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const fields = campaignFieldsOf(input);
      if (fields.includes("stop_time")) {
        return jsonResponse(permanentGraphErrorBody(), 400);
      }
      return jsonResponse({ data: [{ id: "campaign-1", name: "Prospecting" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(true);
    expect(receipt.rows).toEqual([{ id: "campaign-1", name: "Prospecting" }]);
    expect(receipt.fieldDegradation).toMatchObject({
      droppedFields: ["start_time", "stop_time"],
      // The narrowed request was accepted, so the narrowing IS the diagnosis.
      recovered: true,
      cause: {
        httpStatus: 400,
        errorCode: 100,
        errorSubcode: 33,
        fbtraceId: "AbCdEfGhIjKlMnOp",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The retry narrows the request by exactly those two fields. Everything
    // else survives, including the nested field whose braces contain a comma —
    // splitting the list naively would have sent Meta a new kind of invalid
    // request.
    const retried = campaignFieldsOf(fetchMock.mock.calls[1]![0]);
    expect(retried).toContain("bid_constraints{roas_average_floor}");
    expect(retried).not.toContain("start_time");
    expect(retried).not.toContain("stop_time");
    const first = campaignFieldsOf(fetchMock.mock.calls[0]![0]).split(",");
    expect(retried.split(",")).toEqual(
      first.filter((field) => field !== "start_time" && field !== "stop_time"),
    );
  });

  it("keeps the schedule fields when the campaigns edge accepts them", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      jsonResponse({
        data: [{ id: "campaign-1", requested: campaignFieldsOf(input) }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(true);
    expect(receipt.fieldDegradation).toBeNull();
    expect(campaignFieldsOf(fetchMock.mock.calls[0]![0])).toContain("stop_time");
  });

  it("does not blame the schedule fields for a refusal the narrowing did not fix", async () => {
    // Every page 0 refused for a reason that has nothing to do with the field
    // list. The loop still narrows once — it cannot know in advance — but the
    // narrowed request is refused too.
    //
    // The whole receipt is persisted into
    // meta_raw_snapshots.request_context.pagination by
    // paginationReceiptContext, so before `recovered` existed this run stored
    // `droppedFields: ["start_time","stop_time"]` on a snapshot where Meta
    // refused nothing of the kind, and the next operator chasing this 400 read
    // the schedule fields as its cause.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(unrelatedPermanentGraphErrorBody(), 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(false);
    expect(receipt.termination).toBe("http_failure");
    // Narrowing was attempted exactly once: the original request, then the
    // narrowed one. Neither is retried, because 294 is permanent.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(campaignFieldsOf(fetchMock.mock.calls[1]![0])).not.toContain(
      "stop_time",
    );

    // The attempt is still on the record — it explains the second provider
    // call — but it is explicitly marked as having failed, so nothing reads it
    // as "Meta refuses start_time and stop_time".
    expect(receipt.fieldDegradation?.recovered).toBe(false);
    expect(receipt.failure).toMatchObject({
      httpStatus: 400,
      errorCode: 294,
      errorSubcode: 1487390,
      fbtraceId: "PeRmIsSiOnErR001",
    });
  });

  it("marks the narrowing recovered even when a LATER page fails", async () => {
    // Page 0 is refused for the schedule fields, the narrowed page 0 succeeds
    // and hands back a cursor, and page 1 then fails. The narrowing did its
    // job, so the receipt must keep saying so; `complete: false` here is about
    // page 1, not about the field list.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("cursor_page") === "1") {
        return jsonResponse(permanentGraphErrorBody(), 400);
      }
      if (campaignFieldsOf(input).includes("stop_time")) {
        return jsonResponse(permanentGraphErrorBody(), 400);
      }
      const next = new URL(url.toString());
      next.searchParams.set("cursor_page", "1");
      return jsonResponse({
        data: [{ id: "campaign-1" }],
        paging: { next: next.toString() },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(false);
    expect(receipt.termination).toBe("http_failure");
    expect(receipt.failure?.pageIndex).toBe(1);
    expect(receipt.fieldDegradation).toMatchObject({
      droppedFields: ["start_time", "stop_time"],
      recovered: true,
    });
  });
});

/*
  AREA S4b — a refusal that arrives on HTTP 200.

  Graph can answer a rejected request with status 200 and `{ "error": {...} }`
  at the top level of the body. `!response.ok` cannot see it, so before this the
  page walked past the refusal check entirely and did two wrong things in
  sequence: it promoted an in-flight narrowing to `recovered: true` — the
  receipt's one claim that the provider WILL serve the request without those
  fields, persisted into `meta_raw_snapshots.request_context.pagination` — and
  then read `data`, which a refusal envelope does not carry, so the page ended
  as a `parse_failure` blaming a missing data array instead of naming the
  provider's own error code.

  These drive the real production fetcher against a stubbed global fetch. The
  last two are the guards in the other direction: a clean 200 must still promote
  the narrowing, and `"error": null` is not a refusal.
*/
describe("HTTP 2xx carrying a Graph error envelope", () => {
  function campaignFieldsOf(input: RequestInfo | URL) {
    return new URL(String(input)).searchParams.get("fields") ?? "";
  }

  it("does not call a narrowing recovered when the narrowed request is refused on a 200", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (campaignFieldsOf(input).includes("stop_time")) {
        return jsonResponse(permanentGraphErrorBody(), 400);
      }
      // The narrowed request. Refused too — just not with a status that says so.
      return jsonResponse(unrelatedPermanentGraphErrorBody(), 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(false);
    expect(receipt.rows).toEqual([]);
    // Asserted before the termination below because it is the claim that
    // outlives the run: the narrowing was attempted and did NOT work. Saying
    // otherwise would tell the next operator that Meta refuses start_time and
    // stop_time, on a run where Meta refused the whole request for an unrelated
    // permission reason.
    expect(receipt.fieldDegradation).toMatchObject({
      droppedFields: ["start_time", "stop_time"],
      recovered: false,
    });
    // Not `parse_failure`: the page did not fail to parse, it was refused.
    expect(receipt.termination).toBe("error_envelope");
    // The provider's own identity survives, read off a 200.
    expect(receipt.failure).toMatchObject({
      kind: "error_envelope",
      httpStatus: 200,
      errorCode: 294,
      errorSubcode: 1487390,
      fbtraceId: "PeRmIsSiOnErR001",
    });
  });

  it("yields no rows when a 200 carries both a data array and an error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "campaign-1", name: "Prospecting" }],
        ...permanentGraphErrorBody(),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    // A refused response is not a partial one. Admitting the rows would put a
    // campaign inventory built from a refusal into meta_entity_state_history,
    // where a short inventory reads as "these campaigns no longer exist".
    expect(receipt.rows).toEqual([]);
    expect(receipt.complete).toBe(false);
    expect(receipt.termination).toBe("error_envelope");
    expect(receipt.failure).toMatchObject({ errorCode: 100, httpStatus: 200 });
  });

  it("retries a 200 envelope the provider marked transient, then keeps the recovered page", async () => {
    // `is_transient: true` is the provider's own verdict and it is honoured on a
    // 200 exactly as it is on a 400 — the classification is the same function.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(transientGraphErrorBody(), 200))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "campaign-1", name: "Prospecting" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(receipt.complete).toBe(true);
    expect(receipt.rows).toEqual([{ id: "campaign-1", name: "Prospecting" }]);
    // No narrowing happened: the first attempt was retried as-is, not stripped.
    expect(receipt.fieldDegradation).toBeNull();
    expect(campaignFieldsOf(fetchMock.mock.calls[1]![0])).toContain("stop_time");
  });

  it("still promotes the narrowing when the narrowed 200 carries no error", async () => {
    // The guard against over-correcting: classifying the envelope must not make
    // every 200 look suspicious. This is the recovery path from AREA S4 and it
    // has to keep behaving identically.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (campaignFieldsOf(input).includes("stop_time")) {
        return jsonResponse(permanentGraphErrorBody(), 400);
      }
      return jsonResponse({ data: [{ id: "campaign-1", name: "Prospecting" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(true);
    expect(receipt.rows).toEqual([{ id: "campaign-1", name: "Prospecting" }]);
    expect(receipt.fieldDegradation).toMatchObject({ recovered: true });
  });

  it("treats a literal null error member as no error at all", async () => {
    // Presence, not truthiness of the key. A body that spells out `error: null`
    // is a served page, and refusing it would drop real rows.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: "campaign-1" }], error: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);

    expect(receipt.complete).toBe(true);
    expect(receipt.termination).toBe("natural_end");
    expect(receipt.rows).toEqual([{ id: "campaign-1" }]);
  });
});

/*
  AREA S5 — what the DEGRADED capture says about the rows it produces.

  The narrowing above is honest about itself: the receipt names the dropped
  fields and whether dropping them helped. It was not honest about the DATA. A
  narrowed capture that paginated to the end reported `complete`, and the
  campaign rows beside it carried `campaign_start_time`/`campaign_end_time`
  NULL — so the observation claimed full coverage of a response that never
  contained those fields, and the null went on to win the latest-row read and
  erase a schedule the system had already observed.

  Both halves are asserted here against the real decision path
  (`buildMetaStatusConfigObservation`, which is `persistMetaStatusConfigObservation`
  minus the write).
*/
describe("degraded campaign schedule capture", () => {
  const CREDENTIALS: MetaCredentials = {
    businessId: "biz-degradation",
    accessToken: ACCESS_TOKEN,
    accountIds: ["act_1"],
    currency: "USD",
    accountProfiles: {
      act_1: { currency: "USD", timezone: "Etc/UTC", name: "Test account" },
    },
  };
  const PARTITION_ID = "00000000-0000-4000-8000-000000000001";
  const LIFETIME_BUDGET_CAMPAIGN = {
    id: "campaign-1",
    name: "Prospecting",
    lifetime_budget: "500000",
  };
  /*
    Meta answers `"0"` for a grain that does not own the money — the sentinel
    deriveMetaBudgetOrigin reads. It is not a lifetime budget, so losing its
    schedule makes nothing unevaluable.
  */
  const DAILY_BUDGET_CAMPAIGN = {
    id: "campaign-1",
    name: "Prospecting",
    daily_budget: "20000",
    lifetime_budget: "0",
  };

  async function campaignObservation(input: {
    rows: Array<Record<string, unknown>>;
    refuseScheduleFields: boolean;
  }) {
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const fields =
        new URL(String(request)).searchParams.get("fields") ?? "";
      if (input.refuseScheduleFields && fields.includes("stop_time")) {
        return jsonResponse(permanentGraphErrorBody(), 400);
      }
      return jsonResponse({ data: input.rows });
    });
    vi.stubGlobal("fetch", fetchMock);
    const receipt = await fetchMetaCampaignConfigsReceipt("act_1", ACCESS_TOKEN);
    return buildMetaStatusConfigObservation({
      credentials: CREDENTIALS,
      accountId: "act_1",
      entityType: "campaign",
      endpoint: "campaign_configs",
      receipt,
      sourceSnapshotId: null,
      partitionId: PARTITION_ID,
      mapRow: ({ row, responseObservedAt, capturedAt, degradedFields }) =>
        mapCampaignObservationState({
          credentials: CREDENTIALS,
          accountId: "act_1",
          row,
          responseObservedAt,
          capturedAt,
          degradedFields,
        }),
    });
  }

  it("never reports a narrowed capture as complete", async () => {
    const observation = await campaignObservation({
      rows: [LIFETIME_BUDGET_CAMPAIGN],
      refuseScheduleFields: true,
    });

    // Pagination DID reach a natural end — that is exactly why this used to say
    // "complete". The capture is still not a complete observation of the field
    // list the endpoint describes.
    expect(observation.completeness).toBe("partial");
    expect(observation.error).toMatchObject({
      pagination: {
        complete: true,
        fieldDegradation: {
          droppedFields: ["start_time", "stop_time"],
          recovered: true,
        },
      },
    });
  });

  it("marks a schedule lost to degradation UNKNOWN rather than absent, and counts what that costs", async () => {
    const observation = await campaignObservation({
      rows: [LIFETIME_BUDGET_CAMPAIGN],
      refuseScheduleFields: true,
    });

    const state = observation.states[0]!;
    expect(state.campaignStartTime).toBeNull();
    expect(state.campaignEndTime).toBeNull();
    // `false` would say the response answered without the field. It did not
    // answer at all, because the request was not allowed to ask.
    expect(state.fieldCoverage.campaignStartTime).toBe("degraded_not_observed");
    expect(state.fieldCoverage.campaignEndTime).toBe("degraded_not_observed");

    // D083: a lifetime budget without both ends of its schedule cannot be
    // evaluated. Said here, where the cause is known, instead of surfacing
    // downstream as `lifetime_schedule_unretained` — which reads as a retention
    // failure that never happened.
    expect(observation.error).toMatchObject({
      scheduleDegradation: {
        droppedFields: ["start_time", "stop_time"],
        entityCount: 1,
        carriedForwardCount: 0,
        unknownCount: 1,
        lifetimeBudgetUnknownCount: 1,
        priorStateReadFailed: false,
      },
    });
  });

  it("does not call a zero-sentinel lifetime budget unevaluable", async () => {
    const observation = await campaignObservation({
      rows: [DAILY_BUDGET_CAMPAIGN],
      refuseScheduleFields: true,
    });

    expect(observation.error).toMatchObject({
      scheduleDegradation: { unknownCount: 1, lifetimeBudgetUnknownCount: 0 },
    });
  });

  it("preserves a schedule that was observed before the degradation", async () => {
    priorObservedStates.rows = [
      {
        entityId: "campaign-1",
        presence: "present",
        campaignStartTime: "2026-08-01T00:00:00.000Z",
        campaignEndTime: "2026-09-01T00:00:00.000Z",
        adsetStartTime: null,
        adsetEndTime: null,
      },
    ];

    const observation = await campaignObservation({
      rows: [LIFETIME_BUDGET_CAMPAIGN],
      refuseScheduleFields: true,
    });

    const state = observation.states[0]!;
    expect(state.campaignStartTime).toBe("2026-08-01T00:00:00.000Z");
    expect(state.campaignEndTime).toBe("2026-09-01T00:00:00.000Z");
    expect(state.fieldCoverage.campaignStartTime).toBe("carried_forward");
    expect(state.fieldCoverage.campaignEndTime).toBe("carried_forward");
    expect(observation.error).toMatchObject({
      scheduleDegradation: {
        carriedForwardCount: 1,
        unknownCount: 0,
        lifetimeBudgetUnknownCount: 0,
      },
    });
  });

  it("does not resurrect a schedule from a row the provider had stopped returning", async () => {
    // The over-correction guard. Carrying forward is only allowed from an
    // entity the history still says is PRESENT; an absent winner is not
    // evidence of a live schedule.
    priorObservedStates.rows = [
      {
        entityId: "campaign-1",
        presence: "absent_unconfirmed",
        campaignStartTime: "2026-08-01T00:00:00.000Z",
        campaignEndTime: "2026-09-01T00:00:00.000Z",
        adsetStartTime: null,
        adsetEndTime: null,
      },
    ];

    const observation = await campaignObservation({
      rows: [LIFETIME_BUDGET_CAMPAIGN],
      refuseScheduleFields: true,
    });

    const state = observation.states[0]!;
    expect(state.campaignStartTime).toBeNull();
    expect(state.fieldCoverage.campaignStartTime).toBe("degraded_not_observed");
    expect(observation.error).toMatchObject({
      scheduleDegradation: { carriedForwardCount: 0, unknownCount: 1 },
    });
  });

  it("says so when the prior-value read itself failed, instead of writing a confident null", async () => {
    priorObservedStates.throws = true;

    const observation = await campaignObservation({
      rows: [LIFETIME_BUDGET_CAMPAIGN],
      refuseScheduleFields: true,
    });

    expect(observation.completeness).toBe("partial");
    expect(observation.states[0]!.fieldCoverage.campaignStartTime).toBe(
      "degraded_not_observed",
    );
    expect(observation.error).toMatchObject({
      scheduleDegradation: { priorStateReadFailed: true, unknownCount: 1 },
    });
  });

  it("leaves an undegraded capture exactly as it was", async () => {
    // The other over-correction guard: none of the above may fire on the
    // capture that got the field list it asked for.
    const observation = await campaignObservation({
      rows: [
        {
          ...LIFETIME_BUDGET_CAMPAIGN,
          start_time: "2026-08-01T00:00:00+0000",
          stop_time: "2026-09-01T00:00:00+0000",
        },
      ],
      refuseScheduleFields: false,
    });

    expect(observation.completeness).toBe("complete");
    expect(observation.error).toBeNull();
    const state = observation.states[0]!;
    expect(state.campaignStartTime).toBe("2026-08-01T00:00:00+0000");
    expect(state.fieldCoverage.campaignStartTime).toBe(true);
    expect(state.fieldCoverage.campaignEndTime).toBe(true);
    // No degradation, no prior-state read: the recovery path costs the happy
    // path nothing.
    expect(priorObservedStates.calls).toBe(0);
  });
});

describe("a failed capture carries its Graph identity out of the module", () => {
  it("gives the sync classifier the provider's code instead of a bare string", async () => {
    // The whole chain, from the stubbed provider response to the verdict the
    // sync partition acts on. Code 17 is a throttle: retryable, never
    // dead-lettered, and nothing for the operator to do. Before the thrown
    // value carried the code, the classifier saw only
    // "meta_adset_configs_incomplete:http_failure" and returned its
    // unrecognised-message default.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              message: "(#17) User request limit reached",
              type: "OAuthException",
              code: 17,
              is_transient: false,
              fbtrace_id: "ThRoTtLeD0000001",
            },
          },
          400,
        ),
      ),
    );

    const thrown = await fetchMetaAdSetConfigs("act_1", ACCESS_TOKEN).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "meta_adset_configs_incomplete:http_failure",
    );
    expect(thrown).toMatchObject({
      httpStatus: 400,
      errorCode: 17,
      isTransient: false,
      fbtraceId: "ThRoTtLeD0000001",
    });
    // Identity only. The provider's message and the credential stay behind.
    const serialized = JSON.stringify({
      message: (thrown as Error).message,
      ...(thrown as object),
    });
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain("User request limit reached");

    expect(classifyMetaSyncFailure({ error: thrown })).toMatchObject({
      errorClass: "quota",
      terminal: false,
      actionRequired: false,
    });
  });
});

describe("ad account refresh failures", () => {
  it("carries the Graph identifiers off a failed account refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              message: "Error validating access token: Session has expired.",
              type: "OAuthException",
              code: 190,
              error_subcode: 463,
              is_transient: false,
              fbtrace_id: "ExPiReDtOkEn0001",
            },
          },
          400,
        ),
      ),
    );

    const result = await fetchMetaAdAccounts(ACCESS_TOKEN);

    expect(result.ok).toBe(false);
    expect(result.graphError).toEqual({
      errorCode: 190,
      errorSubcode: 463,
      isTransient: false,
      fbtraceId: "ExPiReDtOkEn0001",
    });
  });

  it("never turns a non-JSON error response into the thrown error message", async () => {
    // An edge proxy answering with HTML used to become the Error message that
    // the OAuth callback and the ad-accounts route throw, putting a whole
    // provider response into an application error.
    const html = "<html><body>upstream request rejected</body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(html, {
            status: 400,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    const result = await fetchMetaAdAccounts(ACCESS_TOKEN);
    const message = getMetaApiErrorMessage(result);

    expect(message).not.toContain("upstream request rejected");
    expect(message).toContain("status 400");
  });
});
