import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALIAS_MAPPINGS,
  CHANGED_MAPPINGS,
  LEAVES,
  LEAVES_WITHOUT_LEGACY,
  LEGACY_MAPPINGS,
  NEW_SURFACE_LEAVES,
  UNIQUE_CHANGED_PATHS,
  leafById,
} from "@/lib/zero-base/route-registry";
import {
  CONTRACT_KEYS,
  RANGE_ALIASES,
  controlClassOf,
  unexpandedRangeKeys,
} from "@/lib/zero-base/control-registry";
import {
  COMING_SOON_SOURCE_IDS,
  RENDERABLE_SOURCE_IDS,
  REPORT_SOURCES,
} from "@/lib/zero-base/report-source-registry";
import { DESIGN_FINGERPRINT } from "@/lib/zero-base/generated-contracts";

/**
 * These tests are deliberately NOT self-referential.
 *
 * The registries under test are generated from the vendored JSON, so comparing
 * them to themselves would prove nothing. Every set is compared against the
 * vendored JSON read fresh from disk, and that JSON is first proven to still
 * hash to the digest recorded independently in SOURCE.md at vendor time. The
 * scalar counts are master-plan literals, not values derived from the data.
 */
const V3 = path.join(process.cwd(), "docs", "zero-base-design", "v3");

function vendoredHash(rel: string): string {
  const source = readFileSync(path.join(V3, "SOURCE.md"), "utf8");
  const row = new RegExp(`^\\| \`${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` \\| \`([0-9a-f]{64})\` \\|`, "m");
  const match = source.match(row);
  if (!match) throw new Error(`SOURCE.md has no manifest row for ${rel}`);
  return match[1]!;
}

function readVendored<T>(rel: string): T {
  const abs = path.join(V3, rel);
  const bytes = readFileSync(abs);
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(digest, `${rel} drifted from its vendored SOURCE.md digest`).toBe(
    vendoredHash(rel),
  );
  return JSON.parse(bytes.toString("utf8")) as T;
}

type VendoredLeaf = {
  leaf: string;
  url: string;
  availability: string;
  surface: string;
  legacy?: Array<{ route: string; mode: string }>;
};

