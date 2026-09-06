import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  markMetaLaunchIntentExecuting: vi.fn(),
  restoreMetaLaunchIntentBeforeProviderMutation: vi.fn(),
  recordMetaLaunchIntentOutcome: vi.fn(),
}));
vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(), completeMetaAdsActionLog: vi.fn(),
}));
vi.mock("@/lib/meta/ads-write", async (actual) => ({
  ...(await actual<typeof import("@/lib/meta/ads-write")>()),
  getMetaAdsWriteBlockFailure: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-control-plane", async (actual) => ({
  ...(await actual<typeof import("@/lib/meta/automation-control-plane")>()),
  getMetaWriteBlockState: vi.fn(async () => ({ blocked: false })),
}));
vi.mock("@/lib/provider-write-authority", async (actual) => ({
  ...(await actual<typeof import("@/lib/provider-write-authority")>()),
  assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/meta/account-context", async (actual) => ({
  ...(await actual<typeof import("@/lib/meta/account-context")>()),
  resolveMetaAccountAuthority: vi.fn(async () => ({ state: "authorized" })),
}));

import * as store from "./meta-launch-intent-store";
import * as logs from "@/lib/meta/ads-action-log";
import * as writes from "@/lib/meta/ads-write";
import { runMetaAddToExistingCreate, runMetaLaunchIntentCreate } from "./meta-launch-execution";

type Flow = "new_campaign" | "add_to_existing";
let status: string;
let claim: string | null;
let generation: number;
let authority: boolean;
let logSequence: number;
let withdrawAtInsert: boolean;
let withdrawAfterPost: boolean;
let transportFails: boolean;
let logCompletionFails: boolean;
let posts: string[];
let completedLogs: Map<string, unknown>;

const AUTHORITY = { actionOrigin: "launchpad_manual_v1", manualConfirmation: "explicit_operator_confirmation" } as const;
const TARGETS = [{ targetCampaignId: "10", targetAdsetId: "20" }, { targetCampaignId: "10", targetAdsetId: "21" }];

