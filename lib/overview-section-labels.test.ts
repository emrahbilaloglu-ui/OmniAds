import { describe, expect, it } from "vitest";
import { resolvePlatformSectionLabels } from "@/lib/overview-section-labels";

const label = (provider: string) =>
  provider === "meta" ? "Meta Ads" : provider === "google" ? "Google Ads" : provider;

describe("resolvePlatformSectionLabels", () => {
  it("leaves a single section per provider unqualified", () => {
    const [meta, google] = resolvePlatformSectionLabels(
      [
        { id: "meta", title: "Meta", provider: "meta" },
        { id: "google", title: "Google", provider: "google" },
      ],
      label,
    );
    expect(meta).toEqual({ providerLabel: "Meta Ads", qualifier: null, ambiguous: false });
    expect(google.qualifier).toBeNull();
    expect(google.ambiguous).toBe(false);
  });

  it("qualifies two sections that would otherwise both read Meta Ads", () => {
    const resolved = resolvePlatformSectionLabels(
      [
        { id: "meta-1", title: "IWA-MDNLLC", provider: "meta" },
        { id: "meta-2", title: "Grandmix", provider: "meta" },
      ],
      label,
    );
    expect(resolved[0]).toEqual({
      providerLabel: "Meta Ads",
      qualifier: "IWA-MDNLLC",
      ambiguous: false,
    });
    expect(resolved[1].qualifier).toBe("Grandmix");
    expect(resolved.every((entry) => entry.ambiguous === false)).toBe(true);
  });

  it("never renders two identical labels for sections carrying different numbers", () => {
    const resolved = resolvePlatformSectionLabels(
      [
        { id: "meta-1", title: "Meta Ads", provider: "meta" },
        { id: "meta-2", title: "Meta Ads", provider: "meta" },
      ],
      label,
    );
    const rendered = resolved.map((entry) =>
      entry.qualifier ? `${entry.providerLabel} · ${entry.qualifier}` : entry.providerLabel,
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("marks sections ambiguous when their own identity cannot separate them", () => {
    const resolved = resolvePlatformSectionLabels(
      [
        { id: "meta-1", title: "Meta Ads", provider: "meta" },
        { id: "meta-2", title: "Meta Ads", provider: "meta" },
      ],
      label,
    );
    expect(resolved[0].ambiguous).toBe(true);
    expect(resolved[1].ambiguous).toBe(true);
  });

  it("does not invent a qualifier when there is genuinely nothing to add", () => {
    const resolved = resolvePlatformSectionLabels(
      [
        { id: "meta", title: "Meta Ads", provider: "meta" },
        { id: "meta", title: "Meta Ads", provider: "meta" },
      ],
      label,
    );
    expect(resolved[0].qualifier).toBeNull();
    expect(resolved[0].ambiguous).toBe(true);
  });

  it("ignores case and padding when deciding a title adds information", () => {
    const resolved = resolvePlatformSectionLabels(
      [
        { id: "meta-1", title: "  meta ads ", provider: "meta" },
        { id: "meta-2", title: "Grandmix", provider: "meta" },
      ],
      label,
    );
    expect(resolved[0].qualifier).toBe("meta-1");
    expect(resolved[0].ambiguous).toBe(true);
    expect(resolved[1].qualifier).toBe("Grandmix");
  });
});
