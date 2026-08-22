import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  META_FAILURES,
  META_FAILURE_CODES,
  META_MUTATION_STATES,
  META_READ_STATES,
  isMetaFailureCode,
  metaFailureMessage,
  metaFailureState,
} from "@/lib/meta/read-state-contract";

describe("the read/mutation state grammar", () => {
  it("carries §9's seven read states and no others", () => {
    expect([...META_READ_STATES]).toEqual([
      "loading",
      "refreshing-with-stale",
      "success",
      "empty-proven",
      "partial",
      "degraded",
      "refused",
    ]);
  });

  it("carries §9's nine mutation states", () => {
    expect(META_MUTATION_STATES).toHaveLength(9);
    for (const required of [
      "validating",
      "awaiting-confirmation",
      "executing",
      "provider-response-received",
      "readback-pending",
      "verified",
      "refused",
      "failed-definite",
      "ambiguous-reconciliation-required",
    ]) {
      expect(META_MUTATION_STATES).toContain(required);
    }
  });

  it("keeps empty-proven and degraded as separate states", () => {
    /**
     * The distinction D8 exists for. Both render no rows: one means "there is
     * nothing here", the other means "we do not know what is here", and the
     * operator's next action is completely different.
     */
    expect(META_READ_STATES).toContain("empty-proven");
    expect(META_READ_STATES).toContain("degraded");
    expect(new Set(META_READ_STATES).size).toBe(META_READ_STATES.length);
  });
});

describe("the failure-code dictionary", () => {
  it("covers every code §9.1 names", () => {
    for (const required of [
      "provider_account_not_assigned",
      "provider_account_scope_unverified",
      "account_required",
      "reviewer_read_only",
      "demo_business_read_only",
      "supervision_state_unavailable",
      "kill_switch_engaged",
      "kill_switch_release_preflight_failed",
      "schema_not_ready",
      "capability_read_denied",
      "execution_limit_exceeded",
      "bulk_cap_exceeded",
      "invalid_payload",
      "expectedVersion_conflict",
      "handoff_refused",
      "source_read_failed",
      "provider_rate_limited",
      "provider_auth_expired",
      "provider_outcome_ambiguous",
      "reconciliation_required",
    ]) {
      expect(META_FAILURE_CODES).toContain(required);
    }
  });

  it("gives every code a message, so adding one without a sentence fails the build", () => {
    // The plan's rule: "yeni failure code eklenen PR aynı kodun kullanıcı
    // mesajını ve testini de içermelidir."
    for (const code of META_FAILURE_CODES) {
      const descriptor = META_FAILURES[code];
      expect(descriptor, code).toBeDefined();
      expect(descriptor.message.length, code).toBeGreaterThan(30);
      // A sentence, not a status word or a restated code.
      expect(descriptor.message, code).not.toContain(code);
      expect(descriptor.message.trim().endsWith("."), code).toBe(true);
    }
  });

  it("never presents a failure as an absence of data", () => {
    /**
     * D8, enforced on the copy itself. A message that says "no data" or "empty"
     * for a code that means a read FAILED is the exact sentence that turns a
     * broken source into a data fact on someone's screen.
     */
    const failedReads = META_FAILURE_CODES.filter(
      (code) => META_FAILURES[code].state !== "refused",
    );
    for (const code of failedReads) {
      const message = META_FAILURES[code].message.toLowerCase();
      expect(message, code).not.toMatch(/\bno data\b/);
      expect(message, code).not.toMatch(/\bis empty\b/);
      expect(message, code).not.toMatch(/\bnothing to show\b/);
    }
  });

  it("puts each code into exactly one surface state", () => {
    for (const code of META_FAILURE_CODES) {
      expect(["degraded", "refused", "partial"], code).toContain(
        metaFailureState(code),
      );
    }
  });

  it("returns null for a code it has never heard of", () => {
    // Not a generic sentence: inventing a reassuring default is how an unknown
    // failure becomes a known-looking one.
    for (const unknown of ["", "boom", "PROVIDER_ACCOUNT_NOT_ASSIGNED", null, 7]) {
      expect(metaFailureMessage(unknown), String(unknown)).toBeNull();
      expect(isMetaFailureCode(unknown)).toBe(false);
    }
  });

  it("resolves every known code", () => {
    for (const code of META_FAILURE_CODES) {
      expect(metaFailureMessage(code)).toBe(META_FAILURES[code].message);
    }
  });
});

describe("the dictionary and the routes agree where they overlap", () => {
  /**
   * What this does and does not claim.
   *
   * The Meta and Launchpad API surface emits **110 distinct** `code: "..."`
   * values today. §9.1 names twenty as a floor ("En az"), not as the complete
   * set, and most of the other ninety are narrow blocker or lineage codes that
   * never reach an operator as a surface state. Asserting that all 110 must be
   * contracted would be asserting a rewrite nobody has agreed to, and would say
   * more about this test's ambition than about the product.
   *
   * So the invariant is the one that actually protects the operator: **where a
   * §9.1 code IS emitted, the surface must be able to speak for it.** A route
   * returning a contracted code with no dictionary entry would render raw or
   * render nothing, which is precisely what the dictionary exists to stop.
   *
   * The uncontracted count is asserted with a ceiling rather than ignored, so
   * the number is visible and growth is a conversation instead of a drift.
   */
  function emittedCodes(): string[] {
    const raw = execSync(
      `git grep -h -o -E 'code: "[a-z_]+"' -- 'app/api/meta/**' 'app/api/launchpad/**' || true`,
      { encoding: "utf8" },
    );
    return [
      ...new Set(
        raw
          .split("\n")
          .map((line) => line.match(/code: "([a-z_]+)"/)?.[1])
          .filter((value): value is string => Boolean(value)),
      ),
    ];
  }

  it("can speak for every contracted code that a route emits", () => {
    const emitted = emittedCodes();
    expect(emitted.length).toBeGreaterThan(0);

    const contractedAndEmitted = emitted.filter(isMetaFailureCode);
    expect(contractedAndEmitted.length).toBeGreaterThan(0);
    for (const code of contractedAndEmitted) {
      expect(metaFailureMessage(code), code).toBeTruthy();
    }
  });

  it("holds the uncontracted surface below its recorded ceiling", () => {
    /**
     * 110 distinct codes emitted, 8 of them contracted by §9.1 — so 102 are
     * not. This ceiling is a **ratchet**,
     * not a target: it fails when the uncontracted set grows, which forces the
     * question "does this new code need an operator sentence?" at the moment
     * someone adds it rather than when an operator meets it.
     *
     * Lower it whenever a batch is contracted. Never raise it without a reason
     * written into the same commit.
     */
    const uncontracted = emittedCodes().filter((code) => !isMetaFailureCode(code));
    expect(uncontracted.length).toBeLessThanOrEqual(102);
  });
});
