import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A render error without a boundary falls through to Next's unstyled crash
 * screen. That is worst on the two surfaces furthest from a developer: the
 * admin console, opened precisely when something is already broken, and a share
 * link, which is a client-facing deliverable.
 */
describe("route groups have error boundaries", () => {
  it.each([
    ["app/(dashboard)/error.tsx"],
    ["app/admin/error.tsx"],
    ["app/share/error.tsx"],
  ])("%s exists", (path) => {
    expect(existsSync(path)).toBe(true);
  });

  it("every boundary offers a way forward rather than a dead end", () => {
    for (const path of [
      "app/(dashboard)/error.tsx",
      "app/admin/error.tsx",
      "app/share/error.tsx",
    ]) {
      expect(readFileSync(path, "utf8")).toContain("reset()");
    }
  });
});

describe("what each audience is told", () => {
  it("gives an operator the cause and the digest to search logs with", () => {
    const admin = readFileSync("app/admin/error.tsx", "utf8");
    expect(admin).toContain("error.message");
    expect(admin).toContain("error.digest");
  });

  it("never shows internal error text to an external share viewer", () => {
    const share = readFileSync("app/share/error.tsx", "utf8");
    // The message may be logged, but must not be rendered into the page.
    const rendered = share.slice(share.indexOf("return ("));
    expect(rendered).not.toContain("error.message");
    expect(rendered).not.toContain("error.digest");
  });

  it("still tells the share viewer what to do next", () => {
    const share = readFileSync("app/share/error.tsx", "utf8");
    expect(share).toContain("fresh link");
  });
});
