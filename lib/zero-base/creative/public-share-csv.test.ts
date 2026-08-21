import { describe, expect, it } from "vitest";

import { buildPublicCreativeShareCsv } from "@/lib/zero-base/creative/public-share-csv";
import type { PublicShare } from "@/lib/zero-base/creative/public-share";

describe("public creative share CSV", () => {
  it("exports only the sanitized public creative and metric fields", () => {
    const share = {
      title: "Snapshot",
      dateRange: "2026-08-01 - 2026-08-19",
      frozenAt: "2026-08-19T00:00:00.000Z",
      expiresAt: "2026-08-27T00:00:00.000Z",
      audience: "buyer",
      financialWarning: null,
      allowCsv: true,
      actions: [],
      captionsSupported: false,
      note: null,
      messages: [],
      creatives: [
        {
          key: "c1",
          name: 'Hero, "v2"',
          format: "image",
          launchDate: "2026-08-01",
          media: null,
          mediaUnavailableReason: null,
          story: null,
          metrics: [
            { key: "spend", label: "Spend", value: "$12.50", rawValue: 12.5 },
            { key: "ctrAll", label: "CTR", value: "1.2%", rawValue: 1.2 },
          ],
        },
      ],
    } satisfies PublicShare;

    const csv = buildPublicCreativeShareCsv(share);

    expect(csv).toContain('"Hero, ""v2""",image,2026-08-01,12.5,1.2');
    expect(csv).not.toContain("businessId");
    expect(csv).not.toContain("providerAccountId");
    expect(csv).not.toContain("c1");
  });
});