function run(flow: Flow, boundary = async () => authority ? true : { allowed: false as const, reason: "creative_brief_not_reviewed" }) {
  const common = {
    businessId: "biz", launchIntentId: "intent", providerAccountId: "act_9",
    idempotencyKey: "idem", requestFingerprint: "fingerprint",
    ctx: { businessId: "biz", providerAccountId: "act_9", accessToken: "test-only", connectionGeneration: "1:active" },
    actionLogOrigin: "launchpad_manual", requestedBy: "operator",
    executionAuthority: AUTHORITY, actionLogAuthority: {},
    beforeProviderMutation: boundary, sanitizeError: String,
  };
  if (flow === "new_campaign") return runMetaLaunchIntentCreate({
    ...common, actionLogPreflightProof: {}, preflightChecks: [], preflightDisclosure: {},
    payload: {
      mode: flow, campaign: { name: "Launch", objective: "OUTCOME_SALES", specialAdCategories: [] },
      budget: { mode: "CBO", schedule: "daily", amountMinor: 5000 },
      creativeIds: ["30"], creatives: [{ creativeId: "30" }],
      adSets: [{ name: "Broad", clientId: "broad", optimizationGoal: "OFFSITE_CONVERSIONS",
        pixelId: "99", customEventType: "PURCHASE", targeting: { countries: ["TR"], ageMin: 18, ageMax: 65,
          advantageAudience: true, advantagePlacements: true }, attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }] }],
    },
  } as never);
  return runMetaAddToExistingCreate({
    ...common, copyMode: "reuse_creative", livePreflightChecks: [], nameOverrides: {},
    targetCampaignId: "10", targetAdsetId: "20", validationTargets: TARGETS,
    validationCreatives: [{ creativeId: "30", sourceAdId: "40", creativeName: "Source" }],
    payload: { mode: flow, copyMode: "reuse_creative", targets: TARGETS,
      creativeIds: ["30"], creatives: [{ creativeId: "30", sourceAdId: "40", name: "Source" }] },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  status = "ready"; claim = null; generation = 0; authority = true; logSequence = 0;
  withdrawAtInsert = false; withdrawAfterPost = false; transportFails = false; logCompletionFails = false;
  posts = []; completedLogs = new Map();
  vi.mocked(writes.getMetaAdsWriteBlockFailure).mockResolvedValue(null);
  vi.mocked(store.markMetaLaunchIntentExecuting).mockImplementation(async () => {
    if (status !== "ready") throw new Error("intent already claimed or consumed");
    status = "executing"; claim = `2026-09-06 10:00:00.${String(++generation).padStart(6, "0")}+00`;
    return { status, startedAt: claim } as never;
  });
  vi.mocked(store.restoreMetaLaunchIntentBeforeProviderMutation).mockImplementation(async (input) => {
    expect(completedLogs.get(input.refusedActionLogId)).toMatchObject({
      status: "failure", errorCode: "provider_mutation_withheld", payloadResponse: { provider_mutation_attempted: false },
    });
    if (status !== "executing" || claim !== input.startedAt) throw new Error("claim changed");
    status = "ready"; claim = null;
    return { status, startedAt: null } as never;
  });
  vi.mocked(store.recordMetaLaunchIntentOutcome).mockImplementation(async (input) => {
    if (status !== "executing") throw new Error("not executing");
    status = input.status;
    return { status, startedAt: claim } as never;
  });
  vi.mocked(logs.createMetaAdsActionLog).mockImplementation(async () => {
    if (withdrawAtInsert) authority = false;
    return { id: `log-${++logSequence}` } as never;
  });
  vi.mocked(logs.completeMetaAdsActionLog).mockImplementation(async (input) => {
    if (logCompletionFails) throw new Error("log completion unavailable");
    completedLogs.set(input.id, input);
    return input as never;
  });
  const entities = new Map<string, Record<string, unknown>>();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname.replace(/^\/v\d+(\.\d+)?\//, "");
    const respond = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if ((init?.method ?? "GET") === "POST") {
      posts.push(path);
      if (transportFails) throw new Error("connection reset after dispatch");
      const body = new URLSearchParams(String(init?.body ?? ""));
      const id = String(100 + posts.length);
      entities.set(id, {
        id, name: body.get("name"), account_id: "9", status: "PAUSED", effective_status: "PAUSED",
        objective: "OUTCOME_SALES", optimization_goal: "OFFSITE_CONVERSIONS",
        promoted_object: { pixel_id: "99", custom_event_type: "PURCHASE" },
        campaign_id: path.split("/")[0], adset_id: body.get("adset_id") ?? path.split("/")[0],
        creative: { id: "30" },
      });
      if (withdrawAfterPost) authority = false;
      return respond({ id });
    }
    if (path === "40") return respond({ id: "40", name: "Source", account_id: "9", status: "ACTIVE",
      effective_status: "ACTIVE", creative: { id: "30" }, adset_id: "20" });
    const entity = entities.get(path);
    if (!entity) throw new Error(`Unexpected provider GET ${path}`);
    return respond(entity);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe.each<Flow>(["new_campaign", "add_to_existing"])("%s zero-write authority refusal", (flow) => {
  it("restores after withdrawal during action-log insertion and the same intent retries once", async () => {
    withdrawAtInsert = true;
    const refused = await run(flow);
    expect(refused).toMatchObject({ status: 409, providerMutationAttempted: false, body: { launchIntentStatus: "ready" } });
    expect(posts).toEqual([]);
    expect(status).toBe("ready"); expect(claim).toBeNull();
    expect(store.recordMetaLaunchIntentOutcome).not.toHaveBeenCalled();
    authority = true; withdrawAtInsert = false;
    const retried = await run(flow);
    expect(retried.ok).toBe(true);
    expect(posts).toHaveLength(flow === "new_campaign" ? 3 : 2);
    await expect(run(flow)).rejects.toThrow("already claimed or consumed");
    expect(posts).toHaveLength(flow === "new_campaign" ? 3 : 2);
  });

  it("keeps created identities when authority closes after the first POST", async () => {
    withdrawAfterPost = true;
    const refused = await run(flow);
    expect(refused.providerMutationAttempted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(status).toBe("partially_succeeded");
    expect(store.restoreMetaLaunchIntentBeforeProviderMutation).not.toHaveBeenCalled();
    expect(store.recordMetaLaunchIntentOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "partially_succeeded", resultReceipt: expect.objectContaining(flow === "new_campaign" ? { campaignId: "101" } : { adIds: ["101"] }),
    }));
  });

  it("does not requeue an ambiguous POST even when no created identity was returned", async () => {
    transportFails = true;
    const failed = await run(flow);
    expect(failed.providerMutationAttempted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(status).toBe("silent_failure");
    expect(claim).not.toBeNull();
    expect(store.restoreMetaLaunchIntentBeforeProviderMutation).not.toHaveBeenCalled();
  });

  it("holds the claim if the refused action log cannot be durably settled", async () => {
    withdrawAtInsert = true; logCompletionFails = true;
    const refused = await run(flow);
    expect(refused).toMatchObject({ status: 500, providerMutationAttempted: false });
    expect(posts).toEqual([]); expect(status).toBe("executing");
    expect(store.restoreMetaLaunchIntentBeforeProviderMutation).not.toHaveBeenCalled();
    expect(store.recordMetaLaunchIntentOutcome).not.toHaveBeenCalled();
  });

  it("does not alter a newer claim when restoration loses its ownership comparison", async () => {
    withdrawAtInsert = true;
    vi.mocked(logs.completeMetaAdsActionLog).mockImplementation(async (input) => {
      completedLogs.set(input.id, input); claim = "newer-executor";
      return input as never;
    });
    const refused = await run(flow);
    expect(refused.status).toBe(500); expect(posts).toEqual([]);
    expect(status).toBe("executing"); expect(claim).toBe("newer-executor");
    expect(store.recordMetaLaunchIntentOutcome).not.toHaveBeenCalled();
  });
});

it("restores a campaign veto inside the actual create primitive, without claiming a POST", async () => {
  let asks = 0;
  const boundary = async () => ++asks === 3 ? { allowed: false as const, reason: "creative_brief_not_reviewed" } : true;
  const refused = await run("new_campaign", boundary);
  expect(asks).toBe(3);
  expect(refused).toMatchObject({ status: 409, providerMutationAttempted: false, body: { launchIntentStatus: "ready" } });
  expect(posts).toEqual([]); expect(status).toBe("ready"); expect(claim).toBeNull();
  expect((await run("new_campaign")).ok).toBe(true);
  expect(posts).toHaveLength(3);
});
