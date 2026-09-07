import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  mobileWriteCapabilityForPath,
  shouldClaimMobileReadOnly,
} from "@/lib/mobile-write-capability";

describe("Launchpad mobile read-only contract", () => {
  it.each([
    "/platforms/meta/launchpad",
    "/app/meta/launchpad",
    "/c/biz_1/meta/launchpad",
  ])("keeps %s read-only", (path) => {
    expect(mobileWriteCapabilityForPath(path)).toBe("read_only");
    expect(shouldClaimMobileReadOnly(path)).toBe(true);
  });

  it("uses the read-only surface at 768px and every width below 1024px", () => {
    const css = readFileSync(
      "app/(dashboard)/platforms/meta/launchpad/page.module.css",
      "utf8",
    );
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 1023px)"));

    expect(768).toBeLessThan(1024);
    expect(mobileBlock).toContain(".desktopSurface");
    expect(mobileBlock).toMatch(/\.desktopSurface\s*\{[^}]*display:\s*none;/);
    expect(mobileBlock).toMatch(/\.mobileSurface\s*\{[^}]*display:\s*block;/);
  });

  it("renders no write control inside the mobile-only component", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx",
      "utf8",
    );
    const mobileStart = source.indexOf("function LaunchpadMobileSurface(");
    const mobileEnd = source.indexOf(
      "function LaunchpadContextBar(",
      mobileStart,
    );
    const mobileComponent = source.slice(mobileStart, mobileEnd);

    expect(mobileComponent).toContain(
      "Use desktop to create campaigns. New campaigns start paused.",
    );
    expect(mobileComponent).not.toContain("<button");
    expect(mobileComponent).not.toContain('method: "POST"');
    expect(mobileComponent).not.toContain('method: "DELETE"');
  });
});
