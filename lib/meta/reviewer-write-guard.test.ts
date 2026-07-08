import { describe, expect, it } from "vitest";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";

describe("reviewer write guard", () => {
  it("allows ordinary operators", () => {
    expect(
      rejectIfReviewerReadOnly({
        session: { user: { email: "operator@adsecute.com" } },
      }),
    ).toBeNull();
  });

  it("rejects Shopify reviewer write attempts with a stable error code", async () => {
    const response = rejectIfReviewerReadOnly(
      { session: { user: { email: "shopify-review@adsecute.com" } } },
      "snapshot_refresh",
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "reviewer_read_only",
        action: "snapshot_refresh",
      },
    });
  });
});
