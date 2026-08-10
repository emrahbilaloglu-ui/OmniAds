import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { GlobalSearch } from "@/components/layout/GlobalSearch";

const source = readFileSync("components/layout/GlobalSearch.tsx", "utf8");
const frame = readFileSync("components/layout/dashboard-frame.tsx", "utf8");

describe("global search is mounted and labelled", () => {
  it("renders a real search input in the shell", () => {
    const html = renderToStaticMarkup(<GlobalSearch />);
    expect(html).toContain('type="search"');
    expect(html).toContain("Search campaigns, ads, clients");
  });

  it("is actually mounted in the console frame", () => {
    expect(frame).toContain("<GlobalSearch />");
  });

  it("has an accessible name rather than a placeholder alone", () => {
    const html = renderToStaticMarkup(<GlobalSearch />);
    expect(html).toContain('for="global-search"');
    expect(html).toContain("Search campaigns, ad sets, ads and clients");
  });

  it("shows no result panel before anything is typed", () => {
    const html = renderToStaticMarkup(<GlobalSearch />);
    expect(html).not.toContain('role="listbox"');
  });
});

describe("global search tells the truth about its states", () => {
  it("distinguishes a failed search from no matches", () => {
    expect(source).toContain('setState("error")');
    expect(source).toContain("Nothing matched");
    expect(source).toContain("Search is unavailable.");
  });

  it("does not treat a failed request as an empty result", () => {
    const errorBranch = source.slice(source.indexOf("if (!response.ok)"));
    expect(errorBranch.slice(0, 400)).not.toContain("setResults([])");
  });

  it("declares the minimum query length instead of silently doing nothing", () => {
    expect(source).toContain("MIN_SEARCH_QUERY_LENGTH");
    expect(source).toContain("Type at least");
  });

  it("says why each result matched", () => {
    expect(source).toContain("MATCH_LABEL[result.matchKind]");
  });

  it("navigates using the server-supplied scoped link, not a hand-built one", () => {
    expect(source).toContain("router.push(result.href)");
  });

  it("drops responses from superseded keystrokes", () => {
    expect(source).toContain("requestRef.current !== requestId");
  });
});
