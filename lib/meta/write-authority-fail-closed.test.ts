import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `ads-write.ts` skips assertProviderWriteAuthorityUnchanged entirely when the
 * write context carries no connection generation:
 *
 *   ctx.connectionGeneration ? await assertProviderWriteAuthorityUnchanged(...) : { ok: true }
 *
 * and states the rule directly above it: "A read failure is 503, never an
 * optional null: 'I could not tell' must not be indistinguishable from 'there is
 * no generation to check'."
 *
 * The caller that builds that context did `readProviderConnectionGenerationToken(...)
 * .catch(() => null)`, which turns any transient database error into "no
 * generation" and silently disables the reconnect guard on pause, resume and
 * duplicate — the exact case the comment forbids.
 */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/**
 * Comments stripped before scanning. The fix for this defect is documented in a
 * comment that necessarily QUOTES the offending pattern, so a scanner that reads
 * comments flags the explanation as the bug.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

describe("meta write authority fails closed", () => {
  it("does not swallow the generation read into null", () => {
    const source = readCode("lib/meta/ads-action-routes.ts");
    const call = source.match(
      /readProviderConnectionGenerationToken\([\s\S]{0,200}?\)[\s\S]{0,40}?;/,
    );
    expect(call, "expected to find the generation read").toBeTruthy();
    expect(
      call![0],
      "a failed generation read must propagate, not become a null that disables the check",
    ).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/);
  });

  it("keeps the rule it documents next to the check", () => {
    const source = read("lib/meta/ads-write.ts");
    expect(source).toMatch(/A read failure is 503, never an optional null/);
  });

  it("no meta write path turns the generation read into an optional null", () => {
    for (const file of [
      "lib/meta/ads-action-routes.ts",
      "lib/meta/entity-action-routes.ts",
    ]) {
      const source = readCode(file);
      const offenders = Array.from(
        source.matchAll(/readProviderConnectionGenerationToken[\s\S]{0,240}?\.catch\(\s*\(\s*\)\s*=>\s*null/g),
      );
      expect(offenders.map(() => file), `${file} nulls the generation read`).toEqual([]);
    }
  });
});
