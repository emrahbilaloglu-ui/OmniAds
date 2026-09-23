import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMetaDecisionReleaseSourceManifest,
  META_DECISION_RELEASE_MANIFEST_PATH,
  type MetaDecisionReleaseSourceManifest,
} from "@/lib/meta/decision-release-source-manifest";

describe("Meta decision release source identity", () => {
  it("pins every changed and new file's current bytes against the pre-repair base", () => {
    const root = process.cwd();
    const pinned = JSON.parse(
      readFileSync(join(root, META_DECISION_RELEASE_MANIFEST_PATH), "utf8"),
    ) as MetaDecisionReleaseSourceManifest;
    const actual = buildMetaDecisionReleaseSourceManifest(root);

    expect(pinned.entries.length).toBeGreaterThan(0);
    expect(pinned.entries.some((entry) => entry.path === META_DECISION_RELEASE_MANIFEST_PATH)).toBe(false);
    expect(pinned).toEqual(actual);
  });
});