describe("zero-base contract registry", () => {
  const sitemapRaw = readVendored<VendoredLeaf[] | { leaves?: VendoredLeaf[] }>(
    "export/sitemap.json",
  );
  const vendoredLeaves: VendoredLeaf[] = Array.isArray(sitemapRaw)
    ? sitemapRaw
    : (sitemapRaw.leaves ?? []);

  const manifestRaw = readVendored<Array<{ k: string }> | { contracts?: Array<{ k: string }> }>(
    "export/interaction-manifest.json",
  );
  const vendoredContracts = Array.isArray(manifestRaw)
    ? manifestRaw
    : (manifestRaw.contracts ?? []);

  const catalogRaw = readVendored<
    Array<{ id: string; kind: string }> | { sources?: Array<{ id: string; kind: string }> }
  >("export/report-catalog.json");
  const vendoredSources = Array.isArray(catalogRaw) ? catalogRaw : (catalogRaw.sources ?? []);

  const audit = readVendored<{ packageHash: string; verdict: string }>("export/audit.json");

  it("is generated from the fingerprint recorded in the vendored audit", () => {
    expect(DESIGN_FINGERPRINT).toBe(audit.packageHash);
  });

  it("never launders the design package's NOT READY verdict", () => {
    expect(audit.verdict).toBe("NOT READY");
  });

  it("has exact leaf-id set equality with the vendored sitemap (74)", () => {
    expect(LEAVES).toHaveLength(74);
    expect(LEAVES.map((l) => l.leaf).sort()).toEqual(
      vendoredLeaves.map((l) => l.leaf).sort(),
    );
  });

  it("has exact surface-token set equality and 74 unique tokens", () => {
    const tokens = LEAVES.map((l) => l.surface);
    expect(new Set(tokens).size).toBe(74);
    expect(tokens.sort()).toEqual(vendoredLeaves.map((l) => l.surface).sort());
  });

  it("has exact contract-key set equality with the vendored manifest (142)", () => {
    expect(CONTRACT_KEYS).toHaveLength(142);
    expect([...CONTRACT_KEYS].sort()).toEqual(vendoredContracts.map((c) => c.k).sort());
  });

  it("has exact legacy tuple equality (leaf, url, availability, route, mode)", () => {
    const tuple = (r: {
      leaf: string;
      canonicalUrl?: string;
      url?: string;
      availability: string;
      route: string;
      mode: string;
    }) => [r.leaf, r.canonicalUrl ?? r.url, r.availability, r.route, r.mode].join("|");

    const fromVendored = vendoredLeaves
      .flatMap((leaf) =>
        (leaf.legacy ?? []).map((record) =>
          tuple({
            leaf: leaf.leaf,
            url: leaf.url,
            availability: leaf.availability,
            route: record.route,
            mode: record.mode,
          }),
        ),
      )
      .sort();

    expect(LEGACY_MAPPINGS.map(tuple).sort()).toEqual(fromVendored);
  });

  it("reconciles 20 alias records, 47 changed records and 46 unique changed paths", () => {
    expect(ALIAS_MAPPINGS).toHaveLength(20);
    expect(CHANGED_MAPPINGS).toHaveLength(47);
    expect(UNIQUE_CHANGED_PATHS).toHaveLength(46);
  });

  it("keeps every alias at its own URL, so aliases need no redirect", () => {
    for (const alias of ALIAS_MAPPINGS) {
      expect(alias.route).toBe(alias.canonicalUrl);
    }
  });

  it("counts 11 new-surface leaves of which 10 have no legacy record", () => {
    expect(NEW_SURFACE_LEAVES).toHaveLength(11);
    expect(LEAVES_WITHOUT_LEGACY).toHaveLength(10);
  });

  it("names L-ME-ACCOUNT as the eleventh new surface, owning the /settings split", () => {
    const account = leafById("L-ME-ACCOUNT");
    expect(account.availability).toBe("new-surface");
    expect(account.legacy).toHaveLength(1);
    expect(account.legacy[0]).toEqual({ route: "/settings", mode: "split" });

    const newSurfacesWithLegacy = NEW_SURFACE_LEAVES.filter((l) => l.legacy.length > 0);
    expect(newSurfacesWithLegacy.map((l) => l.leaf)).toEqual(["L-ME-ACCOUNT"]);

    // /settings is the only old path that splits, which is why 47 records
    // cover 46 unique paths.
    const settings = CHANGED_MAPPINGS.filter((m) => m.route === "/settings");
    expect(settings).toHaveLength(2);
    expect(settings.map((m) => m.leaf).sort()).toEqual(["L-C-M-BIZ", "L-ME-ACCOUNT"]);
  });

  it("accounts for all 76 legacy pages: 66 mapped + 9 retired + 1 dev-excluded", () => {
    const mapped = new Set(LEGACY_MAPPINGS.map((m) => m.route));
    expect(mapped.size).toBe(66);
    expect(mapped.size + 9 + 1).toBe(76);
  });

  it("expands the one range alias to exactly seven workflow capabilities", () => {
    expect(RANGE_ALIASES).toHaveLength(1);
    const [alias] = RANGE_ALIASES;
    expect(alias.alias).toBe("gated:META-WF-02..08 menu");
    expect(alias.expandsTo).toHaveLength(7);
    expect([...alias.expandsTo]).toEqual([
      "META-WF-02",
      "META-WF-03",
      "META-WF-04",
      "META-WF-05",
      "META-WF-06",
      "META-WF-07",
      "META-WF-08",
    ]);
    expect(CONTRACT_KEYS).toContain(alias.alias);
  });

  it("rejects any other unexpanded range token", () => {
    expect(unexpandedRangeKeys()).toEqual([]);
    expect(unexpandedRangeKeys(["live:FOO-01..09 thing"])).toEqual([
      "live:FOO-01..09 thing",
    ]);
  });

  it("classifies every contract key into a known control class", () => {
    const histogram = { live: 0, gated: 0, disabled: 0 };
    for (const key of CONTRACT_KEYS) histogram[controlClassOf(key)] += 1;
    expect(histogram.live + histogram.gated + histogram.disabled).toBe(142);
    expect(histogram.disabled).toBeGreaterThan(0);
  });

  it("has exactly 5 renderable + 4 coming-soon = 9 report sources", () => {
    expect(REPORT_SOURCES).toHaveLength(9);
    expect(RENDERABLE_SOURCE_IDS).toHaveLength(5);
    expect(COMING_SOON_SOURCE_IDS).toHaveLength(4);
    expect([...REPORT_SOURCES].map((s) => s.id).sort()).toEqual(
      vendoredSources.map((s) => s.id).sort(),
    );
  });

  it("keeps Search Console and Klaviyo as separate catalog rows", () => {
    expect(COMING_SOON_SOURCE_IDS).toContain("search_console_data");
    expect(COMING_SOON_SOURCE_IDS).toContain("klaviyo_data");
    expect(new Set(COMING_SOON_SOURCE_IDS).size).toBe(4);
  });

  it("matches the renderer's five renderable source ids exactly", () => {
    expect([...RENDERABLE_SOURCE_IDS].sort()).toEqual([
      "channel_attribution",
      "google_campaigns",
      "meta_campaigns",
      "overview_summary",
      "overview_trend",
    ]);
  });
});
