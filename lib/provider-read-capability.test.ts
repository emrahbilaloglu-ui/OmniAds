import { describe, expect, it } from "vitest";

import {
  SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE,
  readSelectedEntityId,
  resolveGa4ReadCapability,
  resolveSearchConsoleReadCapability,
} from "./provider-read-capability";

const GOOGLE_OK = {
  status: "connected",
  scopes: `https://www.googleapis.com/auth/adwords ${SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE}`,
};

const SEARCH_CONSOLE_OK = {
  status: "connected",
  selectedEntityId: "sc-domain:example.com",
};

describe("resolveGa4ReadCapability", () => {
  it("can read only when a property is selected", () => {
    expect(
      resolveGa4ReadCapability({ status: "connected", selectedEntityId: "12345678" }),
    ).toEqual({ canRead: true, block: null });
  });

  it("blocks a connected GA4 with no property, as the read gate does", () => {
    // lib/google-analytics-reporting.ts throws `no_property_selected` (422).
    expect(resolveGa4ReadCapability({ status: "connected" })).toEqual({
      canRead: false,
      block: "property_not_selected",
    });
  });

  it("separates a missing connection from an unusable one", () => {
    expect(resolveGa4ReadCapability(undefined).block).toBe("not_connected");
    expect(resolveGa4ReadCapability({ status: "disconnected" }).block).toBe(
      "not_connected",
    );
    expect(resolveGa4ReadCapability({ status: "expired" }).block).toBe(
      "connection_fault",
    );
    expect(resolveGa4ReadCapability({ status: "error" }).block).toBe(
      "connection_fault",
    );
  });
});

describe("resolveSearchConsoleReadCapability", () => {
  it("can read only when its own row, the Google grant and a site are all there", () => {
    expect(
      resolveSearchConsoleReadCapability(SEARCH_CONSOLE_OK, GOOGLE_OK),
    ).toEqual({ canRead: true, block: null });
  });

  it("blocks when the google row it borrows a credential from is disconnected", () => {
    // The production BskTR shape: search_console connected, google not.
    // lib/search-console.ts throws `search_console_reconnect_required` (401).
    expect(
      resolveSearchConsoleReadCapability(SEARCH_CONSOLE_OK, {
        status: "disconnected",
        scopes: GOOGLE_OK.scopes,
      }),
    ).toEqual({ canRead: false, block: "google_reconnect_required" });
  });

  it("blocks when the google grant is missing the webmasters scope", () => {
    expect(
      resolveSearchConsoleReadCapability(SEARCH_CONSOLE_OK, {
        status: "connected",
        scopes: "https://www.googleapis.com/auth/adwords",
      }).block,
    ).toBe("google_reconnect_required");
    expect(
      resolveSearchConsoleReadCapability(SEARCH_CONSOLE_OK, {
        status: "connected",
        scopes: null,
      }).block,
    ).toBe("google_reconnect_required");
  });

  it("matches the scope on whole tokens, not substrings", () => {
    expect(
      resolveSearchConsoleReadCapability(SEARCH_CONSOLE_OK, {
        status: "connected",
        scopes: `${SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE}.extra`,
      }).block,
    ).toBe("google_reconnect_required");
  });

  it("asks for a site only once the credential behind it is sound", () => {
    // Order matters: telling an operator to pick a site they cannot list is
    // worse than telling them to reconnect Google first.
    expect(
      resolveSearchConsoleReadCapability({ status: "connected" }, GOOGLE_OK).block,
    ).toBe("site_not_selected");
    expect(
      resolveSearchConsoleReadCapability(
        { status: "connected" },
        { status: "disconnected" },
      ).block,
    ).toBe("google_reconnect_required");
  });

  it("reports its own row before it reports the borrowed one", () => {
    expect(
      resolveSearchConsoleReadCapability({ status: "disconnected" }, GOOGLE_OK).block,
    ).toBe("not_connected");
  });
});

describe("readSelectedEntityId", () => {
  it("takes the GA4 property only from the key the read gate reads", () => {
    // The GA4 OAuth callback writes the Google *user* id into
    // provider_account_id before any property exists, so falling back to it
    // would report a property that resolveGa4AnalyticsContext cannot find.
    expect(
      readSelectedEntityId("ga4", {
        metadata: {},
        provider_account_id: "117482910294857201938",
      }),
    ).toBeNull();
    expect(
      readSelectedEntityId("ga4", {
        metadata: { ga4PropertyId: "12345678" },
        provider_account_id: "117482910294857201938",
      }),
    ).toBe("12345678");
  });

  it("takes the Search Console site from metadata, then the account id", () => {
    // Mirrors `parseMetadataSite(metadata) ?? integration.provider_account_id`.
    expect(
      readSelectedEntityId("search_console", {
        metadata: { siteUrl: "sc-domain:example.com" },
        provider_account_id: "https://example.com/",
      }),
    ).toBe("sc-domain:example.com");
    expect(
      readSelectedEntityId("search_console", {
        metadata: null,
        provider_account_id: "https://example.com/",
      }),
    ).toBe("https://example.com/");
    // The callback stores a placeholder *name*, never an id, so a fresh
    // connection with no site chosen resolves to nothing.
    expect(
      readSelectedEntityId("search_console", { metadata: {}, provider_account_id: null }),
    ).toBeNull();
  });

  it("claims no selection for providers that need none", () => {
    expect(
      readSelectedEntityId("meta", { provider_account_id: "act_123" }),
    ).toBeNull();
  });
});
