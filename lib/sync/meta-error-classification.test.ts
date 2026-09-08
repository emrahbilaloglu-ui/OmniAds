import { describe, expect, it } from "vitest";
import {
  formatMetaFailureForStorage,
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

  it("keeps lease checkpoint write conflicts retryable even when the failure carries a Graph code", () => {
    // The first-party class is decided before the provider's code is read: a
    // lease race is ours, not Meta's, whatever else came back with it.
    const classified = classifyMetaSyncFailure({
      errorClass: "lease_conflict",
      errorCode: 17,
    });

    expect(classified.errorClass).toBe("lease_conflict");
    expect(classified.terminal).toBe(false);
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

/**
 * AREA S5 — the provider's own structured verdict decides.
 *
 * Every Graph rejection comes back with `error.code`, and since
 * `MetaGraphRequestError` (lib/api/meta.ts) that code survives the throw. Until
 * it did, the only thing this classifier ever saw was free text, so a provider
 * condition with an unambiguous code was diagnosed by substring — the same
 * mechanism that once read our own `meta_sync_checkpoints` table name as a
 * Facebook account checkpoint.
 *
 * The message chain is still here, and must stay: a Postgres error, a lease
 * race and a Meta failure re-read out of `meta_sync_partitions.last_error`
 * carry no code at all.
 */
describe("Meta failures are classified from the structured Graph code", () => {
  /** What lib/api/meta.ts attaches to everything it throws. */
  function graphError(
    message: string,
    identity: {
      errorCode?: number | null;
      errorSubcode?: number | null;
      isTransient?: boolean | null;
    },
  ) {
    return Object.assign(new Error(message), {
      name: "MetaGraphRequestError",
      errorCode: identity.errorCode ?? null,
      errorSubcode: identity.errorSubcode ?? null,
      isTransient: identity.isTransient ?? null,
    });
  }

  it("reads the code off the thrown error, not off its message", () => {
    // The message is what the sync path actually throws today, and it says
    // nothing a substring rule can use. Before the code travelled, this landed
    // on the unrecognised-message default.
    const classified = classifyMetaSyncFailure({
      error: graphError("meta_campaign_configs_incomplete:http_failure", {
        errorCode: 17,
      }),
    });

    expect(classified.errorClass).toBe("quota");
    expect(classified.terminal).toBe(false);
    expect(classified.retryDelayMinutes).toBe(10);
    expect(
      shouldDeadLetterMetaFailure({
        errorClass: classified.errorClass,
        terminal: classified.terminal,
        attemptCount: 99,
        maxAttempts: 6,
      }),
      "a throttle resolves itself and must never dead-letter",
    ).toBe(false);
  });

  it("does not let a misleading message override the code", () => {
    // Our own table is named meta_sync_checkpoints, and the message rule for a
    // Facebook checkpoint matches the bare substring. A throttle that happened
    // to mention it must still be a throttle.
    const classified = classifyMetaSyncFailure({
      errorCode: 4,
      message:
        'checkpoint write failed: relation "meta_sync_checkpoints" is unavailable',
    });

    expect(classified.errorClass).toBe("quota");
    expect(
      classified.actionRequired,
      "a throttle is not something the operator fixes on facebook.com",
    ).toBe(false);
  });

  it("separates a checkpointed account from an ordinary expired token by subcode", () => {
    const checkpointed = classifyMetaSyncFailure({
      errorCode: 190,
      errorSubcode: 459,
    });
    expect(checkpointed).toMatchObject({
      errorClass: "account_checkpoint",
      terminal: true,
      actionRequired: true,
      reasonCode: "meta_account_checkpoint",
    });

    // The over-correction guard: every other subcode under the same code is a
    // credential the operator reconnects, not a checkpoint to go clear.
    const expired = classifyMetaSyncFailure({
      errorCode: 190,
      errorSubcode: 463,
    });
    expect(expired).toMatchObject({
      errorClass: "invalid_token",
      terminal: true,
      reasonCode: "meta_invalid_token",
    });
  });

  it("classifies a permission refusal and an invalid parameter as terminal, and only one of them as actionable", () => {
    const permission = classifyMetaSyncFailure({ errorCode: 294 });
    expect(permission).toMatchObject({
      errorClass: "permission",
      terminal: true,
      actionRequired: true,
    });

    // Code 100 is a request this client built wrong. Retrying cannot fix it,
    // and there is nothing for the operator to do about it.
    const payload = classifyMetaSyncFailure({ errorCode: 100 });
    expect(payload).toMatchObject({
      errorClass: "payload",
      terminal: true,
      actionRequired: false,
    });
  });

  it("honours the provider's is_transient flag on a code it does not recognise", () => {
    const classified = classifyMetaSyncFailure({
      error: graphError("meta_pagination_incomplete:http_failure:unknown", {
        errorCode: 99999,
        isTransient: true,
      }),
    });

    expect(classified.terminal).toBe(false);
    expect(classified.recoveryKind).toBe("replayable_transient");
    expect(classified.reasonCode).toBe("meta_provider_transient_flag");
  });

  it("still falls back to the message when the failure carries no code at all", () => {
    // The compatibility half. A Postgres failure never had a Graph code, and a
    // dead-letter candidate rebuilt from a stored partition error has only its
    // text — removing this chain would silently reclassify both.
    const database = classifyMetaSyncFailure({
      message:
        'duplicate key value violates unique constraint "meta_sync_checkpoints_pkey"',
    });
    expect(database.errorClass).not.toBe("account_checkpoint");
    expect(database.actionRequired).toBe(false);

    const token = classifyMetaSyncFailure({
      message: "Error validating access token: Session has expired.",
    });
    expect(token.errorClass).toBe("invalid_token");
    expect(token.terminal).toBe(true);
  });
});

/*
  CODEX B15 — provider prose never reaches a log line or a durable column.

  `meta_sync_jobs.last_error` was written as `error.message`, and this module's
  own callers build Graph URLs with `access_token` in the query string. A
  failing request's message can carry that URL (undici's `fetch failed` carries
  its request in `cause`; a Graph 2xx error envelope echoes the request back),
  so a credential had a path into durable storage through an error field.
*/
describe("failures are summarized without provider text", () => {
  const TOKEN = "EAAG_super_secret_token_value";
  const bearingToken = [
    new Error(
      `request to https://graph.facebook.com/v21.0/act_1/insights?access_token=${TOKEN}&fields=spend failed`,
    ),
    {
      error: {
        message: `Invalid OAuth access token ${TOKEN}`,
        code: 190,
        error_subcode: 463,
        is_transient: false,
        fbtrace_id: "AbCd1234",
      },
    },
    // The 2xx envelope shape: a 200 response whose body is an error.
    {
      body: {
        error: {
          message: `(#17) User request limit reached for ${TOKEN}`,
          code: 17,
          is_transient: true,
          fbtrace_id: "Zz_9",
        },
      },
    },
  ];

  it.each(bearingToken.map((error, index) => [index, error] as const))(
    "case %i keeps the token out of the stored string",
    (_index, error) => {
      const stored = formatMetaFailureForStorage({ error });
      expect(stored).not.toContain(TOKEN);
      expect(stored).not.toContain("access_token");
      expect(stored).not.toContain("graph.facebook.com");
      // And it is not empty: a redaction that says nothing is not a summary.
      expect(stored).toMatch(/class=\S+ reason=\S+ terminal=(true|false)/);
    },
  );

  it("keeps the structured identifiers, which are not prose", () => {
    const stored = formatMetaFailureForStorage({
      error: {
        error: {
          message: `boom ${TOKEN}`,
          code: 190,
          error_subcode: 463,
          is_transient: false,
          fbtrace_id: "AbCd1234",
        },
      },
    });
    expect(stored).toContain("code=190");
    expect(stored).toContain("subcode=463");
    expect(stored).toContain("transient=false");
    expect(stored).toContain("fbtrace=AbCd1234");
  });

  it("refuses an fbtrace_id that is prose rather than an identifier", () => {
    // The one provider-supplied string that survives is bounded and
    // character-checked, so a sentence cannot be smuggled through it.
    const stored = formatMetaFailureForStorage({
      error: {
        error: {
          code: 1,
          fbtrace_id: `not an id ${TOKEN}`,
        },
      },
    });
    expect(stored).not.toContain("fbtrace=");
    expect(stored).not.toContain(TOKEN);
  });

  it("summarizes an unknown error shape without echoing it", () => {
    const stored = formatMetaFailureForStorage({
      error: new Error(`totally unexpected ${TOKEN}`),
    });
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain("totally unexpected");
  });
});
