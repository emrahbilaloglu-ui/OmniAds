import { describe, expect, it } from "vitest";
import {
  formatGa4ErrorMessage,
  readGa4ErrorAction,
  resolveGa4SetupState,
  type Ga4ActionableError,
} from "@/components/states/ga4-setup-state";

function ga4Error(input: { message: string; code?: string; action?: string }) {
  const error = new Error(input.message) as Ga4ActionableError;
  error.code = input.code;
  error.action = input.action as Ga4ActionableError["action"];
  return error;
}

describe("GA4 error action", () => {
  it("reads the action the server sent", () => {
    expect(
      readGa4ErrorAction(ga4Error({ message: "x", action: "select_property" })),
    ).toBe("select_property");
  });

  it("falls back to the error code for routes that still drop the action", () => {
    // `/api/geo/**` answered with the code alone for a long time; a screen that
    // read only the action mis-announced those as crashes.
    expect(
      readGa4ErrorAction(ga4Error({ message: "x", code: "no_property_selected" })),
    ).toBe("select_property");
    expect(
      readGa4ErrorAction(ga4Error({ message: "x", code: "token_expired" })),
    ).toBe("reconnect_ga4");
  });

  it("names no action for an ordinary failure", () => {
    expect(readGa4ErrorAction(ga4Error({ message: "boom", code: "ga4_fetch_failed" }))).toBeNull();
    expect(readGa4ErrorAction("not an error")).toBeNull();
  });
});

describe("GA4 setup state", () => {
  it("turns an unselected property into a setup state, not a failure", () => {
    const state = resolveGa4SetupState(
      ga4Error({
        message: "GA4 is connected but no property is selected for this business.",
        code: "no_property_selected",
        action: "select_property",
      }),
      { surfaceLabel: "Analytics", fallbackMessage: "Failed to load analytics data." },
    );

    expect(state).not.toBeNull();
    expect(state!.title).toBe("Select a GA4 property to unlock Analytics");
    expect(state!.status).toBe("disconnected");
    // The remedy is stated, and the empty state's control goes to Integrations.
    expect(state!.description).toContain("Select a GA4 property in Integrations");
    // Never the generic crash title.
    expect(state!.title).not.toContain("Something went wrong");
  });

  it("labels the surface it is unlocking", () => {
    const state = resolveGa4SetupState(
      ga4Error({ message: "no property", action: "select_property" }),
      { surfaceLabel: "AI Visibility", fallbackMessage: "fallback" },
    );
    expect(state!.title).toBe("Select a GA4 property to unlock AI Visibility");
  });

  it("marks a reconnect as an error-toned setup state", () => {
    const state = resolveGa4SetupState(
      ga4Error({ message: "token expired", action: "reconnect_ga4" }),
      { surfaceLabel: "Analytics", fallbackMessage: "fallback" },
    );
    expect(state!.status).toBe("error");
    expect(state!.title).toBe("Reconnect GA4 to unlock Analytics");
  });

  it("leaves a retryable failure in the error card", () => {
    // `retry_later` is the ONE action a Retry button actually resolves.
    expect(
      resolveGa4SetupState(ga4Error({ message: "quota", action: "retry_later" }), {
        surfaceLabel: "Analytics",
        fallbackMessage: "fallback",
      }),
    ).toBeNull();
    expect(
      resolveGa4SetupState(ga4Error({ message: "boom" }), {
        surfaceLabel: "Analytics",
        fallbackMessage: "fallback",
      }),
    ).toBeNull();
    expect(
      resolveGa4SetupState(null, { surfaceLabel: "Analytics", fallbackMessage: "fallback" }),
    ).toBeNull();
  });
});

describe("GA4 error message", () => {
  it("appends the resolving step to the server's own sentence", () => {
    expect(
      formatGa4ErrorMessage(
        ga4Error({ message: "GA4 is connected but no property is selected.", action: "select_property" }),
        "fallback",
      ),
    ).toBe(
      "GA4 is connected but no property is selected. Select a GA4 property in Integrations to continue.",
    );
  });

  it("uses the fallback when there is no error at all", () => {
    expect(formatGa4ErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
