import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("admin token normalization", () => {
  it("scopes the admin shell to the redesign token layer without changing admin routes", () => {
    const layout = readRepoFile("app/admin/layout.tsx");
    const css = readRepoFile("app/globals.css");

    expect(layout).toContain("ad-admin-shell");
    expect(layout).toContain("lg:w-[196px]");
    expect(layout).toContain("lg:ml-[196px]");
    expect(layout).not.toContain("lg:w-60");
    expect(layout).not.toContain("lg:ml-60");

    expect(css).toContain(".ad-admin-shell");
    expect(css).toContain("font-ibm-plex-sans");
    expect(css).toContain("--admin-s1: var(--adc-s1)");
    expect(css).toContain(".ad-admin-shell .bg-blue-50");
    expect(css).toContain(".ad-admin-shell .bg-purple-100");
    expect(css).toContain("box-shadow: none !important");
  });
});
