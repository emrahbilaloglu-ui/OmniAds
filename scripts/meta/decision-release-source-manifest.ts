/** Run last, after every candidate file is final: `node --import tsx …`. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMetaDecisionReleaseSourceManifest,
  META_DECISION_RELEASE_MANIFEST_PATH,
} from "@/lib/meta/decision-release-source-manifest";

const root = process.cwd();
const manifest = buildMetaDecisionReleaseSourceManifest(root);
writeFileSync(
  join(root, META_DECISION_RELEASE_MANIFEST_PATH),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    manifestPath: META_DECISION_RELEASE_MANIFEST_PATH,
    manifestHash: manifest.manifestHash,
    pinnedNonSelfFileCount: manifest.entries.length,
  }),
);
