import { describe, expect, it } from "vitest";
import {
  classifyMetaSyncFailure,
  shouldDeadLetterMetaFailure,
} from "@/lib/sync/meta-error-classification";

describe("Meta sync error classification", () => {
  it("classifies Meta checkpoint/login failures as terminal account action", () => {
    const classified = classifyMetaSyncFailure({
      message:
        "You cannot access the app till you log in to www.facebook.com and follow the instructions given.",
    });

    expect(classified).toMatchObject({
      errorClass: "account_checkpoint",
      terminal: true,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
    });
    expect(
      shouldDeadLetterMetaFailure({
        errorClass: classified.errorClass,
        terminal: classified.terminal,
        attemptCount: 0,
        maxAttempts: 60,
      }),
    ).toBe(true);
  });

  it("keeps duplicate upsert and database timeout failures replayable", () => {
    for (const message of [
      "ON CONFLICT DO UPDATE command cannot affect row a second time",
      "Database query timed out after 30000ms",
    ]) {
      const classified = classifyMetaSyncFailure({ message });
      expect(classified.recoveryKind).toBe("replayable_transient");
      expect(classified.terminal).toBe(false);
      expect(
        shouldDeadLetterMetaFailure({
          errorClass: classified.errorClass,
          terminal: classified.terminal,
          attemptCount: 99,
          maxAttempts: 60,
        }),
      ).toBe(false);
    }
  });

  it("keeps lease checkpoint write conflicts retryable", () => {
    const classified = classifyMetaSyncFailure({
      message: "lease_conflict:checkpoint_write_rejected",
    });

    expect(classified).toMatchObject({
      errorClass: "lease_conflict",
      terminal: false,
      recoveryKind: "replayable_transient",
      actionRequired: false,
    });
    expect(
      shouldDeadLetterMetaFailure({
        errorClass: classified.errorClass,
        terminal: classified.terminal,
        attemptCount: 99,
        maxAttempts: 60,
      }),
    ).toBe(false);
  });
});
