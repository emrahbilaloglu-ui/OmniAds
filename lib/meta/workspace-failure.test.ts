import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  describeDecisionWorkspaceFailure,
  MetaRequestFailure,
  WORKSPACE_UNAVAILABLE_FALLBACK,
} from "@/lib/meta/workspace-failure";

const page = readFileSync(
  "components/meta/redesign/MetaPlatformPage.tsx",
  "utf8",
);

describe("an operator is told why decisions are withheld", () => {
  it("repeats the reason the server actually gave", () => {
    const failure = new MetaRequestFailure({
      message: "The requested Meta account is not assigned to this business.",
      status: 403,
      hasServerReason: true,
    });
    expect(describeDecisionWorkspaceFailure(failure)).toBe(
      "Decisions withheld - The requested Meta account is not assigned to this business.",
    );
  });

  it("does not present a synthesised status line as a reason", () => {
    const failure = new MetaRequestFailure({
      message: "Request failed (500)",
      status: 500,
      hasServerReason: false,
    });
    expect(describeDecisionWorkspaceFailure(failure)).toBe(
      WORKSPACE_UNAVAILABLE_FALLBACK,
    );
  });

  it("falls back for an error that came from somewhere else entirely", () => {
    expect(describeDecisionWorkspaceFailure(new Error("boom"))).toBe(
      WORKSPACE_UNAVAILABLE_FALLBACK,
    );
    expect(describeDecisionWorkspaceFailure(null)).toBe(
      WORKSPACE_UNAVAILABLE_FALLBACK,
    );
  });

  it("does not invent a reason from an empty server message", () => {
    const failure = new MetaRequestFailure({
      message: "   ",
      status: 403,
      hasServerReason: true,
    });
    expect(describeDecisionWorkspaceFailure(failure)).toBe(
      WORKSPACE_UNAVAILABLE_FALLBACK,
    );
  });
});

describe("the surface uses it", () => {
  it("renders stable buyer-facing copy instead of the raw server failure", () => {
    expect(page).toContain("We could not load Meta decisions. Please try again.");
    expect(page).not.toContain(
      "describeDecisionWorkspaceFailure(briefingError)",
    );
  });

  it("carries the server reason off the response so it can be shown", () => {
    expect(page).toContain("hasServerReason: Boolean(serverMessage");
    expect(page).toContain("throw new MetaRequestFailure({");
  });
});
