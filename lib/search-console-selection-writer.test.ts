import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpsertIntegrationParams } from "@/lib/integrations";

/**
 * The one supported Search Console selection writer, and the shape of the write
 * it is allowed to make.
 *
 * Search Console's selection lands on the `search_console` connection while the
 * listing that validated it — and every later sync — runs on the GOOGLE
 * credential, so the Search Console generation cannot see a Google principal
 * change. Binding both was an optional argument the next writer could forget;
 * here they are two required, non-nullable inputs, and forgetting one is a
 * refusal rather than an unbound write.
 */

const upsertIntegration = vi.fn();

vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, upsertIntegration };
});

const { writeSearchConsoleSiteSelection, SearchConsoleSelectionEvidenceError } =
  await import("@/lib/search-console-selection-writer");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const PROVIDER_SITE = "sc-domain:mine.example";

function selection(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS_ID,
    siteUrl: PROVIDER_SITE,
    searchConsoleConnectionGeneration: "3:connected",
    googleConnectionGeneration: "11:connected",
    existingMetadata: { unrelatedExistingKey: "kept" },
    connectedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Parameters<typeof writeSearchConsoleSiteSelection>[0];
}

describe("writeSearchConsoleSiteSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertIntegration.mockResolvedValue({ id: "int-sc", provider: "search_console" });
  });

  it("compare-and-sets BOTH the Search Console and the Google connection", async () => {
    await writeSearchConsoleSiteSelection(selection());

    expect(upsertIntegration).toHaveBeenCalledTimes(1);
    expect(upsertIntegration.mock.calls[0][0]).toEqual({
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountId: PROVIDER_SITE,
      providerAccountName: PROVIDER_SITE,
      expectedConnectionGeneration: "3:connected",
      expectedDerivedAuthority: {
        provider: "google",
        connectionGeneration: "11:connected",
      },
      metadata: {
        unrelatedExistingKey: "kept",
        siteUrl: PROVIDER_SITE,
        siteType: "domain",
        propertyName: PROVIDER_SITE,
        connectedAt: "2026-07-01T00:00:00.000Z",
      },
    });
  });

  it("keeps sc-domain: and https:// as different property types", async () => {
    await writeSearchConsoleSiteSelection(
      selection({ siteUrl: "https://mine.example/" }),
    );

    expect(upsertIntegration.mock.calls[0][0].metadata).toMatchObject({
      siteUrl: "https://mine.example/",
      siteType: "url-prefix",
    });
  });

  it("refuses a write with no Google generation instead of writing unbound", async () => {
    // The exact degradation the old optional parameter accepted: a `null` token
    // stringified, or a caller that simply had nothing to bind.
    await expect(
      writeSearchConsoleSiteSelection(selection({ googleConnectionGeneration: "" })),
    ).rejects.toBeInstanceOf(SearchConsoleSelectionEvidenceError);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses a write with no Search Console generation", async () => {
    await expect(
      writeSearchConsoleSiteSelection(
        selection({ searchConsoleConnectionGeneration: "   " }),
      ),
    ).rejects.toBeInstanceOf(SearchConsoleSelectionEvidenceError);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses a write with no provider-verified site", async () => {
    await expect(
      writeSearchConsoleSiteSelection(selection({ siteUrl: "" })),
    ).rejects.toBeInstanceOf(SearchConsoleSelectionEvidenceError);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });
});

/**
 * The COMPILE-TIME half of the guarantee, asserted where `npx tsc --noEmit` will
 * see it.
 *
 * `@ts-expect-error` fails the build if the line it marks type-checks, so this
 * is a real regression test: if someone widens `UpsertIntegrationParams` back to
 * an optional `expectedDerivedAuthority`, the unbound literal below starts
 * compiling and the repo stops type-checking. Nothing executes here; the value
 * is in what the compiler refuses.
 */
describe("UpsertIntegrationParams has no shape for an unbound selection", () => {
  it("rejects a Search Console selection with no derived Google authority", () => {
    // @ts-expect-error — naming a Search Console property requires the Google
    // connection generation the selection was validated under.
    const unbound: UpsertIntegrationParams = {
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountId: PROVIDER_SITE,
      providerAccountName: PROVIDER_SITE,
      expectedConnectionGeneration: "3:connected",
    };

    // @ts-expect-error — a nullable derived authority is the optional-safety
    // shape this defect was about; it must not be assignable either.
    const nullable: UpsertIntegrationParams = {
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountId: PROVIDER_SITE,
      expectedDerivedAuthority: null,
    };

    // @ts-expect-error — the authority must be the GOOGLE connection, not
    // whichever connection the caller finds convenient.
    const wrongProvider: UpsertIntegrationParams = {
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountId: PROVIDER_SITE,
      expectedDerivedAuthority: { provider: "ga4", connectionGeneration: "11:connected" },
    };

    // The positive control: the bound shape compiles, and so do the two shapes
    // that must stay ergonomic — any other provider, and a connect-time Search
    // Console write that names no property at all.
    const bound: UpsertIntegrationParams = {
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountId: PROVIDER_SITE,
      expectedConnectionGeneration: "3:connected",
      expectedDerivedAuthority: {
        provider: "google",
        connectionGeneration: "11:connected",
      },
    };
    const otherProvider: UpsertIntegrationParams = {
      businessId: BUSINESS_ID,
      provider: "ga4",
      status: "connected",
      providerAccountId: "properties/900900900",
      expectedConnectionGeneration: "7:connected",
    };
    const connectTime: UpsertIntegrationParams = {
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountName: "Not selected",
      metadata: { connectedAt: "2026-07-01T00:00:00.000Z" },
    };

    expect([unbound, nullable, wrongProvider, bound, otherProvider, connectTime]).toHaveLength(6);
  });
});
