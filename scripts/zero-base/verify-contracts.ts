/**
 * Fails when lib/zero-base/generated-contracts.ts is not what the vendored
 * contract currently generates. This is the gate that makes an unreviewed
 * vendored-tuple change break CI instead of drifting silently.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildGeneratedSource } from "./generate-contracts";

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "lib", "zero-base", "generated-contracts.ts");

const expected = buildGeneratedSource();
const actual = readFileSync(OUT, "utf8");

if (expected !== actual) {
  console.error(
    "generated-contracts.ts is stale.\n" +
      "The vendored design contract changed without regenerating.\n" +
      "Run: npm run zero-base:contracts:generate — then review the diff.",
  );
  process.exit(1);
}
console.log("generated-contracts.ts is current with the vendored contract.");
