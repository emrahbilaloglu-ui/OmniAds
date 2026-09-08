import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A render error without a boundary falls through to Next's unstyled crash
 * screen. That is worst on the two surfaces furthest from a developer: the
 * admin console, opened precisely when something is already broken, and a share
 * link, which is a client-facing deliverable.
 */
/*
  The two workspace entries were added after this guard first shipped, and the
  guard did not notice they were missing — it enumerated only the three
  boundaries that existed when it was written, so "all listed boundaries exist"
  stayed green across every unbounded route in the product.

  `app/c/**` is a SIBLING of `app/(dashboard)/**`, and `app/app/**` is a sibling
  of both. Neither inherits the dashboard's boundary and there is no root
  `app/error.tsx`. They are listed separately and deliberately: `navHref`
  (lib/zero-base/navigation.ts) rewrites in-product links from
  `/c/[businessId]/…` to `/app/…`, and `app/app/[[...path]]/page.tsx` imports
  the same page modules under its own layout — so one page has two spellings,
  route boundaries do not cross between them, and covering only one leaves the
  spelling every rail link points at unbounded.
*/
const ROUTE_ERROR_BOUNDARIES = [
  "app/(dashboard)/error.tsx",
  "app/admin/error.tsx",
  "app/share/error.tsx",
  "app/c/[businessId]/error.tsx",
  "app/app/error.tsx",
] as const;

describe("route groups have error boundaries", () => {
  it.each(ROUTE_ERROR_BOUNDARIES.map((path) => [path]))("%s exists", (path) => {
    expect(existsSync(path)).toBe(true);
  });

  it("every boundary offers a way forward rather than a dead end", () => {
    for (const path of ROUTE_ERROR_BOUNDARIES) {
      expect(readFileSync(path, "utf8")).toContain("reset()");
    }
  });

  /*
    Both workspace spellings must be covered. Asserting the PAIR is the point:
    covering `/c/**` alone was the state this closed, and it looked complete.
  */
  it("covers both spellings of a workspace page, not just one", () => {
    expect(existsSync("app/c/[businessId]/error.tsx")).toBe(true);
    expect(existsSync("app/app/error.tsx")).toBe(true);
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

  /*
    A workspace error can carry an account name, an entity id, or a `cause`
    chain holding the request of a failed Graph fetch — `lib/api/meta.ts` puts
    `access_token` into request URLs and redacts it only from its OWN receipts,
    which a boundary cannot know it is looking at. `app/admin` prints the cause
    because its audience is the operator who has to fix it; these two are not
    that surface.
  */
  it.each([["app/c/[businessId]/error.tsx"], ["app/app/error.tsx"]])(
    "%s logs the error text but renders only the digest",
    (path) => {
      const source = readFileSync(path, "utf8");
      const rendered = source.slice(source.indexOf("return ("));
      expect(rendered).not.toContain("error.message");
      expect(rendered).not.toContain("error.name");
      expect(rendered).not.toContain("error.stack");
      // The digest is an opaque Next hash and is what correlates to the log.
      expect(rendered).toContain("error.digest");
      expect(source).toContain("console.error");
    },
  );
});
