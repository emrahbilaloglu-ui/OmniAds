import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { creativeShareFailureMessage } from "./creative-error-copy";

describe("Creative Studio share failure copy", () => {
  it("provides stable buyer-facing recovery text for every share operation", () => {
    expect(creativeShareFailureMessage("load")).toBe(
      "Shared links could not be loaded. Try again.",
    );
    expect(creativeShareFailureMessage("create")).toBe(
      "Share link could not be created. Try again.",
    );
    expect(creativeShareFailureMessage("rotate")).toBe(
      "Share link could not be refreshed. Try again.",
    );
    expect(creativeShareFailureMessage("revoke")).toBe(
      "Share link could not be revoked. Try again.",
    );
    expect(creativeShareFailureMessage("delete")).toBe(
      "Share link could not be deleted. Try again.",
    );
  });

  it("does not forward response messages through the share UI", () => {
    const source = readFileSync(
      new URL(
        "../../app/(dashboard)/platforms/meta/creatives/legacy-page.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const shareFlow = source.slice(
      source.indexOf("const sharedLinksQuery"),
      source.indexOf("const handleCsvExport"),
    );

    expect(shareFlow).not.toContain("payload?.message");
    expect(shareFlow).not.toContain("error.message");
    expect(source).not.toContain("sharedLinksQuery.error.message");
    for (const operation of [
      "load",
      "create",
      "rotate",
      "revoke",
      "delete",
    ] as const) {
      expect(shareFlow).toContain(
        `creativeShareFailureMessage("${operation}")`,
      );
    }
  });
});
