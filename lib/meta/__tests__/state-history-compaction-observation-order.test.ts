// PR #272 regression: compaction must follow the same observation-first
// chronology as historical as-of readers. A late-captured replay can otherwise
// turn observed-order X,Y,X,Z into captured-order Y,X,X,Z and make the second X
// look removable even though deleting it changes the historical winner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compact = (value: string) => value.replace(/\s+/g, " ").trim();

describe("state-history compaction uses canonical observation chronology", () => {
  it("sequences candidates, predecessors, and the protected head by observed_at first", () => {
    const source = compact(
      readFileSync("lib/meta/state-history-compaction.ts", "utf8"),
    );

    expect(source).toContain(
      "LAG(manifest_sig) OVER ( ORDER BY observed_at, captured_at, created_at, run_id )",
    );
    expect(source).toContain(
      "LAG(observed_at) OVER ( ORDER BY observed_at, captured_at, created_at, run_id )",
    );
    expect(source).toContain(
      "ROW_NUMBER() OVER ( ORDER BY observed_at DESC, captured_at DESC, created_at DESC, run_id DESC )",
    );
    expect(source).not.toContain("ORDER BY captured_at, run_id");
    expect(source).not.toContain("ORDER BY captured_at DESC, run_id DESC");
  });

  it("hashes complete-state transitions in the as-of reader's deterministic order", () => {
    const source = compact(
      readFileSync("lib/meta/state-history-compaction.ts", "utf8"),
    );

    expect(source).toContain(
      "PARTITION BY business_id, provider_account_id, entity_type, entity_id ORDER BY observed_at, captured_at, created_at, id",
    );
    expect(source).toContain(
      "'|' ORDER BY entity_id, observed_at, captured_at, created_at, id",
    );
    expect(source).not.toContain("ORDER BY captured_at, created_at, id");
    expect(source).not.toContain("'|' ORDER BY entity_id, captured_at");
  });

  it("revalidates observed-order head and the immediate retained predecessor", () => {
    const source = compact(
      readFileSync("lib/meta/state-history-compaction-executor.ts", "utf8"),
    );

    expect(source).toContain(
      "( newer.observed_at, newer.captured_at, newer.created_at, newer.id ) > (r.observed_at, r.captured_at, r.created_at, r.id)",
    );
    expect(source).toContain(
      "( predecessor.observed_at, predecessor.captured_at, predecessor.created_at, predecessor.id ) < (r.observed_at, r.captured_at, r.created_at, r.id)",
    );
    expect(source).toContain(
      "ORDER BY predecessor.observed_at DESC, predecessor.captured_at DESC, predecessor.created_at DESC, predecessor.id DESC LIMIT 1",
    );
    expect(source).toContain(
      "SELECT 1 FROM meta_entity_state_history predecessor_state WHERE predecessor_state.run_id = predecessor.id",
    );
    expect(source).not.toContain(
      "(newer.captured_at, newer.id) > (r.captured_at, r.id)",
    );
    expect(source).not.toContain(
      "(earlier.captured_at, earlier.id) < (r.captured_at, r.id)",
    );
  });
});
