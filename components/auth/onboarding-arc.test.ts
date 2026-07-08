import { describe, expect, it } from "vitest";
import { buildAuthOnboardingSteps } from "@/components/auth/onboarding-arc";

describe("buildAuthOnboardingSteps", () => {
  it("does not mark setup steps complete before a business exists", () => {
    const steps = buildAuthOnboardingSteps({
      hasBusiness: false,
      metaConnected: false,
      assignedAccountCount: 0,
      lastSyncValue: null,
    });

    expect(steps.map((step) => step.tone)).toEqual(["blocked", "blocked", "blocked", "blocked"]);
    expect(steps[0]?.status).toBe("Create business first");
    expect(steps[0]?.href).toBeUndefined();
  });

  it("uses real connection, assignment, and sync evidence without fake progress", () => {
    const steps = buildAuthOnboardingSteps({
      hasBusiness: true,
      metaConnected: true,
      assignedAccountCount: 2,
      lastSyncValue: "2026-07-08T03:00:00.000Z",
    });

    expect(steps.map((step) => [step.id, step.tone, step.status])).toEqual([
      ["connect", "done", "Connected"],
      ["accounts", "done", "2 assigned"],
      ["sync", "done", "Last sync 2026-07-08T03:00:00.000Z"],
      ["targets", "active", "Open Targets & Economics"],
    ]);
  });

  it("keeps first sync waiting when the only provider value is a generic ready label", () => {
    const steps = buildAuthOnboardingSteps({
      hasBusiness: true,
      metaConnected: true,
      assignedAccountCount: 1,
      lastSyncValue: "Ready",
    });

    expect(steps[2]).toMatchObject({
      id: "sync",
      tone: "waiting",
      status: "Server status not ready",
      action: "Wait for server report",
    });
  });
});
