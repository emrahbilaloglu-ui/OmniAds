import { describe, expect, it } from "vitest";
import {
  attributeObservedChange,
  attributeObservedChanges,
  describeChangeOrigin,
  DEFAULT_CORRELATION_WINDOW_MS,
  type ObservedChange,
  type RecordedAction,
} from "@/lib/external-change-attribution";

function change(overrides: Partial<ObservedChange> = {}): ObservedChange {
  return {
    entityType: "campaign",
    entityId: "c-1",
    businessId: "biz-1",
    field: "status",
    previousValue: "ACTIVE",
    nextValue: "PAUSED",
    observedAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

function action(overrides: Partial<RecordedAction> = {}): RecordedAction {
  return {
    entityId: "c-1",
    field: "status",
    requestedAt: "2026-08-08T11:00:00.000Z",
    status: "verified",
    actorUserId: "user-1",
    ...overrides,
  };
}

describe("a change we can prove we made", () => {
  it("is attributed to this product with its actor", () => {
    const result = attributeObservedChange(change(), [action()]);
    expect(result.origin).toBe("internal");
    expect(result.actorUserId).toBe("user-1");
    expect(result.matchedActionAt).toBe("2026-08-08T11:00:00.000Z");
  });
});

describe("a change nobody here made", () => {
  it("is attributed to Ads Manager when we have no matching action", () => {
    const result = attributeObservedChange(change(), []);
    expect(result.origin).toBe("external");
    expect(result.reason).toContain("No action from this product");
  });

  it("is external when our action targeted a different entity", () => {
    const result = attributeObservedChange(change(), [action({ entityId: "c-9" })]);
    expect(result.origin).toBe("external");
  });

  it("is external when our action changed a different field", () => {
    const result = attributeObservedChange(change(), [action({ field: "daily_budget" })]);
    expect(result.origin).toBe("external");
  });

  it("is external when our matching action failed but the change still happened", () => {
    const result = attributeObservedChange(change(), [action({ status: "failed" })]);
    expect(result.origin).toBe("external");
    expect(result.reason).toContain("failed");
  });

  it("is external when our action came after the change was observed", () => {
    const result = attributeObservedChange(
      change({ observedAt: "2026-08-08T10:00:00.000Z" }),
      [action({ requestedAt: "2026-08-08T11:00:00.000Z" })],
    );
    expect(result.origin).toBe("external");
  });

  it("is external when our action is older than the correlation window", () => {
    const result = attributeObservedChange(
      change(),
      [action({ requestedAt: "2026-08-07T00:00:00.000Z" })],
    );
    expect(result.origin).toBe("external");
  });
});

describe("a change we cannot honestly claim either way", () => {
  it("is ambiguous when our matching action was never verified", () => {
    const result = attributeObservedChange(change(), [action({ status: "pending" })]);
    expect(result.origin).toBe("ambiguous");
    expect(result.reason).toContain("never verified");
  });

  it("is ambiguous when the provider outcome itself was ambiguous", () => {
    const result = attributeObservedChange(change(), [action({ status: "ambiguous" })]);
    expect(result.origin).toBe("ambiguous");
  });

  it("never blames the client for a change our own unverified write may have made", () => {
    const result = attributeObservedChange(change(), [action({ status: "pending" })]);
    expect(result.origin).not.toBe("external");
  });

  it("is ambiguous when the observation has no usable time", () => {
    const result = attributeObservedChange(change({ observedAt: "whenever" }), [action()]);
    expect(result.origin).toBe("ambiguous");
  });

  it("prefers a verified action over an unverified one for the same change", () => {
    const result = attributeObservedChange(change(), [
      action({ status: "pending", requestedAt: "2026-08-08T11:30:00.000Z" }),
      action({ status: "verified", requestedAt: "2026-08-08T11:00:00.000Z" }),
    ]);
    expect(result.origin).toBe("internal");
  });
});

describe("batch attribution", () => {
  it("attributes each change independently", () => {
    const results = attributeObservedChanges(
      [change({ entityId: "c-1" }), change({ entityId: "c-2" })],
      [action({ entityId: "c-1" })],
    );
    expect(results.map((r) => r.origin)).toEqual(["internal", "external"]);
  });

  it("uses a window generous enough for a sync cycle to lag the write", () => {
    expect(DEFAULT_CORRELATION_WINDOW_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});

describe("labels", () => {
  it("names each origin in the operator's language", () => {
    expect(describeChangeOrigin("internal")).toBe("Changed in Adsecute");
    expect(describeChangeOrigin("external")).toBe("Changed in Ads Manager");
    expect(describeChangeOrigin("ambiguous")).toBe("Origin unconfirmed");
  });
});
