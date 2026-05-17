import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrackingConfirmModal } from "@/components/common/briefing/TrackingConfirmModal";

describe("TrackingConfirmModal", () => {
  it("renders the modal with an accessible dialog and custom primary label", () => {
    const html = renderToStaticMarkup(
      <TrackingConfirmModal
        open
        primaryLabel="Confirm cut 3"
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("aria-modal=\"true\"");
    expect(html).toContain("Tracking is degraded.");
    expect(html).toContain("Confirm cut 3");
  });

  it("accepts action-specific tracking risk copy", () => {
    const html = renderToStaticMarkup(
      <TrackingConfirmModal
        open
        primaryLabel="Resume anyway"
        description="Resuming during a tracking anomaly may reopen spend with incomplete attribution."
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain("Resume anyway");
    expect(html).toContain("Resuming during a tracking anomaly may reopen spend with incomplete attribution.");
  });

  it("hides when closed", () => {
    const html = renderToStaticMarkup(
      <TrackingConfirmModal open={false} onClose={() => undefined} onConfirm={() => undefined} />,
    );

    expect(html).toBe("");
  });
});
