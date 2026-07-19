import { describe, expect, it } from "vitest";
import committedFixture from "@/lib/meta/fixtures/demo-native-canonical-generation.v1.json";
import { getDemoMetaCreatives, DEMO_BUSINESS_ID } from "@/lib/demo-business";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  demoNativeFixtureItemHash,
  demoNativeFixtureManifestHash,
  validateDemoNativeCanonicalFixture,
  type DemoNativeCanonicalFixture,
  type DemoNativeCanonicalFixtureItem,
} from "@/lib/meta/demo-native-canonical-contract";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";

const PROVIDER_ACCOUNT_ID = "act_210009998877";
const rows = getDemoMetaCreatives().rows as MetaCreativeApiRow[];

function validate(fixture: unknown) {
  return validateDemoNativeCanonicalFixture({
    fixture,
    businessId: DEMO_BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    rows,
  });
}

function mutateAndRehash(
  mutate: (item: DemoNativeCanonicalFixtureItem) => void,
) {
  const fixture = structuredClone(
    committedFixture,
  ) as DemoNativeCanonicalFixture;
  const item = fixture.items[0]!;
  mutate(item);
  item.decisionHash = demoNativeFixtureItemHash(item);
  fixture.manifestHash = demoNativeFixtureManifestHash(fixture);
  return fixture;
}

describe("demo native canonical fixture contract", () => {
  it.each([
    ["non-string provider account reference", { providerAccountRefId: 7 }],
    [
      "null fixture item",
      { items: [null, ...committedFixture.items.slice(1)] },
    ],
    ["symbol computed timestamp", { computedAt: Symbol("invalid") }],
  ])("returns a fail-close result for %s instead of throwing", (_name, patch) => {
    const malformed = {
      ...committedFixture,
      ...patch,
    };

    expect(() => validate(malformed)).not.toThrow();
    expect(validate(malformed)).toMatchObject({ ok: false });
  });

  it("rejects an unknown decision state even when both hashes are recomputed", () => {
    const fixture = mutateAndRehash((item) => {
      item.decisionState = "unknown" as never;
    });

    expect(validate(fixture)).toEqual({
      ok: false,
      reason: "demo_fixture_item_invalid",
    });
  });

  it("rejects an unknown buyer action even when both hashes are recomputed", () => {
    const fixture = mutateAndRehash((item) => {
      item.buyerAction = "unknown" as never;
    });

    expect(validate(fixture)).toEqual({
      ok: false,
      reason: "demo_fixture_item_invalid",
    });
  });

  it("rejects a cross-field action/state mismatch even when both hashes are recomputed", () => {
    const fixture = mutateAndRehash((item) => {
      item.buyerAction = "cut";
    });

    expect(validate(fixture)).toEqual({
      ok: false,
      reason: "demo_fixture_item_invalid",
    });
  });

  it("rejects a demo execution action even when it is a valid production enum and both hashes are recomputed", () => {
    const fixture = mutateAndRehash((item) => {
      item.executionAction = "scale_budget";
    });

    expect(validate(fixture)).toEqual({
      ok: false,
      reason: "demo_fixture_item_invalid",
    });
  });
});
