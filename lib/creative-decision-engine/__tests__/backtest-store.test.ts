import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("backtest store SQL contracts", () => {
  it("defaults automation backtest summaries to the active engine version", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/backtest-store.ts",
      "utf8",
    );

    expect(source).toContain("input.engineVersion ?? ENGINE_VERSION");
    expect(source).toContain(
      "AND ($5::text IS NULL OR engine_version = $5)",
    );
    expect(source).toContain(
      "AND ($4::text IS NULL OR engine_version = $4)",
    );
    expect(source).toContain(
      "GROUP BY creative_id, as_of_date, engine_version, scope_type, scope_id",
    );
  });
});
