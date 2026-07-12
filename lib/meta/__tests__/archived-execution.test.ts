import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("archived Meta execution compatibility", () => {
  it("keeps the retired mutation as a source-level fail-closed tombstone", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "lib/archive/v1-v2-v21/lib/meta-execution.ts",
      ),
      "utf8",
    );
    const mutation = source.slice(
      source.indexOf("export async function mutateMetaAdSetExecution"),
    );

    expect(mutation).toContain("Promise<never>");
    expect(mutation).toContain('error.code = "archived_execution_disabled"');
    expect(mutation).toContain("throw error");
    expect(mutation).not.toContain("fetch(");
  });
});
