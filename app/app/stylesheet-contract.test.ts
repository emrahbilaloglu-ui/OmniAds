import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("session app stylesheet contract", () => {
  it("owns the global design bundle at the readable workspace boundary", () => {
    const source = readFileSync("app/app/layout.tsx", "utf8");

    const stylesheet = readFileSync("app/app/workspace.css", "utf8");

    expect(source).toContain('import "./workspace.css";');
    expect(source).toContain("if (!session) return children;");
    expect(source).not.toContain("if (!session) redirect");
    expect(stylesheet).toContain('@import "../globals.css";');
    expect(stylesheet).toContain("--font-adc-sans");
    expect(stylesheet).toContain("schibsted-grotesk-variable.woff2");
  });
});
