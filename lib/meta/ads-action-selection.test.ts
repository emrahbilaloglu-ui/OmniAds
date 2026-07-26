import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Meta provider write — pause, resume, duplicate, and every retry or
 * replay of them — resolves its write context through one function. That
 * function previously checked only that the integration was connected.
 *
 * A deselected account keeps its historical binding and its warehouse
 * dimensions, by design: past attribution must stay readable. So an action
 * targeting a deselected account resolved cleanly and would have written to a
 * live ad account the user had removed from the product.
 */

const getIntegration = vi.fn();
const resolveMetaAccountAuthority = vi.fn();
const graphFetch = vi.fn();

vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration };
});

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/account-context")>();
  return { ...actual, resolveMetaAccountAuthority };
});

const routes = await import("@/lib/meta/ads-action-routes");

describe("Meta provider write selection guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegration.mockResolvedValue({
      status: "connected",
      access_token: "token",
      provider_account_id: "act_1",
    });
    vi.stubGlobal("fetch", graphFetch);
  });

  const resolve = () =>
    (
      routes as unknown as {
        __testResolveWriteContext: (input: {
          businessId: string;
          providerAccountId: string | null;
        }) => Promise<{ ok: boolean; response?: Response }>;
      }
    ).__testResolveWriteContext({ businessId: "biz-1", providerAccountId: "act_1" });

  it("refuses a deselected account with a conflict and makes no provider call", async () => {
    resolveMetaAccountAuthority.mockResolvedValue({
      state: "confirmed_revoked",
      errorMessage: null,
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(409);
    const body = (await result.response!.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("meta_account_not_selected");
    // The point of failing closed HERE is that nothing reaches the provider.
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("refuses unreadable authority as uncertain, not as revoked", async () => {
    // A database outage must not be reported to the user as "you removed this
    // account", and must not be retried as though the answer were known.
    resolveMetaAccountAuthority.mockResolvedValue({
      state: "unknown_error",
      errorMessage: "connection terminated",
    });
    const result = await resolve();
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(503);
    const body = (await result.response!.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("meta_account_authority_unknown");
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("admits a currently selected account", async () => {
    resolveMetaAccountAuthority.mockResolvedValue({
      state: "authorized",
      errorMessage: null,
    });
    const result = await resolve();
    expect(result.ok).toBe(true);
  });

  it("checks selection only after the connection check", async () => {
    // A disconnected integration must still read as disconnected rather than
    // as a selection problem.
    getIntegration.mockResolvedValue({ status: "disconnected", access_token: null });
    const result = await resolve();
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(502);
    expect(resolveMetaAccountAuthority).not.toHaveBeenCalled();
  });
});
