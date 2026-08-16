import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");

describe("dashboard responsive layout contracts", () => {
  it("does not turn the desktop page-header column basis into mobile height", () => {
    const mobileOverride = css.lastIndexOf(".adv-page-head > :first-child");
    const mobileRules = css.slice(mobileOverride, mobileOverride + 120);

    expect(mobileOverride).toBeGreaterThan(css.lastIndexOf("flex: 1 1 360px"));
    expect(mobileRules).toContain("flex: 0 1 auto");
  });
});
