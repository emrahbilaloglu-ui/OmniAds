import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const PLATFORM_PAGE = read("components/meta/redesign/MetaPlatformPage.tsx");
const COPIES_PAGE = read(
  "app/(dashboard)/platforms/meta/copies/legacy-page.tsx",
);

/**
 * Every module a route can actually reach, tests excluded.
 *
 * The "one evidence window" law used to be asserted against
 * `components/creatives/StudioOsView.tsx` alone — a 3,589-line file no route
 * mounted, deleted with this change. Asserting that a dead file contains no
 * second window proved nothing about what ships, and the markers it checked had
 * already been stripped, so the test was green and empty at once. It is
 * re-pointed at the whole shipped tree instead: whatever file someone adds a
 * second window to, it is in this list.
 */
const PRODUCTION_MODULES: readonly string[] = execSync(
  // Parenthesised so the implicit -print binds to both -name arms on every find.
  "find app components \\( -name '*.tsx' -o -name '*.ts' \\)",
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !/\.test\.tsx?$/.test(line));

/** Read once; the tree is large enough that per-assertion reads are wasteful. */
const PRODUCTION_SOURCES: ReadonlyMap<string, string> = new Map(
  PRODUCTION_MODULES.map((file) => [file, read(file)]),
);

/**
 * Files that import a module by name, however the specifier is spelled.
 *
 * Relative (`./X`, `../briefing/X`), aliased (`@/components/.../X`) and
 * extension-suffixed forms all count. Matching a path segment alone misses a
 * sibling importing it relatively, which is exactly how an "is anything
 * importing this?" law goes quietly green while the answer is yes.
 */
function productionModulesImporting(moduleName: string): string[] {
  const quote = "[\"'`]";
  const pattern = new RegExp(
    `(?:from|import|require\\()\\s*${quote}[^"'\`]*\\b${moduleName}(?:\\.tsx?)?${quote}`,
  );
  return [...PRODUCTION_SOURCES.entries()]
    .filter(([, source]) => pattern.test(source))
    .map(([file]) => file)
    .sort();
}

function productionModulesContaining(needle: string): string[] {
  return [...PRODUCTION_SOURCES.entries()]
    .filter(([, source]) => source.includes(needle))
    .map(([file]) => file)
    .sort();
}

/**
 * Files that render `<Name>`, matched at the tag boundary.
 *
 * A bare substring is not the same question: `Record<CreativeEvidenceWindowExactTone`
 * and `Omit<CreativeEvidenceDrawerProps` both open with the component's name and
 * mount nothing, so a plain `includes` reports each component's own module as a
 * second window.
 */
function productionModulesMounting(component: string): string[] {
  const tag = new RegExp(`<${component}[\\s/>]`);
  return [...PRODUCTION_SOURCES.entries()]
    .filter(([, source]) => tag.test(source))
    .map(([file]) => file)
    .sort();
}

