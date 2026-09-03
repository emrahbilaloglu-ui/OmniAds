import { describe, expect, it } from "vitest";

import { GET, PUT } from "@/app/api/meta/campaign-labels/route";

describe("/api/meta/campaign-labels retirement tombstone", () => {
  it.each([
    ["GET", GET],
    ["PUT", PUT],
  ] as const)("returns a non-retryable 410 for %s without reading or writing labels", async (_method, handler) => {
    const response = await handler();

    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "campaign_labels_retired",
        message:
          "Manual campaign labels are retired. Campaign roles are inferred automatically.",
      },
    });
  });
});
