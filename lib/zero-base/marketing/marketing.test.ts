/**
 * WP-25 acceptance: presentation changed, claims did not.
 *
 * The copy snapshot was captured BEFORE any edit
 * (`scripts/zero-base/capture-marketing-snapshots.ts`), so asserting equality
 * here is a real before/after proof rather than a restatement of the current
 * file.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MARKETING_ALLOWED_TOKENS,
  MARKETING_ROOT_ATTRIBUTE,
  PRODUCT_ONLY_MARKERS,
  findProductOnlyLeaks,
  findSessionGuards,
  hasAnonymousFallthrough,
  supportsLanguage,
} from "@/lib/zero-base/marketing/ledger-marketing";
import { MARKETING_PAGES, copyFor } from "@/scripts/zero-base/capture-marketing-snapshots";

const ROOT = process.cwd();
const SNAPSHOT = JSON.parse(
  readFileSync(path.join(ROOT, "docs", "zero-base-design", "v3", "marketing-copy-snapshot.json"), "utf8"),
) as Record<string, string[]>;

describe("all ten public pages exist and are covered", () => {
  it("names exactly the ten pages the work package lists", () => {
    expect(MARKETING_PAGES.map((p) => p.id)).toEqual([
      "root",
      "about",
      "product",
      "pricing",
      "contact",
      "privacy",
      "terms",
      "security",
      "ai-transparency",
      "demo",
    ]);
  });

  it("every page file is on disk", () => {
    for (const page of MARKETING_PAGES) {
      expect(existsSync(path.join(ROOT, page.file)), page.file).toBe(true);
    }
  });

  it("the snapshot was captured with real content, not empty", () => {
    const total = Object.values(SNAPSHOT).reduce((sum, list) => sum + list.length, 0);
    // An empty snapshot would make every equality assertion below vacuous.
    expect(total).toBeGreaterThan(300);
    for (const page of MARKETING_PAGES) {
      expect(SNAPSHOT[page.id]?.length ?? 0, page.id).toBeGreaterThan(0);
    }
  });
});

describe("legal, pricing, security and AI claims are unchanged", () => {
  it("every page's copy is byte-identical to the pre-change snapshot", () => {
    for (const page of MARKETING_PAGES) {
      expect(copyFor(ROOT, page.file), `${page.id} copy changed`).toEqual(SNAPSHOT[page.id]);
    }
  });

  it("the claim-bearing pages in particular are untouched", () => {
    // Named separately so a failure says which contract broke.
    for (const id of ["pricing", "security", "privacy", "terms", "ai-transparency"]) {
      const page = MARKETING_PAGES.find((p) => p.id === id)!;
      expect(copyFor(ROOT, page.file), `${id} copy changed`).toEqual(SNAPSHOT[id]);
    }
  });
});

describe("presentation is scoped and rollbackable", () => {
  const css = readFileSync(path.join(ROOT, "app", "marketing-ledger.css"), "utf8");

  it("every rule is scoped to the marketing attribute", () => {
    const selectors = css
      .split("}")
      .map((block) => block.split("{")[0]?.trim())
      .filter((selector): selector is string => Boolean(selector) && !selector.startsWith("/*"));
    for (const selector of selectors) {
      if (selector.startsWith("@media") || selector === "") continue;
      expect(selector.includes(`[${MARKETING_ROOT_ATTRIBUTE}]`), selector).toBe(true);
    }
  });

  it("declares only the allowed token subset", () => {
    const declared = [...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
    for (const token of new Set(declared)) {
      expect(MARKETING_ALLOWED_TOKENS as readonly string[], token).toContain(token);
    }
  });

  it("is attached at exactly the roots that cover all ten pages", () => {
    const roots = [
      "app/page.tsx",
      "app/(marketing)/layout.tsx",
      "components/legal/PublicLegalPage.tsx",
    ];
    for (const file of roots) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source.includes(MARKETING_ROOT_ATTRIBUTE), file).toBe(true);
    }
  });
});

describe("no product-only surface leaks into a public page", () => {
  it("finds no workspace shell, ops shell or business scope", () => {
    for (const page of MARKETING_PAGES) {
      const source = readFileSync(path.join(ROOT, page.file), "utf8");
      expect(findProductOnlyLeaks(source), page.id).toEqual([]);
    }
  });

  it("would catch a leak if one were introduced", () => {
    // Guards the guard: the matcher really fires.
    expect(findProductOnlyLeaks('<div data-adc-ui="zero-base">')).toContain('data-adc-ui="zero-base"');
    expect(PRODUCT_ONLY_MARKERS.length).toBeGreaterThan(3);
  });

  it("keeps the marketing stylesheet out of the workspace shell", () => {
    const shell = path.join(ROOT, "app", "c", "[businessId]", "layout.tsx");
    if (existsSync(shell)) {
      expect(readFileSync(shell, "utf8").includes("marketing-ledger")).toBe(false);
    }
  });
});

describe("public pages render without a session", () => {
  it("no page calls a session or business guard", () => {
    for (const page of MARKETING_PAGES) {
      const source = readFileSync(path.join(ROOT, page.file), "utf8");
      // A page that gates on auth is not public.
      expect(findSessionGuards(source), page.id).toEqual([]);
    }
  });

  it("would catch a guard if one were added", () => {
    expect(findSessionGuards("const s = await getSessionFromCookies();")).toContain(
      "getSessionFromCookies",
    );
    // A business guard is never a soft forward, even with a fallthrough.
    expect(
      findSessionGuards("if (!session) return; await requireBusinessPageContext({});"),
    ).toContain("requireBusinessPageContext");
  });

  it("allows the root page's soft forward for signed-in visitors", () => {
    // `if (!session) return;` means an anonymous visitor renders the page.
    const source = readFileSync(path.join(ROOT, "app", "page.tsx"), "utf8");
    expect(hasAnonymousFallthrough(source)).toBe(true);
    expect(findSessionGuards(source)).toEqual([]);
  });
});

describe("EN/TR support is claimed only where it exists", () => {
  it("reports TR support from the file rather than assuming it", () => {
    for (const page of MARKETING_PAGES) {
      const source = readFileSync(path.join(ROOT, page.file), "utf8");
      // English is always supported; Turkish only when the page branches on it.
      expect(supportsLanguage(source, "en"), page.id).toBe(true);
      const claimed = supportsLanguage(source, "tr");
      expect(typeof claimed).toBe("boolean");
      if (claimed) expect(source).toMatch(/tr/);
    }
  });

  it("invents no translation coverage", () => {
    expect(supportsLanguage("<p>Only English here</p>", "tr")).toBe(false);
  });
});
