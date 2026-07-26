import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Campaign and ad-set actions had no current-selection check at all.
 *
 * The ad-level routes were fixed first; campaign pause, campaign resume, ad-set
 * pause, ad-set resume and ad-set bid still resolved a write context from a
 * connected token alone. The entity target is read from warehouse dimensions,
 * which survive deselection by design — so a deselected account resolved
 * cleanly and the provider write went out against an account the user had
 * removed from the product.
 */

const getIntegration = vi.fn();
const resolveMetaAccountAuthority = vi.fn();
const graphFetch = vi.fn();

vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration };
});

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/account-context")>();
  return { ...actual, resolveMetaAccountAuthority };
});

const routes = await import("@/lib/meta/entity-action-routes");

describe("Meta entity write selection guard", () => {
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
        __testResolveEntityWriteContext: (input: {
          businessId: string;
          providerAccountId: string | null;
        }) => Promise<{ ok: boolean; response?: Response }>;
      }
    ).__testResolveEntityWriteContext({
      businessId: "biz-1",
      providerAccountId: "act_1",
    });

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
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("refuses unreadable authority as uncertain, not as revoked", async () => {
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
    getIntegration.mockResolvedValue({ status: "disconnected", access_token: null });
    const result = await resolve();
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(502);
    expect(resolveMetaAccountAuthority).not.toHaveBeenCalled();
  });
});
