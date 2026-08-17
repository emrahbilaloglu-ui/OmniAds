import { describe, expect, it } from "vitest";

import {
  KLAVIYO_STATES,
  klaviyoBelongsInRail,
  klaviyoIsConnectable,
  klaviyoMayServeRows,
  resolveKlaviyoState,
} from "@/lib/klaviyo/state";

describe("resolveKlaviyoState", () => {
  it("reports not_configured before anything else, whatever else is stored", () => {
    expect(
      resolveKlaviyoState({
        oauthConfigured: false,
        connectionStatus: "connected",
        hasSnapshot: true,
      }),
    ).toBe("not_configured");
  });

  it("reports not_connected when the deployment is configured but the workspace is not", () => {
    expect(
      resolveKlaviyoState({
        oauthConfigured: true,
        connectionStatus: null,
        hasSnapshot: false,
      }),
    ).toBe("not_connected");
  });

  it("reports reconnect_required for a stored connection that is not connected", () => {
    for (const status of ["disconnected", "error", "expired", "revoked"]) {
      expect(
        resolveKlaviyoState({
          oauthConfigured: true,
          connectionStatus: status,
          hasSnapshot: true,
        }),
        status,
      ).toBe("reconnect_required");
    }
  });

  it("reports awaiting_first_snapshot for a live connection with nothing imported", () => {
    expect(
      resolveKlaviyoState({
        oauthConfigured: true,
        connectionStatus: "connected",
        hasSnapshot: false,
      }),
    ).toBe("awaiting_first_snapshot");
  });

  it("reports ready only when connected AND a snapshot exists", () => {
    expect(
      resolveKlaviyoState({
        oauthConfigured: true,
        connectionStatus: "connected",
        hasSnapshot: true,
      }),
    ).toBe("ready");
  });

  it("enumerates exactly five states", () => {
    expect([...KLAVIYO_STATES]).toEqual([
      "not_configured",
      "not_connected",
      "reconnect_required",
      "awaiting_first_snapshot",
      "ready",
    ]);
  });
});

describe("klaviyo state predicates", () => {
  it("offers a Connect button in every state except not_configured", () => {
    expect(klaviyoIsConnectable("not_configured")).toBe(false);
    for (const state of KLAVIYO_STATES.filter((s) => s !== "not_configured")) {
      expect(klaviyoIsConnectable(state), state).toBe(true);
    }
  });

  it("serves rows only in ready — a stale snapshot under a dead grant is withheld", () => {
    expect(klaviyoMayServeRows("ready")).toBe(true);
    for (const state of KLAVIYO_STATES.filter((s) => s !== "ready")) {
      expect(klaviyoMayServeRows(state), state).toBe(false);
    }
    // Specifically: a workspace that disconnected still has warehouse rows.
    expect(
      klaviyoMayServeRows(
        resolveKlaviyoState({
          oauthConfigured: true,
          connectionStatus: "disconnected",
          hasSnapshot: true,
        }),
      ),
    ).toBe(false);
  });

  it("puts Klaviyo in the rail only once its snapshot is ready (design 3284)", () => {
    expect(klaviyoBelongsInRail("ready")).toBe(true);
    expect(klaviyoBelongsInRail("awaiting_first_snapshot")).toBe(false);
    expect(klaviyoBelongsInRail("not_connected")).toBe(false);
    expect(klaviyoBelongsInRail("not_configured")).toBe(false);
  });
});
