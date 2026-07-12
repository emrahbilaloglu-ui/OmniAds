import { describe, expect, it } from "vitest";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";

describe("buildMetaScopedHref", () => {
  it("preserves existing route state and appends the explicit Meta scope", () => {
    expect(
      buildMetaScopedHref("/platforms/meta/creatives?tab=library", {
        businessId: "biz 1",
        providerAccountId: "act_123",
      }),
    ).toBe(
      "/platforms/meta/creatives?tab=library&businessId=biz+1&providerAccountId=act_123",
    );
  });

  it("does not emit blank scope values and can add or remove extra params", () => {
    expect(
      buildMetaScopedHref(
        "/platforms/meta/copies?start=old",
        { businessId: " ", providerAccountId: null },
        { start: "2026-07-01", end: undefined },
      ),
    ).toBe("/platforms/meta/copies?start=2026-07-01");
  });

  it("places account scope before a route fragment", () => {
    expect(
      buildMetaScopedHref("/platforms/meta/automation#business-stop", {
        businessId: "biz_1",
        providerAccountId: "act_1",
      }),
    ).toBe(
      "/platforms/meta/automation?businessId=biz_1&providerAccountId=act_1#business-stop",
    );
  });
});
