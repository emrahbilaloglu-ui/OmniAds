import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GlobalSearch } from "@/components/layout/GlobalSearch";

const launcherSource = readFileSync(
  "components/layout/GlobalSearch.tsx",
  "utf8",
);
const paletteSource = readFileSync(
  "components/layout/v2/command-palette.tsx",
  "utf8",
);
const frameSource = readFileSync(
  "components/layout/dashboard-frame.tsx",
  "utf8",
);

describe("canonical command launcher", () => {
  it("renders the design's Jump or act button instead of an inline combobox", () => {
    const html = renderToStaticMarkup(
      <GlobalSearch open={false} onOpen={vi.fn()} />,
    );

    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Jump or act"');
    expect(html).toContain("Jump or act…");
    expect(html).toContain("⌘K");
    expect(html).not.toContain("<input");
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('role="listbox"');
  });

  it("mounts one CommandPalette from DashboardFrame", () => {
    expect(frameSource).toContain(
      'import { CommandPalette } from "@/components/layout/v2/command-palette"',
    );
    expect(frameSource.match(/<CommandPalette/g)).toHaveLength(1);
    expect(frameSource).toContain("open={commandPaletteOpen}");
    expect(frameSource).toContain("onOpenChange={setCommandPaletteOpen}");
  });

  it("keeps the launcher free of the retired result dropdown", () => {
    expect(launcherSource).not.toContain("/api/search");
    expect(launcherSource).not.toContain('role="combobox"');
    expect(launcherSource).not.toContain("global-search-results");
  });
});

describe("the single palette preserves entity search truth", () => {
  it("keeps entity search, navigation and workspace switching in the palette", () => {
    expect(paletteSource).toContain("getRailJumpTargets");
    expect(paletteSource).toContain("/api/auth/switch-business");
    expect(paletteSource).toContain("/api/search?q=");
  });

  it("distinguishes failed search from no matches", () => {
    expect(paletteSource).toContain('setEntityState("error")');
    expect(paletteSource).toContain("Nothing matches");
    expect(paletteSource).toContain("Search is unavailable.");
  });

  it("documents the minimum query and ignores superseded responses", () => {
    expect(paletteSource).toContain("MIN_SEARCH_QUERY_LENGTH");
    expect(paletteSource).toContain("Type at least");
    expect(paletteSource).toContain("requestRef.current !== requestId");
  });

  it("uses the server-scoped entity link through the route-family guard and explains the match", () => {
    expect(paletteSource).toContain("commandEntityHrefForRouteFamily");
    expect(paletteSource).toContain("href: result.href");
    expect(paletteSource).toContain("MATCH_LABEL[result.matchKind]");
  });
});