describe("Creative evidence window route wiring", () => {
  it("mounts the exact evidence window on the design's own trigger", () => {
    // The law is that the page imports THIS window from THIS module, not that
    // the import is written on one line: the page now also imports the window's
    // view-model type (the mobile evidence screen renders the same view model),
    // which turns the single-line form into a braced list.
    expect(PLATFORM_PAGE).toMatch(
      /import \{[^}]*\bCreativeEvidenceWindowExact\b[^}]*\} from "@\/components\/creatives\/CreativeEvidenceWindowExact"/,
    );
    expect(PLATFORM_PAGE).toContain("<CreativeEvidenceWindowExact");
    expect(PLATFORM_PAGE).toContain(
      "buildCreativeEvidenceWindowExactViewModel({",
    );
    expect(PLATFORM_PAGE).not.toContain("MetaCreativeEvidenceDrawer");
  });

  it("keeps both served decision envelopes instead of discarding the presentation one", () => {
    expect(PLATFORM_PAGE).toContain(
      "setCreativeDrill({ decision, canonical: canonicalDecision })",
    );
    expect(PLATFORM_PAGE).toContain("decision: creativeDrill.decision,");
    expect(PLATFORM_PAGE).toContain("canonical: creativeDrill.canonical,");
  });

  it("reads ad-grain evidence from the authorized creatives route, scoped to one creative", () => {
    expect(PLATFORM_PAGE).toContain("fetchCreativeEvidenceAdRows");
    expect(PLATFORM_PAGE).toContain('groupBy: "ad"');
    expect(PLATFORM_PAGE).toContain("creativeId: input.creativeId");
    expect(PLATFORM_PAGE).toContain("/api/meta/creatives?");
    expect(PLATFORM_PAGE).toContain("meta-creative-evidence-ad-rows");
  });

  it("reads the sparkline pair as a real per-ad daily series, scoped to one ad", () => {
    expect(PLATFORM_PAGE).toContain("fetchCreativeEvidenceAdSeries");
    expect(PLATFORM_PAGE).toContain("/api/meta/ads/series?");
    expect(PLATFORM_PAGE).toContain("meta-creative-evidence-series");
    expect(PLATFORM_PAGE).toContain("adIds: [creativeEvidenceAdId!]");
    expect(PLATFORM_PAGE).toContain(
      "adSeries: creativeEvidenceSeriesQuery.data,",
    );
  });

  it("gives the footer the decision's own action, Compare in Studio and Ads Manager", () => {
    // The primary used to be an <a href> built by `creativeEvidenceLaunchpadHref`,
    // which put businessId, providerAccountId, sourceDecisionId and the mode in
    // the query string — so anyone who could type a URL could mint the same
    // "authorized" handoff. The law this test protects is that the footer routes
    // the decision's OWN action, and it is now expressed by minting a
    // server-persisted handoff the server re-verifies, which is why the old
    // identifier is gone rather than the behaviour.
    expect(PLATFORM_PAGE).toContain("/api/meta/launchpad-handoff");
    expect(PLATFORM_PAGE).not.toContain("creativeEvidenceLaunchpadHref");
    expect(PLATFORM_PAGE).toContain("creativeEvidenceStudioHref");
    expect(PLATFORM_PAGE).toContain("buildMetaAdsManagerHref");
  });

  it("does not hand the drawer a second, unguarded provider-write trigger", () => {
    // The primary only gets a destination for draft-routing decisions; the
    // confirmation ceremony stays on the decision row.
    //
    // THE LAW, and why it is no longer spelled as a string match. This used to
    // assert the literal source text
    // `code !== "plan_promotion" && code !== "refresh_creative"` — the page's
    // own hand-kept list of presentation codes. Two problems. It pinned a
    // CLIENT-SIDE RE-DERIVATION of an action the server had already decided, so
    // the test's passing was evidence that the defect was still there; and a
    // string assertion is satisfied by the words appearing anywhere, including
    // inside a comment explaining why they were removed, which is exactly how
    // this assertion went green against a page that no longer contained the
    // gate at all.
    //
    // The law is that the page decides eligibility with the SERVER's function,
    // never with its own list. `authorizeLaunchpadHandoff` is the same law
    // `POST /api/meta/launchpad-handoff` runs, and it refuses a non-native
    // source, an ineligible action, a `decisionState` other than `act`, a
    // held action and any blocker — which is what keeps a blocked / held /
    // pending / review-only decision from ever reaching a Launchpad mode.
    expect(PLATFORM_PAGE).toContain("authorizeLaunchpadHandoff({");
    expect(PLATFORM_PAGE).toContain("creativeEvidenceLaunchpadRoute({");
    // Asserted OUTSIDE comments: the old list must not be live code again.
    const code = PLATFORM_PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(code).not.toContain('code !== "plan_promotion"');
    expect(code).not.toContain('code !== "refresh_creative"');
    expect(code).toContain("authorizeLaunchpadHandoff({");
    expect(PLATFORM_PAGE).not.toContain('/api/meta/decision-action", { method');
  });

  it("carries the served action tuple to the callback boundary unchanged", () => {
    // The tuple travels by reference. `onPrimary` receives `decision.action`
    // itself — not a code, not a label, not a rebuilt object — so the boundary
    // sees the same `{code,label,intent,targetLevel,providerMutation,scopeNote}`
    // the server wrote. The adapter's own test proves identity; this pins that
    // the page's handler accepts and forwards it rather than re-deriving one.
    expect(PLATFORM_PAGE).toContain(
      "onPrimary: (action: MetaOsDecisionAction)",
    );
    expect(PLATFORM_PAGE).toContain(
      "servedAction: MetaOsDecisionAction | null,",
    );
    // The mint body still NAMES a decision and asserts nothing about it: the
    // tuple must not be smuggled into the request.
    expect(PLATFORM_PAGE).not.toContain("action: servedAction");
    expect(PLATFORM_PAGE).not.toContain("authorizedAction: servedAction");
  });

  it("feeds the window the queue-grain source envelope, not only the row's", () => {
    // On an account whose ads source degrades, every row still renders and the
    // only statement of that degradation is this envelope. It reaches the
    // window through the SHARED input, so desktop and mobile cannot disagree.
    expect(PLATFORM_PAGE).toContain("creativeEvidenceSharedInput");
    expect(PLATFORM_PAGE).toContain(
      "source: workspaceQuery.data?.decisionReadModel.source ?? null,",
    );
    expect(PLATFORM_PAGE).toContain(
      "launchpadRoute: creativeEvidenceLaunchpad,",
    );
  });

  /**
   * LAW: an envelope-less row OPENS, and opens fail-closed.
   *
   * The page used to answer `onCreativeReview` with a warning banner whenever
   * the canonical envelope was missing — "the evidence window cannot be opened
   * for it" — and on an account whose ads source has degraded that is every
   * row: Grandmix serves 60 ads and none of them joins a decision snapshot, so
   * zero of 60 rows could reach the window built to explain that state.
   *
   * Three things have to hold together for the open to be safe, and all three
   * are pinned here: the drill state ADMITS a null envelope, the server's
   * handoff law is still the only thing that grants a route, and the
   * provider-write callback is wired only when a canonical decision actually
   * exists to mint against.
   */
  it("opens the window on a served row with no envelope, and stays fail-closed", () => {
    const code = PLATFORM_PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    // The refusal banner is gone as LIVE CODE, not merely reworded.
    expect(code).not.toContain("Canonical creative evidence is unavailable.");
    // The envelope travels as served — null included — and is never rebuilt.
    expect(code).toContain("canonical: MetaCanonicalDecision | null;");
    expect(PLATFORM_PAGE).toContain(
      "setCreativeDrill({ decision, canonical: canonicalDecision })",
    );
    // The route verdict still comes from the server's own law, and the write
    // path additionally demands the canonical decision it mints against.
    expect(code).toMatch(
      /canonical: MetaCanonicalDecision \| null;\s+action: MetaOsDecisionAction \| null;\s+providerAccountId/,
    );
    expect(code).toContain(
      "creativeEvidenceLaunchpad?.offered && creativeDrill.canonical",
    );
    expect(code).toContain("authorizeLaunchpadHandoff({");
  });

  it("leaves exactly one evidence window in the app", () => {
    expect(productionModulesMounting("CreativeEvidenceWindowExact")).toEqual([
      "components/meta/redesign/MetaPlatformPage.tsx",
    ]);
  });

  it("keeps the second evidence drawer off every route", () => {
    // `components/creatives/briefing/CreativeEvidenceDrawer.tsx` is a rival
    // window that still compiles. Its only host is `CreativesBriefingPage`, and
    // that host has no importer at all — which is the only reason one window
    // ships. Stated as the property rather than as a deletion, so re-wiring
    // either half puts the app back to two windows and turns this red.
    expect(productionModulesMounting("CreativeEvidenceDrawer")).toEqual([
      "components/creatives/briefing/CreativesBriefingPage.tsx",
    ]);
    // Any import of that page, however it is spelled. Matching only the
    // `briefing/CreativesBriefingPage` path segment left a hole: a sibling
    // inside `components/creatives/briefing/` importing `./CreativesBriefingPage`
    // — a future barrel, say — would make the page reachable again while this
    // assertion stayed green, and "one window ships" rests entirely on it.
    expect(productionModulesImporting("CreativesBriefingPage")).toEqual([]);
  });

  it("keeps the retired in-Studio usage drawer from coming back", () => {
    for (const marker of [
      "renderUsageDrawer",
      "openUsageDrawer",
      "Exact ad usages",
      "Trends (7 / 28 / 90d)",
      "Take to Decisions",
    ]) {
      expect(
        productionModulesContaining(marker),
        `${marker} reappeared`,
      ).toEqual([]);
    }
  });

  it("converges every Decision Center route family on the same body", () => {
    expect(read("app/(dashboard)/platforms/meta/page.tsx")).toContain(
      'import LegacyBody from "./legacy-page"',
    );
    expect(read("app/c/[businessId]/meta/decisions/page.tsx")).toContain(
      'import LegacyMetaPage from "@/app/(dashboard)/platforms/meta/legacy-page"',
    );
    expect(read("app/app/[[...path]]/page.tsx")).toContain(
      '"meta/decisions": () => import("@/app/c/[businessId]/meta/decisions/page")',
    );
  });
});

