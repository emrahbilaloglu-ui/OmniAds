/**
 * WP-26 step 4 / gate G10 — prepare a fresh artifact set.
 *
 * The helpers live in `lib/zero-base/visual-manifest.ts` so the Playwright spec
 * can import them: Playwright applies a CommonJS transform to anything a spec
 * pulls in, and `import.meta.url` in this file would break that.
 */
import path from "node:path";

import {
  artifactSetPath,
  currentCommit,
  prepareArtifactDir,
} from "@/lib/zero-base/visual-manifest";

const wp = process.env.ZERO_BASE_ARTIFACT_SET?.trim();
if (!wp) {
  console.error(
    "ZERO_BASE_ARTIFACT_SET is required and must be a new, recorded value (for example wp-26-<commit>).",
  );
  process.exit(1);
}

const commit = currentCommit();
const relative = artifactSetPath(commit, wp);
const absolute = path.join(process.cwd(), "playwright", "artifacts", relative);

console.log("zero-base visual regression (WP-26 step 4 / G10)\n");
console.log(`  commit        ${commit}`);
console.log(`  artifact set  ${relative}`);

try {
  prepareArtifactDir(absolute);
} catch (error) {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
}
console.log(`  prepared      ${absolute}`);
console.log(
  "\nCapture runs in playwright/tests/zero-base-visual.spec.ts, which writes frames here\n" +
    "and emits manifest.json keyed by LeafId + state + width + theme.",
);
