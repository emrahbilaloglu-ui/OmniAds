import { describe, expect, it } from "vitest";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import { useIntegrationsStore } from "@/store/integrations-store";

describe("deriveProviderViewState", () => {
  it("returns needs_assignment instead of loading when connected provider has no snapshot yet", () => {
    const domains = buildDefaultProviderDomains();
    const domain = {
      ...domains.google,
      connection: {
        ...domains.google.connection,
        status: "connected" as const,
      },
      discovery: {
        ...domains.google.discovery,
        status: "loading" as const,
        entities: [],
      },
      assignment: {
        ...domains.google.assignment,
        selectedIds: [],
      },
    };

    expect(deriveProviderViewState("google", domain).status).toBe("needs_assignment");
  });

  it("keeps connected providers ready when only a stale snapshot exists alongside assignments", () => {
    const domains = buildDefaultProviderDomains();
    const domain = {
      ...domains.meta,
      connection: {
        ...domains.meta.connection,
        status: "connected" as const,
      },
      discovery: {
        ...domains.meta.discovery,
        status: "stale" as const,
        entities: [{ id: "act_1", name: "Account 1" }],
        stale: true,
      },
      assignment: {
        ...domains.meta.assignment,
        selectedIds: ["act_1"],
      },
    };

    expect(deriveProviderViewState("meta", domain).status).toBe("ready");
  });

  it("returns degraded when refresh fails and stale snapshot is used alongside assignments", () => {
    const domains = buildDefaultProviderDomains();
    const domain = {
      ...domains.meta,
      connection: {
        ...domains.meta.connection,
        status: "connected" as const,
      },
      discovery: {
        ...domains.meta.discovery,
        status: "stale" as const,
        entities: [{ id: "act_1", name: "Account 1" }],
        stale: true,
        refreshFailed: true,
      },
      assignment: {
        ...domains.meta.assignment,
        selectedIds: ["act_1"],
      },
    };

    expect(deriveProviderViewState("meta", domain).status).toBe("degraded");
  });

  it("keeps Google ready when cached accounts are available during a quota cooldown", () => {
    const domains = buildDefaultProviderDomains();
    const domain = {
      ...domains.google,
      connection: {
        ...domains.google.connection,
        status: "connected" as const,
      },
      discovery: {
        ...domains.google.discovery,
        status: "stale" as const,
        entities: [{ id: "123", name: "Main account" }],
        stale: true,
        refreshFailed: true,
        failureClass: "quota" as const,
        retryAfterAt: "2026-03-28T14:36:37.766Z",
      },
      assignment: {
        ...domains.google.assignment,
        selectedIds: ["123"],
      },
    };

    expect(deriveProviderViewState("google", domain).status).toBe("ready");
  });

  it("returns action_required when connected discovery fails with no snapshot", () => {
    const domains = buildDefaultProviderDomains();
    const domain = {
      ...domains.google,
      connection: {
        ...domains.google.connection,
        status: "connected" as const,
      },
      discovery: {
        ...domains.google.discovery,
        status: "failed" as const,
        entities: [],
        refreshFailed: true,
      },
      assignment: {
        ...domains.google.assignment,
        selectedIds: [],
      },
    };

    expect(deriveProviderViewState("google", domain).status).toBe("action_required");
  });

  it("keeps Google connected when the access token is expired but a refresh token exists", () => {
    const businessId = "biz-google-refresh";
    useIntegrationsStore.getState().clearAllState();
    useIntegrationsStore.getState().setManifestConnections(businessId, [
      {
        provider: "google",
        status: "connected",
        id: "int_google",
        token_expires_at: "2026-03-20T10:00:00.000Z",
        refresh_token: null,
        has_refresh_token: true,
      },
    ]);

    const state = useIntegrationsStore.getState();
    expect(state.domainsByBusinessId[businessId]?.google.connection.status).toBe("connected");
  });

  it("marks Google expired when an expired access token has no refresh token marker", () => {
    const businessId = "biz-google-no-refresh";
    useIntegrationsStore.getState().clearAllState();
    useIntegrationsStore.getState().setManifestConnections(businessId, [
      {
        provider: "google",
        status: "connected",
        id: "int_google",
        token_expires_at: "2026-03-20T10:00:00.000Z",
        refresh_token: null,
        has_refresh_token: false,
      },
    ]);

    const state = useIntegrationsStore.getState();
    expect(state.domainsByBusinessId[businessId]?.google.connection.status).toBe("expired");
  });

  it("keeps Meta connected when only our own stored expiry stamp is in the past", () => {
    // Meta never told us the token was refused; the stamp is our note from
    // grant time. Measured in production, 10 of 12 connected Meta rows showed
    // "Expired / Action required" on this evidence alone.
    const businessId = "biz-meta-stale-stamp";
    useIntegrationsStore.getState().clearAllState();
    useIntegrationsStore.getState().setManifestConnections(businessId, [
      {
        provider: "meta",
        status: "connected",
        id: "int_meta",
        token_expires_at: "2026-03-20T10:00:00.000Z",
        refresh_token: null,
        has_refresh_token: false,
      },
    ]);

    const state = useIntegrationsStore.getState();
    expect(state.domainsByBusinessId[businessId]?.meta.connection.status).toBe("connected");
  });

  it("still surfaces Meta as needing attention when the provider actually rejects", () => {
    const businessId = "biz-meta-real-failure";
    useIntegrationsStore.getState().clearAllState();
    useIntegrationsStore.getState().setManifestConnections(businessId, [
      {
        provider: "meta",
        status: "error",
        id: "int_meta",
        token_expires_at: null,
        refresh_token: null,
        has_refresh_token: false,
      },
    ]);

    const state = useIntegrationsStore.getState();
    expect(state.domainsByBusinessId[businessId]?.meta.connection.status).toBe("error");
  });
});
