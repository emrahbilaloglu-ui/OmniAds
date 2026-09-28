import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations", () => ({ getIntegration: vi.fn(async () => ({ status: "connected", access_token: "test" })) }));
vi.mock("@/lib/google-token-refresh", () => ({ resolveGoogleAccessTokenWithGeneration: vi.fn(async () => ({ accessToken: "test" })) }));
vi.mock("@/lib/provider-account-assignments", () => ({ getProviderAccountAssignments: vi.fn(async () => []) }));
vi.mock("@/lib/provider-account-snapshots", () => ({ readProviderAccountSnapshot: vi.fn(async () => ({ accounts: [] })) }));
vi.mock("@/lib/provider-request-governance", () => ({ runProviderRequestWithGovernance: vi.fn(async (p: { execute: () => Promise<unknown> }) => p.execute()) }));
vi.mock("@/lib/google-request-audit", () => ({ classifyGoogleRequestAuditSource: vi.fn(() => "sync") }));
vi.mock("@/lib/runtime-logging", () => ({ logRuntimeDebug: vi.fn() }));
vi.mock("@/lib/oauth/google-config", () => ({ GOOGLE_CONFIG: { adsApiBase: "https://googleads.googleapis.com/v23", developerToken: "test" } }));

import { executeGaqlQuery } from "@/lib/google-ads-gaql";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";

const base = { businessId: "test-gaql-isolation", customerId: "1234567890" };
function response(status: number, data: unknown): Response {
  return { status, ok: status === 200, json: async () => data } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const key of ["__omniadsGoogleAdsLoginContextSuccess", "__omniadsGoogleAdsLoginContextFailures", "__omniadsGoogleAdsGaqlCache"]) {
    (globalThis as unknown as Record<string, unknown>)[key] = new Map();
  }
  vi.mocked(readProviderAccountSnapshot).mockResolvedValue({ accounts: [] } as never);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GAQL failure scope", () => {
  it("preserves the REST query enum and permits another surface after INVALID_ARGUMENT", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(400, { error: { status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v23.errors.GoogleAdsFailure", errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" }, message: "Unrecognized field in the query.", location: { fieldPathElements: [{ fieldName: "query" }] } }] }] } }))
      .mockResolvedValueOnce(response(200, { results: [{ campaign: { id: "1" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeGaqlQuery({ ...base, query: "SELECT bad FROM asset_group_asset", queryName: "asset_performance_core" }))
      .rejects.toMatchObject({ apiStatus: "INVALID_ARGUMENT", apiErrorCode: "UNRECOGNIZED_FIELD", message: expect.stringContaining("field=query") });
    await expect(executeGaqlQuery({ ...base, query: "SELECT campaign.id FROM campaign", queryName: "campaign_performance" }))
      .resolves.toMatchObject({ results: [{ campaign: { id: "1" } }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a query rejection through every manager login", async () => {
    vi.mocked(readProviderAccountSnapshot).mockResolvedValue({ accounts: [{ id: "9876543210", isManager: true }] } as never);
    const fetchMock = vi.fn().mockResolvedValue(response(400, { error: { status: "INVALID_ARGUMENT", details: [{ errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" } }] }] } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeGaqlQuery({ ...base, query: "SELECT bad FROM asset_group_asset" })).rejects.toMatchObject({ apiErrorCode: "UNRECOGNIZED_FIELD" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains a real permission-context TTL rather than bypassing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(403, { error: { status: "PERMISSION_DENIED", message: "User permission denied" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeGaqlQuery({ ...base, query: "SELECT asset.id FROM asset" })).rejects.toMatchObject({ apiStatus: "PERMISSION_DENIED" });
    await expect(executeGaqlQuery({ ...base, query: "SELECT campaign.id FROM campaign" })).rejects.toThrow("No request was sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not poison login context after quota pressure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(429, { error: { status: "RESOURCE_EXHAUSTED" } }))
      .mockResolvedValueOnce(response(200, { results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeGaqlQuery({ ...base, query: "SELECT asset.id FROM asset" })).rejects.toMatchObject({ apiStatus: "RESOURCE_EXHAUSTED" });
    await expect(executeGaqlQuery({ ...base, query: "SELECT campaign.id FROM campaign" })).resolves.toMatchObject({ results: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