describe("Copy detail drawer route wiring", () => {
  it("mounts the exact copy drawer from the Creative Studio copies table", () => {
    expect(COPIES_PAGE).toContain(
      'import { CopyDetailDrawerExact } from "@/components/creatives/CopyDetailDrawerExact"',
    );
    expect(COPIES_PAGE).toContain("<CopyDetailDrawerExact");
    expect(COPIES_PAGE).toContain("buildCopyDetailDrawerExactViewModel({");
    expect(COPIES_PAGE).toContain("onOpenRow: setDetailRowId");
  });

  it("feeds the account medians from the same served rows the table renders", () => {
    expect(COPIES_PAGE).toContain(
      "const drawerPeers = useMemo(() => rows.map(toCopyDrawerRow)",
    );
    expect(COPIES_PAGE).toContain("peers: drawerPeers");
  });

  it("keeps see-more and engagement unserved rather than substituting other metrics", () => {
    expect(COPIES_PAGE).toContain("seeMore: null");
    expect(COPIES_PAGE).toContain("engagement: null");
    expect(COPIES_PAGE).not.toContain('label="Spend"');
    expect(COPIES_PAGE).not.toContain('label="CPA"');
  });

  it("converges every copies route family on the same body", () => {
    expect(read("app/(dashboard)/platforms/meta/copies/page.tsx")).toContain(
      'import LegacyBody from "./legacy-page"',
    );
    expect(read("app/c/[businessId]/creative/copies/page.tsx")).toContain(
      'import LegacyCreativeCopiesPage from "@/app/(dashboard)/platforms/meta/copies/legacy-page"',
    );
    expect(read("app/app/[[...path]]/page.tsx")).toContain(
      '"creative/copies": () => import("@/app/c/[businessId]/creative/copies/page")',
    );
  });
});
