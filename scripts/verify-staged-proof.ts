/**
 * Verify a compact staged proof artifact, and exit nonzero if it is not one.
 *
 * Separate from the checker on purpose. The checker decides whether the staged
 * contract holds; this decides whether the EVIDENCE of that decision is intact.
 * Conflating the two is how a run with a raised parser, an empty worker id and a
 * fallthrough command still reported success.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { verifyCompactStagedProof } from "@/lib/sync/staged-worker-predicate";

function argValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

function main() {
  const argv = process.argv.slice(2);
  const file = argValue(argv, "--summary");
  const expectBuildId = argValue(argv, "--expect-build-id");
  const minHeartbeatAfter = argValue(argv, "--min-heartbeat-after");
  const expectedBytesRaw = argValue(argv, "--expect-bytes");
  const expectedSha = argValue(argv, "--expect-sha256");
  if (!file || !expectBuildId || !minHeartbeatAfter) {
    throw new Error(
      "usage: verify-staged-proof.ts --summary <file> --expect-build-id <sha> --min-heartbeat-after <iso> [--expect-bytes <n>] [--expect-sha256 <hex>]",
    );
  }

  const raw = fs.readFileSync(file);
  const failures: string[] = [];
  if (expectedSha) {
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== expectedSha) {
      failures.push(`artifact digest ${actual} does not match the writer's ${expectedSha}`);
    }
  }

  // Strict parse. A truncated document raises here rather than yielding a
  // partial object, and the raise is a refusal, not a warning.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    failures.push(`the artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result =
    parsed == null
      ? { ok: false, failures: [] }
      : verifyCompactStagedProof({
          summary: parsed,
          expectBuildId,
          minHeartbeatAfter,
          observedBytes: raw.byteLength,
          expectedBytes: expectedBytesRaw == null ? undefined : Number(expectedBytesRaw),
        });

  const all = [...failures, ...result.failures];
  console.log(
    JSON.stringify(
      { verified: all.length === 0, bytes: raw.byteLength, failures: all },
      null,
      2,
    ),
  );
  process.exit(all.length === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
